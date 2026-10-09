'use strict';

// WF02 Research & Qualify: pure logic (docs/02-mvp-architecture.md §5, §6).
//
// Embedded after src/lib/common.js and src/lib/gemini.js into the Code nodes of
// workflows/WF02-research-qualify.json. IMPORTS and the EXPORT tail are stripped.
//
// Pipeline per lead: fetch homepage → fetch ≤2 internal pages (contact, about/team)
// → company-registry check routed by the lead's country (src/lib/registries.js)
// → Gemini scoring of the website → deterministic caps and hard gates → one
// Leads update. Website evidence (Leads.evidence) and legal registration
// (Leads.registry_*) are kept separate. Any step that can't complete leaves the
// lead in a state a human can see; nothing is qualified on unverified data.

// ---- IMPORTS (stripped when embedded in n8n) ----
const {
  FREE_MAIL_DOMAINS, STAGE, text, parseHost, registrableDomain, normaliseEmail, emailDomain,
  parseSettings, resolveActiveNiche, buildSuppressionIndex, suppressionReason, realRows, clip,
  formatEvidence, parseIntSetting,
} = require('./lib/common');
const { geminiUrl, geminiBody, parseGeminiJson } = require('./lib/gemini');
const {
  REGISTRY_STATUS, REGISTRY_COLUMNS, normaliseUkCompanyNumber, planRegistryLookup, evaluateRegistry,
  isRegistryVerified, registryRequired, registryColumns,
} = require('./lib/registries');
// ---- END IMPORTS ----

const MAX_PAGE_CHARS = 6000;
const WEIGHTS = { fit: 30, problem: 30, contact: 20, channel: 20 };

// Mailbox names that indicate a shared role address rather than a person.
const ROLE_LOCAL_PARTS = new Set([
  'info', 'hello', 'hi', 'enquiries', 'enquiry', 'inquiries', 'sales', 'lettings', 'letting', 'rentals',
  'office', 'admin', 'contact', 'mail', 'reception', 'team', 'property', 'properties', 'homes',
  'valuations', 'valuation', 'accounts', 'support', 'help', 'general', 'post', 'lets', 'management',
  'pm', 'propertymanagement', 'maintenance', 'branch', 'newbusiness', 'marketing',
]);

// Columns WF02 owns in Leads (plus lead_id as the match key). Every update
// carries all of them so unchanged values are written back, never blanked.
const WF02_COLUMNS = [
  'lead_id', 'company_number', 'company_status', 'legal_entity_type', 'stage', 'fit_score',
  'problem_score', 'contact_score', 'channel_score', 'total_score', 'qualification_reasoning',
  'evidence', 'opportunity_hypothesis', 'disqualify_reason', 'contact_name', 'contact_role',
  'last_updated', 'last_error', ...REGISTRY_COLUMNS,
];

const NO_SOLICITATION_PATTERNS = [
  /\b(?:no|not accept(?:ing)?|do not (?:accept|want|send)|don't (?:accept|want|send))\b[^.\n]{0,40}\b(?:unsolicited|cold|sales|marketing)\b[^.\n]{0,30}\b(?:calls?|e-?mails?|contact|approaches|enquiries|solicitations?)\b/i,
  /\bunsolicited (?:sales |marketing )?(?:e-?mails?|calls?|approaches)\b[^.\n]{0,40}\b(?:not|won't|will not)\b/i,
];

function researchUpdate(lead, changes, now) {
  const out = {};
  for (const c of WF02_COLUMNS) out[c] = lead[c] === undefined || lead[c] === null ? '' : lead[c];
  return { ...out, ...changes, lead_id: text(lead.lead_id), last_updated: now };
}

function websiteUrl(raw) {
  const value = text(raw);
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// ---------- step 1: choose the batch ----------

// Google Sheets silently ignores updates to columns a tab doesn't have, so WF02
// reads the Leads header row and refuses to run until every column it writes exists.
function assertLeadsHeader(leadsHeaderRows) {
  const header = realRows(leadsHeaderRows).find((r) => text(r.lead_id) === 'lead_id');
  if (!header) throw new Error('Could not read the Leads header row; research aborted.');
  const present = new Set(Object.values(header).map((v) => text(v)));
  const missing = WF02_COLUMNS.filter((c) => !present.has(c));
  if (missing.length) {
    throw new Error(`The Leads tab is missing columns: ${missing.join(', ')}. Add them at the end of the header row (docs/09 §2), then re-run. Research aborted.`);
  }
}

function selectResearchBatch({ settingsRows, nichesRows, leadsRows, suppressionRows, leadsHeaderRows, now }) {
  const timestamp = text(now) || new Date().toISOString();
  assertLeadsHeader(leadsHeaderRows);
  const settings = parseSettings(realRows(settingsRows));
  const niche = resolveActiveNiche(settings, realRows(nichesRows), 'research');
  const batchSize = parseIntSetting(settings.RESEARCH_BATCH_SIZE, 1, 25);
  if (Number.isNaN(batchSize)) throw new Error('Settings.RESEARCH_BATCH_SIZE must be a whole number from 1 to 25; research aborted.');
  const minScore = parseIntSetting(settings.MIN_QUALIFY_SCORE, 0, 100);
  if (Number.isNaN(minScore)) throw new Error('Settings.MIN_QUALIFY_SCORE must be a whole number from 0 to 100; research aborted.');

  const sup = buildSuppressionIndex(realRows(suppressionRows));
  const candidates = realRows(leadsRows)
    .filter((l) => text(l.stage) === STAGE.NEW && text(l.niche_id) === niche.niche_id && text(l.lead_id))
    // Leads that failed before go to the back of the queue so one bad site can't block the batch.
    .sort((a, b) => (text(a.last_error) ? 1 : 0) - (text(b.last_error) ? 1 : 0) || Number(a.row_number || 0) - Number(b.row_number || 0));

  const immediateUpdates = [];
  const researchItems = [];
  for (const lead of candidates) {
    const reason = suppressionReason(sup, lead.contact_email, lead.lead_id);
    if (reason) {
      immediateUpdates.push(researchUpdate(lead, { stage: STAGE.DISQUALIFIED, disqualify_reason: `Suppressed: ${reason}`, last_error: '' }, timestamp));
      continue;
    }
    if (researchItems.length >= batchSize) continue;
    const url = websiteUrl(lead.website);
    researchItems.push({
      lead_id: text(lead.lead_id),
      request_url: parseHost(url, { requireScheme: true }) ? url : '',
      website_url: url,
      // Registry routing uses the lead's own country; the niche's is the fallback.
      country: text(lead.country) || niche.country,
      niche: niche.row,
      min_score: minScore,
      lead,
    });
  }
  return { researchItems, immediateUpdates, activeNiche: niche.niche_id, summary: { queued: researchItems.length, suppressed: immediateUpdates.length, waiting: candidates.length - researchItems.length - immediateUpdates.length } };
}

// ---------- step 2: HTML handling ----------

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '–', mdash: '—', pound: '£', hellip: '…', copy: '©' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|address|td|dd|dt)\s*>/gi, '\n');
  s = decodeEntities(s.replace(/<[^>]+>/g, ' '));
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Cloudflare "email protection" hides addresses as hex XOR-encoded strings.
function decodeCfEmail(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function emailsInHtml(html) {
  const found = new Set();
  const s = String(html || '');
  for (const m of s.matchAll(/mailto:([^"'?\s>]+)/gi)) found.add(normaliseEmail(decodeEntities(m[1])));
  for (const m of s.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const e = normaliseEmail(decodeCfEmail(m[1]));
    if (e) found.add(e);
  }
  for (const m of htmlToText(s).matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(normaliseEmail(m[0]));
  return [...found].filter((e) => e.includes('@'));
}

function resolveLink(href, base) {
  const h = decodeEntities(text(href));
  if (!h || /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(h) || h.startsWith('#')) return '';
  const origin = /^(https?:\/\/[^/?#]+)/i.exec(base);
  if (!origin) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `https:${h}`;
  if (h.startsWith('/')) return origin[1] + h;
  return `${origin[1]}/${h.replace(/^\.\//, '')}`;
}

// Picks at most two internal pages: the best "contact" page and the best
// "about/team" page (architecture §6: homepage plus at most 2 pages).
function planPagesForLead(item, html) {
  const base = item.website_url;
  const leadDomain = text(item.lead_id).toLowerCase();
  const home = base.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const picks = { contact: '', about: '' };
  for (const m of String(html || '').matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = resolveLink(m[1], base).replace(/#.*$/, '');
    if (!url || registrableDomain(parseHost(url)) !== leadDomain) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|docx?|xlsx?|zip|mp4)(\?|$)/i.test(url)) continue;
    if (url.replace(/\/+$/, '') === home) continue;
    const label = `${url} ${htmlToText(m[2])}`.toLowerCase();
    if (!picks.contact && /contact|get-in-touch|get in touch|enquir|find-us|find us/.test(label)) picks.contact = url;
    else if (!picks.about && /about|team|people|meet|our-story|our story|who-we-are|who we are/.test(label)) picks.about = url;
  }
  return [picks.contact, picks.about].filter(Boolean).map((url) => ({ lead_id: item.lead_id, request_url: url }));
}

function responseHtml(response) {
  const r = response || {};
  if (r.error) return { html: '', error: text(r.error.message || r.error) || 'request failed' };
  const data = typeof r.data === 'string' ? r.data : '';
  return data ? { html: data, error: '' } : { html: '', error: 'empty response' };
}

function findNoSolicitation(pages) {
  for (const p of pages) {
    for (const pattern of NO_SOLICITATION_PATTERNS) {
      const m = pattern.exec(p.text);
      if (m) {
        const start = Math.max(0, p.text.lastIndexOf('\n', m.index) + 1);
        const endNl = p.text.indexOf('\n', m.index + m[0].length);
        return { quote: clip(p.text.slice(start, endNl === -1 ? undefined : endNl), 240), url: p.url };
      }
    }
  }
  return null;
}

// Combines fetched pages into the research record and plans the registry lookup.
// The registry lookup doesn't depend on the website fetch succeeding.
function assembleResearch(item, homeResponse, pageResponses) {
  const home = responseHtml(homeResponse);
  const pages = [];
  const emails = new Set();
  if (home.html) {
    pages.push({ url: item.website_url, text: clip(htmlToText(home.html), MAX_PAGE_CHARS) });
    emailsInHtml(home.html).forEach((e) => emails.add(e));
  }
  for (const pr of pageResponses || []) {
    const r = responseHtml(pr.response);
    if (!r.html) continue;
    pages.push({ url: pr.url, text: clip(htmlToText(r.html), MAX_PAGE_CHARS) });
    emailsInHtml(r.html).forEach((e) => emails.add(e));
  }
  const fetchError = !item.request_url ? 'website is not a valid http(s) address' : home.html ? '' : `Website fetch failed: ${clip(home.error, 200)}`;
  const allText = pages.map((p) => p.text).join('\n');

  // A company number entered by a human wins over one found on the website.
  let companyNumber = text(item.lead.company_number);
  let numberSource = companyNumber ? 'entered in the Leads sheet' : '';
  if (!companyNumber) {
    const m = /(?:company|registration|registered|reg\.?)\s*(?:no\.?|number|num\.?|#)\s*[:.]?\s*((?:SC|NI|OC|SO|NC|R0)?\s?\d{6,8})\b/i.exec(allText);
    if (m) {
      companyNumber = m[1];
      numberSource = "found on the business's own website";
    }
  }
  const registryPlan = planRegistryLookup({ lead: item.lead, country: item.country, companyNumber, numberSource });

  return {
    ...item,
    pages,
    emails_found: [...emails],
    fetch_error: fetchError,
    company_number_hint: normaliseUkCompanyNumber(companyNumber) || text(companyNumber),
    no_solicitation: fetchError ? null : findNoSolicitation(pages),
    registry_plan: registryPlan,
    // Only the Companies House adapter has a live HTTP node; other countries leave this empty.
    ch_request_url: registryPlan.provider === 'companies_house' ? registryPlan.request_url : '',
  };
}

// ---------- step 3: AI request (website evidence only) ----------

function researchPrompt(assembled) {
  const n = assembled.niche || {};
  const pages = assembled.pages.map((p) => `=== PAGE URL: ${p.url} ===\n${p.text}`).join('\n\n');
  return [
    'You help FlowHQ, a small automation agency, decide whether a business is worth contacting.',
    'Use ONLY the page text provided below. Never use outside knowledge, never guess, never invent facts.',
    '',
    `Business: ${text(assembled.lead.company_name)} (${assembled.website_url})`,
    `Target niche: ${text(n.target_description)}`,
    `Pain signals to look for: ${text(n.pain_signals)}`,
    `Exclusions: ${text(n.exclusions)}`,
    `Decision-maker roles: ${text(n.decision_maker_roles)}`,
    `FlowHQ service: ${text(n.service_angle)}`,
    '',
    'Score each dimension with an integer 0-3:',
    'fit_score: 0 not in niche; 1 in niche but outside the size/type range; 2 in niche, size unclear; 3 in niche, independent, 1-3 branches.',
    'problem_score: 0 no signal found; 1 general inference only; 2 one public pain signal with an exact quote; 3 two or more signals with exact quotes.',
    'contact_score: 0 no contact; 1 generic inbox only; 2 a named person with a role on a team page; 3 a named decision-maker with a published email.',
    '',
    'Return ONLY this JSON object:',
    '{"fit_score":0,"problem_score":0,"contact_score":0,',
    '"qualification_reasoning":"2-4 factual sentences",',
    '"evidence":[{"quote":"text copied character-for-character from one page","url":"that PAGE URL","signal":"which pain signal it shows"}],',
    '"opportunity_hypothesis":"one sentence: the single FlowHQ automation most likely to help, phrased as a possibility",',
    '"decision_maker":{"name":"","role":"","quote":"","url":""},',
    '"exclusions_found":[{"exclusion":"","quote":"","url":""}],',
    '"no_solicitation_notice":{"found":false,"quote":"","url":""}}',
    'Quotes must be copied exactly (under 200 characters each). Leave a field empty rather than guessing. Use [] when nothing applies.',
    '',
    pages,
  ].join('\n');
}

function buildAiRequest(assembled, registry, model) {
  if (assembled.fetch_error) return { request_url: '', skip_reason: assembled.fetch_error };
  if (assembled.no_solicitation) return { request_url: '', skip_reason: 'no-solicitation notice found' };
  if (registry.registry_status === REGISTRY_STATUS.INELIGIBLE) return { request_url: '', skip_reason: registry.registry_match_rationale };
  if (registryRequired(assembled.niche) && !isRegistryVerified(registry)) return { request_url: '', skip_reason: `registration ${registry.registry_status}` };
  return { request_url: geminiUrl(model), ai_body: geminiBody(researchPrompt(assembled)) };
}

// ---------- step 4: scoring and gates ----------

function matchable(s) {
  return text(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

function samePage(a, b) {
  return text(a).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase() === text(b).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
}

// A quote counts only if it appears verbatim on the page it cites.
function verifyQuote(pages, quote, url) {
  const q = matchable(quote);
  if (q.length < 10) return false;
  const page = pages.find((p) => samePage(p.url, url));
  return Boolean(page) && matchable(page.text).includes(q);
}

function clampScore(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
}

function isRoleEmail(email) {
  const local = normaliseEmail(email).split('@')[0] || '';
  return ROLE_LOCAL_PARTS.has(local.replace(/[^a-z]/g, '')) || /\d/.test(local);
}

function channelScore(lead) {
  const email = normaliseEmail(lead.contact_email);
  if (!email) return 0;
  const d = registrableDomain(emailDomain(email));
  if (FREE_MAIL_DOMAINS.has(d) || isRoleEmail(email)) return 2;
  return d === text(lead.lead_id).toLowerCase() ? 3 : 2;
}

function scoreAndGate({ assembled, registry, aiResponse, now }) {
  const lead = assembled.lead;
  const timestamp = text(now) || new Date().toISOString();
  // The registry result is recorded on every path; it never touches Leads.evidence.
  const reg = registryColumns(registry, lead);
  const required = registryRequired(assembled.niche);

  if (assembled.fetch_error) {
    // The website wasn't analysed: keep the stage so the lead is retried, and say why.
    return researchUpdate(lead, { ...reg, last_error: clip(assembled.fetch_error, 300) }, timestamp);
  }
  if (assembled.no_solicitation) {
    const ns = assembled.no_solicitation;
    return researchUpdate(lead, { ...reg, stage: STAGE.DISQUALIFIED, disqualify_reason: clip(`No-solicitation notice: "${ns.quote}" (${ns.url})`, 500), last_error: '' }, timestamp);
  }
  if (registry.registry_status === REGISTRY_STATUS.INELIGIBLE) {
    return researchUpdate(lead, { ...reg, stage: STAGE.DISQUALIFIED, disqualify_reason: clip(`Registry (${registry.registry_provider}): ${registry.registry_match_rationale}`, 500), last_error: '' }, timestamp);
  }
  if (required && !isRegistryVerified(registry)) {
    return researchUpdate(lead, {
      ...reg,
      stage: STAGE.RESEARCHED,
      qualification_reasoning: clip(`Needs manual registry check (niche requires "${text(assembled.niche.legal_entity_required)}"; registry_status ${registry.registry_status}). See registry_match_rationale. Verify with the official registry, then either enter company_number (GB) or set registry_status = MANUAL_VERIFIED with registry_source_url and registry_match_rationale, and set stage back to "New Lead".`, 1000),
      last_error: clip(`Registration ${registry.registry_status}: ${registry.registry_match_rationale}`, 300),
    }, timestamp);
  }

  const ai = parseGeminiJson(aiResponse);
  if (!ai.ok) return researchUpdate(lead, { ...reg, last_error: clip(ai.error, 300) }, timestamp);
  const v = ai.value;
  const fit = clampScore(v.fit_score);
  const problemAi = clampScore(v.problem_score);
  const contactAi = clampScore(v.contact_score);
  if (fit === null || problemAi === null || contactAi === null) {
    return researchUpdate(lead, { ...reg, last_error: 'AI response invalid: scores must be integers 0-3' }, timestamp);
  }

  const pages = assembled.pages;
  const evidence = (Array.isArray(v.evidence) ? v.evidence : [])
    .filter((e) => e && verifyQuote(pages, e.quote, e.url))
    .slice(0, 5)
    .map((e) => ({ quote: clip(e.quote, 200), url: text(e.url), signal: clip(e.signal, 60) }));
  const droppedEvidence = (Array.isArray(v.evidence) ? v.evidence.length : 0) - evidence.length;

  // Architecture §5: problem evidence above 1 needs quotes + URLs.
  const problemCap = evidence.length === 0 ? 1 : evidence.length === 1 ? 2 : 3;
  const problem = Math.min(problemAi, problemCap);

  let contactName = text(lead.contact_name);
  let contactRole = text(lead.contact_role);
  const dm = v.decision_maker || {};
  if (!contactName && text(dm.name) && verifyQuote(pages, dm.quote, dm.url) && matchable(dm.quote).includes(matchable(dm.name))) {
    contactName = clip(dm.name, 80);
    contactRole = clip(dm.role, 80);
  }
  const channel = channelScore(lead);
  const contactCap = channel === 0 ? 0 : !contactName ? 1 : isRoleEmail(lead.contact_email) ? 2 : 3;
  const contact = Math.min(contactAi, contactCap);

  const total = Math.round((fit / 3) * WEIGHTS.fit + (problem / 3) * WEIGHTS.problem + (contact / 3) * WEIGHTS.contact + (channel / 3) * WEIGHTS.channel);
  const overrideRaw = text(lead.score_override);
  const override = /^\d{1,3}$/.test(overrideRaw) && Number(overrideRaw) <= 100 ? Number(overrideRaw) : null;
  const effective = override === null ? total : override;

  const gates = [];
  if (channel === 0) gates.push('no published email (channel score 0)');
  const ns = v.no_solicitation_notice || {};
  if (ns.found === true && verifyQuote(pages, ns.quote, ns.url)) gates.push(`no-solicitation notice: "${clip(ns.quote, 160)}"`);
  for (const ex of Array.isArray(v.exclusions_found) ? v.exclusions_found : []) {
    if (ex && text(ex.exclusion) && verifyQuote(pages, ex.quote, ex.url)) gates.push(`exclusion "${clip(ex.exclusion, 60)}": "${clip(ex.quote, 160)}"`);
  }

  const notes = [];
  if (!isRegistryVerified(registry)) notes.push(`registration ${registry.registry_status} (not required for this niche)`);
  if (droppedEvidence > 0) notes.push(`${droppedEvidence} AI quote(s) discarded because they were not found verbatim on the cited page`);
  if (override !== null) notes.push(`score_override ${override} used instead of computed ${total}`);
  const reasoning = clip([text(v.qualification_reasoning), ...notes].filter(Boolean).join(' | '), 1500);

  let stage = STAGE.QUALIFIED;
  let disqualify = '';
  if (gates.length) {
    stage = STAGE.DISQUALIFIED;
    disqualify = clip(`Hard gate: ${gates.join('; ')}`, 500);
  } else if (effective < assembled.min_score) {
    stage = STAGE.DISQUALIFIED;
    disqualify = `Score ${effective} is below MIN_QUALIFY_SCORE ${assembled.min_score}`;
  }

  return researchUpdate(lead, {
    ...reg,
    stage,
    fit_score: fit,
    problem_score: problem,
    contact_score: contact,
    channel_score: channel,
    total_score: total,
    qualification_reasoning: reasoning,
    evidence: formatEvidence(evidence),
    opportunity_hypothesis: clip(v.opportunity_hypothesis, 300),
    disqualify_reason: disqualify,
    contact_name: contactName,
    contact_role: contactRole,
    last_error: '',
  }, timestamp);
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = {
  WF02_COLUMNS,
  assertLeadsHeader,
  selectResearchBatch,
  htmlToText,
  emailsInHtml,
  decodeCfEmail,
  planPagesForLead,
  assembleResearch,
  buildAiRequest,
  researchPrompt,
  verifyQuote,
  channelScore,
  isRoleEmail,
  scoreAndGate,
};
