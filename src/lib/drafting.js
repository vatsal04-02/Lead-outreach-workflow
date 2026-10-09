'use strict';

// Email templates and draft checks, shared by WF03 (drafting) and WF04 (which
// re-checks every draft at send time, because a human may have edited it).
//
// Honesty rules enforced here come from docs/01-strategy-icp-offer.md §4 and §7
// and docs/03-compliance-guardrails.md §2 (rule 4: sender identity, legal name,
// postal address, reason for contact, opt-out and privacy notice in every email).

// ---- IMPORTS (stripped when embedded in n8n) ----
const { text, parseHost, clip, parseEvidence } = require('./common');
// ---- END IMPORTS ----

const REQUIRED_SENDER_SETTINGS = ['SENDER_NAME', 'BUSINESS_LEGAL_NAME', 'BUSINESS_POSTAL_ADDRESS', 'WEBSITE_URL', 'PRIVACY_URL'];
const MAX_BODY_WORDS = 120;
const MIN_BODY_WORDS = 25;
const MAX_OBSERVATION_WORDS = 45;
const MAX_SUBJECT_CHARS = 70;

// Phrases that imply results, experience or guarantees FlowHQ cannot evidence,
// plus "instant" claims the polling-based offer can't honour (docs/06 §3).
const BANNED_PHRASES = [
  'case study', 'case studies', 'our clients', 'clients like', 'client results', 'testimonial',
  'we have helped', "we've helped", 'trusted by', 'guarantee', 'guaranteed', 'proven', 'award-winning',
  'industry-leading', 'market-leading', 'double your', 'triple your', '10x', 'increase your revenue',
  'boost your revenue', 'skyrocket', 'risk-free', 'no-brainer', 'act now', 'limited time',
  'instant', 'instantly', '24/7', 'never miss a lead', 'ai-powered magic',
];

// Templates are versioned; a draft records the template_id it was built from.
// Static text here is FlowHQ-approved wording, not AI output.
const TEMPLATES = {
  'uk-estate-letting-v1': {
    subject: (ctx) => `Enquiry follow-up at ${ctx.agency}`,
    fallbackObservation: (ctx) => (ctx.evidence[0]
      ? `I was looking at ${ctx.agency}'s website and noticed this: "${clip(ctx.evidence[0].quote, 160)}"`
      : ''),
    service: 'FlowHQ builds small automations for estate and letting agents. For example, every portal or website enquiry can get a personalised acknowledgement from your own inbox within minutes, be logged, and be passed to the right negotiator, with a nudge if nobody has picked it up.',
    question: (ctx) => `Is out-of-hours or busy-day enquiry follow-up something you've already got covered? If not, would a ${ctx.cta} for ${ctx.agency} be useful?`,
  },
};

function agencyName(companyName) {
  return text(companyName)
    .replace(/\s*\((?:branch|head office)[^)]*\)\s*$/i, '')
    .replace(/[\s,]+(?:limited|ltd\.?|llp|plc)$/i, '')
    .trim();
}

function firstNameOf(contactName) {
  const first = text(contactName).split(/\s+/)[0] || '';
  return /^[A-Z][a-z'’-]{1,30}$/.test(first) ? first : '';
}

function missingSenderSettings(settings) {
  const missing = REQUIRED_SENDER_SETTINGS.filter((k) => !text(settings[k]));
  for (const k of ['WEBSITE_URL', 'PRIVACY_URL']) {
    if (text(settings[k]) && !parseHost(settings[k], { requireScheme: true })) missing.push(`${k} (must be a full https:// URL)`);
  }
  return missing;
}

function signatureAndFooter(settings, lead) {
  const agency = agencyName(lead.company_name);
  return [
    text(settings.SENDER_NAME),
    `${text(settings.BUSINESS_LEGAL_NAME)} · ${text(settings.WEBSITE_URL)}`,
    text(settings.BUSINESS_POSTAL_ADDRESS),
    '',
    `You're receiving this because ${agency}'s contact address is published on your website. If you'd rather not hear from us, reply "unsubscribe" and we won't contact you again.`,
    `Privacy notice: ${text(settings.PRIVACY_URL)}`,
  ].join('\n');
}

function templateContext(lead, niche) {
  return {
    agency: agencyName(lead.company_name),
    firstName: firstNameOf(lead.contact_name),
    cta: text(niche && niche.cta).replace(/^\w/, (c) => c.toLowerCase()) || 'short call',
    evidence: parseEvidence(lead.evidence),
    evidenceText: text(lead.evidence),
  };
}

function composeEmail({ templateId, lead, niche, settings, observation, subject }) {
  const tpl = TEMPLATES[templateId];
  if (!tpl) throw new Error(`Unknown template_id "${templateId}"`);
  const ctx = templateContext(lead, niche);
  const main = [
    `Hi ${ctx.firstName || 'there'},`,
    text(observation),
    tpl.service,
    tpl.question(ctx),
  ].filter(Boolean).join('\n\n');
  return {
    subject: text(subject) || tpl.subject(ctx),
    body: `${main}\n\n${signatureAndFooter(settings, lead)}`,
  };
}

function wordCount(s) {
  return text(s).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

function numbersIn(s) {
  return [...text(s).matchAll(/\d+(?:[.,:/]\d+)*/g)].map((m) => m[0]);
}

function hasBannedPhrase(s) {
  const lower = text(s).toLowerCase();
  return BANNED_PHRASES.filter((p) => new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^a-z0-9]|$)`).test(lower));
}

// Text inside double quotes is the agency's own wording (it must come from the
// stored evidence), so banned-phrase checks skip it and quote checks verify it.
function quotedSegments(s) {
  return [...text(s).matchAll(/["“]([^"”\n]{3,})["”]/g)].map((m) => m[1]);
}

function withoutQuotes(s) {
  return text(s).replace(/["“][^"”\n]*["”]/g, '""');
}

function squash(s) {
  return text(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').replace(/…$/, '').trim();
}

function unsupportedQuotes(s, evidenceText) {
  const ev = squash(evidenceText);
  return quotedSegments(s).filter((q) => !ev.includes(squash(q)));
}

// Checks an observation sentence written by the AI before it is used.
function checkObservation(observation, ctx, allowedNumberText) {
  const o = text(observation);
  const problems = [];
  if (!o) problems.push('empty');
  if (wordCount(o) > MAX_OBSERVATION_WORDS) problems.push(`longer than ${MAX_OBSERVATION_WORDS} words`);
  if (/https?:\/\/|www\./i.test(o)) problems.push('contains a link');
  if (/[{}]/.test(o)) problems.push('contains a placeholder');
  const banned = hasBannedPhrase(withoutQuotes(o));
  if (banned.length) problems.push(`banned phrase: ${banned.join(', ')}`);
  for (const n of numbersIn(o)) if (!allowedNumberText.includes(n)) problems.push(`number "${n}" not found in the evidence`);
  const unsupported = unsupportedQuotes(o, ctx.evidenceText);
  if (unsupported.length) problems.push('quotes text that is not in the stored evidence');
  if (!o.toLowerCase().includes(ctx.agency.toLowerCase())) problems.push('does not name the agency');
  return problems;
}

// Full draft check. Returns { pass, reasons, result } where result is the exact
// value stored in Leads.draft_check_result ("PASS" or "FAIL: …").
function checkDraft({ subject, body, lead, niche, settings, templateId }) {
  const reasons = [];
  const missing = missingSenderSettings(settings);
  if (missing.length) reasons.push(`missing settings: ${missing.join(', ')}`);
  if (!TEMPLATES[text(templateId)]) reasons.push(`unknown template_id "${text(templateId)}"`);

  const subj = text(subject);
  const b = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!subj) reasons.push('subject is empty');
  if (subj.length > MAX_SUBJECT_CHARS) reasons.push(`subject longer than ${MAX_SUBJECT_CHARS} characters`);
  if (/^\s*(re|fw|fwd)\s*:/i.test(subj)) reasons.push('subject pretends to be a reply or forward');
  if (/!/.test(subj)) reasons.push('subject contains "!"');
  if (/[a-z]/i.test(subj) && subj === subj.toUpperCase()) reasons.push('subject is all capitals');
  if (!b) reasons.push('body is empty');

  const footer = missing.length ? '' : signatureAndFooter(settings, lead);
  let main = b;
  if (footer) {
    if (!b.endsWith(footer)) reasons.push('signature/footer (sender, legal name, website, postal address, opt-out, privacy notice) is missing or was edited');
    else main = b.slice(0, b.length - footer.length).trim();
  }

  if (/[{}]|\[\[|\]\]|\[(?:name|first name|company|agency)\]/i.test(`${subj}\n${b}`)) reasons.push('unresolved placeholder');
  const banned = hasBannedPhrase(withoutQuotes(`${subj}\n${main}`));
  if (banned.length) reasons.push(`banned phrase: ${banned.join(', ')}`);
  if (unsupportedQuotes(main, lead.evidence).length) reasons.push('quoted text is not found in the stored evidence');

  const words = wordCount(main);
  if (words > MAX_BODY_WORDS) reasons.push(`body is ${words} words (max ${MAX_BODY_WORDS})`);
  if (b && words < MIN_BODY_WORDS) reasons.push(`body is only ${words} words`);

  const allowedHosts = new Set([parseHost(settings.WEBSITE_URL), parseHost(settings.PRIVACY_URL)].filter(Boolean));
  for (const m of b.matchAll(/(?:https?:\/\/|www\.)[^\s)"'<>]+/gi)) {
    const host = parseHost(m[0].startsWith('www.') ? `https://${m[0]}` : m[0]);
    if (!allowedHosts.has(host)) reasons.push(`link to ${host || m[0]} is not allowed (only the website and privacy notice)`);
  }

  const ctx = templateContext(lead, niche);
  // Every email must rest on genuine, quoted business context (brief §4: never a generic pitch).
  if (!ctx.evidence.length) reasons.push('no stored evidence to personalise from (Leads.evidence is empty)');
  if (!main.toLowerCase().includes(ctx.agency.toLowerCase())) reasons.push('body does not name the agency');
  const allowed = allowedNumberText({ lead, niche, templateId });
  for (const n of numbersIn(`${subj}\n${main}`)) if (!allowed.includes(n)) reasons.push(`number "${n}" is not supported by the stored evidence`);

  const unique = [...new Set(reasons)];
  return { pass: unique.length === 0, reasons: unique, result: unique.length ? clip(`FAIL: ${unique.join('; ')}`, 1000) : 'PASS' };
}

// Text in which any number used in the email must already appear.
function allowedNumberText({ lead, niche, templateId }) {
  const tpl = TEMPLATES[text(templateId)];
  const ctx = templateContext(lead, niche);
  return [
    text(lead.evidence),
    text(lead.company_name),
    text(lead.city),
    tpl ? tpl.service : '',
    tpl ? tpl.question(ctx) : '',
    ctx.cta,
  ].join('\n');
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = {
  REQUIRED_SENDER_SETTINGS,
  BANNED_PHRASES,
  TEMPLATES,
  MAX_BODY_WORDS,
  agencyName,
  firstNameOf,
  missingSenderSettings,
  signatureAndFooter,
  templateContext,
  composeEmail,
  checkObservation,
  checkDraft,
  allowedNumberText,
  wordCount,
};
