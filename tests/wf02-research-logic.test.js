'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/wf02-research-logic');
const { parseGeminiJson } = require('../src/lib/gemini');
const { TABS } = require('../src/schema');
const { NOW, settingsRows, nichesRows, lead } = require('./helpers/fixtures');

const gemini = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

const HOME_HTML = `<html><head><script>var x = "<b>no</b>";</script><style>p{}</style></head><body>
<nav><a href="/contact-us">Contact us</a> <a href="https://www.agency-one.example/about">About our team</a>
<a href="/lettings">Lettings</a> <a href="https://other.example/contact">Partner</a> <a href="mailto:info@agency-one.example">Email</a>
<a href="/brochure.pdf">Contact brochure</a></nav>
<p>Office hours: Monday &ndash; Friday 9am &amp; 5:30pm. Closed Sundays.</p>
<p>We aim to respond to all enquiries within 24 hours.</p>
<footer>Agency One Lettings Ltd. Registered in England. Company No. 01234567.</footer>
<a href="/cdn-cgi/l/email-protection" data-cfemail="5c3a2e33311c3d3b393f323c32727e3d3e3e3e3a3e5c">x</a>
</body></html>`;

const CONTACT_HTML = '<html><body><h1>Contact</h1><p>To book a viewing please call the office.</p><p>Jane Smith, Director, leads our lettings team.</p></body></html>';

function item(overrides = {}) {
  const l = lead(overrides.lead || {});
  return {
    lead_id: l.lead_id,
    request_url: 'https://www.agency-one.example',
    website_url: 'https://www.agency-one.example',
    country: 'UK',
    niche: nichesRows()[0],
    min_score: 60,
    lead: l,
    ...overrides.item,
  };
}

function assembled(overrides = {}) {
  return W.assembleResearch(item(overrides), { data: HOME_HTML }, [{ url: 'https://www.agency-one.example/contact-us', response: { data: CONTACT_HTML } }]);
}

const VERIFIED_CH = { required: true, verified: true, number: '01234567', status: 'active', type: 'ltd', name: 'AGENCY ONE LETTINGS LIMITED', reason: 'Companies House: ok' };

function goodAi(overrides = {}) {
  return gemini({
    fit_score: 3,
    problem_score: 3,
    contact_score: 3,
    qualification_reasoning: 'Independent letting agency with office hours that close on Sundays.',
    evidence: [
      { quote: 'We aim to respond to all enquiries within 24 hours.', url: 'https://www.agency-one.example', signal: '24h reply promise' },
      { quote: 'To book a viewing please call the office.', url: 'https://www.agency-one.example/contact-us', signal: 'phone-only viewings' },
    ],
    opportunity_hypothesis: 'Acknowledging enquiries automatically might help outside office hours.',
    decision_maker: { name: 'Jane Smith', role: 'Director', quote: 'Jane Smith, Director, leads our lettings team.', url: 'https://www.agency-one.example/contact-us' },
    exclusions_found: [],
    no_solicitation_notice: { found: false, quote: '', url: '' },
    ...overrides,
  });
}

// ---------- batch selection ----------

test('selects only New Lead rows of the active niche, up to RESEARCH_BATCH_SIZE', () => {
  const leads = [
    lead({ lead_id: 'a.example' }),
    lead({ lead_id: 'b.example' }),
    lead({ lead_id: 'c.example', stage: 'Qualified' }),
    lead({ lead_id: 'd.example', niche_id: 'other' }),
    lead({ lead_id: 'e.example' }),
  ];
  const r = W.selectResearchBatch({ settingsRows: settingsRows({ RESEARCH_BATCH_SIZE: '2' }), nichesRows: nichesRows(), leadsRows: leads, suppressionRows: [], now: NOW });
  assert.deepEqual(r.researchItems.map((i) => i.lead_id), ['a.example', 'b.example']);
  assert.equal(r.summary.waiting, 1);
  assert.equal(r.immediateUpdates.length, 0);
});

test('suppressed leads are disqualified without being fetched, keeping other columns', () => {
  const l = lead({ lead_id: 'blocked.example', contact_email: 'info@blocked.example', notes: 'keep', fit_score: '' });
  const r = W.selectResearchBatch({ settingsRows: settingsRows(), nichesRows: nichesRows(), leadsRows: [l], suppressionRows: [{ email: '', domain: 'blocked.example', reason: 'manual' }], now: NOW });
  assert.equal(r.researchItems.length, 0);
  const u = r.immediateUpdates[0];
  assert.deepEqual(Object.keys(u).sort(), [...W.WF02_COLUMNS].sort());
  assert.equal(u.stage, 'Disqualified');
  assert.match(u.disqualify_reason, /Suppressed: domain is on the Suppression list/);
});

test('leads that failed before are queued after fresh ones', () => {
  const leads = [lead({ lead_id: 'failed.example', last_error: 'Website fetch failed' }), lead({ lead_id: 'fresh.example' })];
  const r = W.selectResearchBatch({ settingsRows: settingsRows({ RESEARCH_BATCH_SIZE: '1' }), nichesRows: nichesRows(), leadsRows: leads, suppressionRows: [], now: NOW });
  assert.equal(r.researchItems[0].lead_id, 'fresh.example');
});

test('invalid batch settings and niches abort research', () => {
  const run = (s, n) => () => W.selectResearchBatch({ settingsRows: settingsRows(s), nichesRows: n || nichesRows(), leadsRows: [], suppressionRows: [], now: NOW });
  assert.throws(run({ RESEARCH_BATCH_SIZE: '0' }), /RESEARCH_BATCH_SIZE/);
  assert.throws(run({ RESEARCH_BATCH_SIZE: 'five' }), /RESEARCH_BATCH_SIZE/);
  assert.throws(run({ MIN_QUALIFY_SCORE: '101' }), /MIN_QUALIFY_SCORE/);
  assert.throws(run({}, nichesRows({ active: 'FALSE' })), /research aborted/);
});

// ---------- HTML ----------

test('htmlToText removes scripts and styles and decodes entities', () => {
  const t = W.htmlToText(HOME_HTML);
  assert.ok(!t.includes('var x'));
  assert.match(t, /Monday – Friday 9am & 5:30pm/);
  assert.match(t, /We aim to respond to all enquiries within 24 hours\./);
});

test('emails are found in mailto links and Cloudflare-protected addresses', () => {
  const emails = W.emailsInHtml(HOME_HTML);
  assert.ok(emails.includes('info@agency-one.example'));
  assert.equal(W.decodeCfEmail('5c3a2e33311c3d3b393f323c32727e3d3e3e3e3a3e5c').length > 0, true);
});

test('plans at most one contact and one about page on the same domain', () => {
  const pages = W.planPagesForLead(item().lead && item(), HOME_HTML);
  assert.deepEqual(pages.map((p) => p.request_url), ['https://www.agency-one.example/contact-us', 'https://www.agency-one.example/about']);
  assert.deepEqual(W.planPagesForLead(item(), ''), []);
});

// ---------- assembling and Companies House ----------

test('company number in the footer drives a direct Companies House lookup', () => {
  const a = assembled();
  assert.equal(a.company_number_hint, '01234567');
  assert.equal(a.ch_request_url, 'https://api.company-information.service.gov.uk/company/01234567');
  assert.equal(a.pages.length, 2);
  assert.equal(a.fetch_error, '');
  assert.equal(a.no_solicitation, null);
});

test('without a number, Companies House is searched by name', () => {
  const a = W.assembleResearch(item(), { data: '<p>Welcome</p>' }, []);
  assert.match(a.ch_request_url, /search\/companies\?q=Agency%20One%20Lettings%20Ltd&items_per_page=5$/);
});

test('a human-entered company_number wins over the footer', () => {
  const a = W.assembleResearch(item({ lead: { company_number: 'SC123456' } }), { data: HOME_HTML }, []);
  assert.match(a.ch_request_url, /company\/SC123456$/);
});

test('homepage failure skips Companies House and records why', () => {
  const a = W.assembleResearch(item(), { error: { message: 'getaddrinfo ENOTFOUND' } }, []);
  assert.match(a.fetch_error, /Website fetch failed: getaddrinfo ENOTFOUND/);
  assert.equal(a.ch_request_url, '');
});

test('no-solicitation notices are detected with a quote', () => {
  const a = W.assembleResearch(item(), { data: '<p>Please note: we do not accept unsolicited sales emails or calls.</p>' }, []);
  assert.match(a.no_solicitation.quote, /do not accept unsolicited sales emails/);
});

test('Companies House outcomes', () => {
  const a = assembled();
  assert.equal(W.evaluateCompaniesHouse(a, { company_number: '01234567', company_status: 'active', type: 'ltd', company_name: 'X LIMITED' }).verified, true);
  const dissolved = W.evaluateCompaniesHouse(a, { company_number: '01234567', company_status: 'dissolved', type: 'ltd' });
  assert.equal(dissolved.verified, false);
  assert.equal(dissolved.definitive, true);
  const soleTraderLike = W.evaluateCompaniesHouse(a, { company_number: '01234567', company_status: 'active', type: 'limited-partnership' });
  assert.equal(soleTraderLike.definitive, true);
  const failed = W.evaluateCompaniesHouse(a, { error: { message: '401 Unauthorized' } });
  assert.equal(failed.verified, false);
  assert.equal(failed.definitive, false);
  assert.match(failed.reason, /401/);

  const search = { ...a, ch_request_url: 'https://api.company-information.service.gov.uk/search/companies?q=x' };
  const one = W.evaluateCompaniesHouse(search, { items: [{ title: 'AGENCY ONE LETTINGS LIMITED', company_number: '07654321', company_status: 'active', company_type: 'ltd' }, { title: 'AGENCY ONE HOLDINGS LIMITED' }] });
  assert.equal(one.verified, true);
  assert.equal(one.number, '07654321');
  const none = W.evaluateCompaniesHouse(search, { items: [{ title: 'SOMETHING ELSE LTD' }] });
  assert.equal(none.verified, false);
  assert.equal(none.definitive, false);
  const two = W.evaluateCompaniesHouse(search, { items: [{ title: 'Agency One Lettings Ltd' }, { title: 'AGENCY ONE LETTINGS LIMITED' }] });
  assert.match(two.reason, /2 Companies House companies share the name/);
  assert.equal(W.evaluateCompaniesHouse({ ...a, country: 'US' }, {}).verified, true);
});

// ---------- AI request ----------

test('AI is only called when the website and company checks passed', () => {
  const a = assembled();
  assert.match(W.buildAiRequest(a, VERIFIED_CH, 'gemini-2.5-flash').request_url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(W.buildAiRequest({ ...a, fetch_error: 'x' }, VERIFIED_CH, 'm').request_url, '');
  assert.equal(W.buildAiRequest(a, { required: true, verified: false, reason: 'r' }, 'm').request_url, '');
  assert.equal(W.buildAiRequest({ ...a, no_solicitation: { quote: 'q', url: 'u' } }, VERIFIED_CH, 'm').request_url, '');
  assert.throws(() => W.buildAiRequest(a, VERIFIED_CH, 'bad model/../x'), /Invalid Gemini model/);
  const prompt = W.researchPrompt(a);
  assert.match(prompt, /Use ONLY the page text/);
  assert.match(prompt, /PAGE URL: https:\/\/www\.agency-one\.example\/contact-us/);
});

// ---------- scoring and gates ----------

test('verified evidence qualifies a lead and writes exactly the WF02 columns', () => {
  const u = W.scoreAndGate({ assembled: assembled(), ch: VERIFIED_CH, aiResponse: goodAi(), now: NOW });
  assert.deepEqual(Object.keys(u).sort(), [...W.WF02_COLUMNS].sort());
  for (const k of Object.keys(u)) assert.ok(TABS.Leads.includes(k));
  assert.equal(u.stage, 'Qualified');
  assert.equal(u.problem_score, 3);
  assert.equal(u.channel_score, 2); // info@ is a role address
  assert.equal(u.contact_score, 2); // named person, but only a role email
  assert.equal(u.contact_name, 'Jane Smith');
  assert.equal(u.company_number, '01234567');
  assert.equal(u.total_score, Math.round(30 + 30 + (2 / 3) * 20 + (2 / 3) * 20));
  assert.match(u.evidence, /^"We aim to respond to all enquiries within 24 hours\." — https:\/\/www\.agency-one\.example \[24h reply promise\]/);
  assert.equal(u.last_error, '');
});

test('quotes not found verbatim are discarded and problem_score is capped', () => {
  const ai = goodAi({ evidence: [{ quote: 'We miss most of our leads every weekend.', url: 'https://www.agency-one.example', signal: 'invented' }] });
  const u = W.scoreAndGate({ assembled: assembled(), ch: VERIFIED_CH, aiResponse: ai, now: NOW });
  assert.equal(u.problem_score, 1);
  assert.equal(u.evidence, '');
  assert.match(u.qualification_reasoning, /1 AI quote\(s\) discarded/);
});

test('a decision-maker is only accepted with a verified quote', () => {
  const ai = goodAi({ decision_maker: { name: 'John Invented', role: 'Owner', quote: 'John Invented owns the business.', url: 'https://www.agency-one.example' } });
  const u = W.scoreAndGate({ assembled: assembled(), ch: VERIFIED_CH, aiResponse: ai, now: NOW });
  assert.equal(u.contact_name, '');
  assert.equal(u.contact_score, 1);
});

test('scores below MIN_QUALIFY_SCORE disqualify; score_override wins', () => {
  const low = gemini({ fit_score: 1, problem_score: 0, contact_score: 0, evidence: [] });
  const u = W.scoreAndGate({ assembled: assembled(), ch: VERIFIED_CH, aiResponse: low, now: NOW });
  assert.equal(u.stage, 'Disqualified');
  assert.match(u.disqualify_reason, /below MIN_QUALIFY_SCORE 60/);
  const o = W.scoreAndGate({ assembled: assembled({ lead: { score_override: '75' } }), ch: VERIFIED_CH, aiResponse: low, now: NOW });
  assert.equal(o.stage, 'Qualified');
  assert.match(o.qualification_reasoning, /score_override 75 used/);
});

test('verified exclusions and no-solicitation notices are hard gates', () => {
  const ex = goodAi({ exclusions_found: [{ exclusion: 'national chain', quote: 'To book a viewing please call the office.', url: 'https://www.agency-one.example/contact-us' }] });
  assert.equal(W.scoreAndGate({ assembled: assembled(), ch: VERIFIED_CH, aiResponse: ex, now: NOW }).stage, 'Disqualified');
  const unverified = goodAi({ exclusions_found: [{ exclusion: 'franchise', quote: 'Part of a national franchise.', url: 'https://www.agency-one.example' }] });
  assert.equal(W.scoreAndGate({ assembled: assembled(), ch: VERIFIED_CH, aiResponse: unverified, now: NOW }).stage, 'Qualified');
  const a = W.assembleResearch(item(), { data: '<p>We do not accept unsolicited sales emails.</p>' }, []);
  const u = W.scoreAndGate({ assembled: a, ch: VERIFIED_CH, aiResponse: {}, now: NOW });
  assert.equal(u.stage, 'Disqualified');
  assert.match(u.disqualify_reason, /No-solicitation notice/);
});

test('AI failure changes nothing except last_error', () => {
  const a = assembled({ lead: { qualification_reasoning: 'old', fit_score: 2 } });
  for (const bad of [{ error: { message: '429 quota exceeded' } }, { candidates: [] }, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }, gemini({ fit_score: 7, problem_score: 1, contact_score: 1 })]) {
    const u = W.scoreAndGate({ assembled: a, ch: VERIFIED_CH, aiResponse: bad, now: NOW });
    assert.equal(u.stage, 'New Lead');
    assert.equal(u.qualification_reasoning, 'old');
    assert.equal(u.fit_score, 2);
    assert.notEqual(u.last_error, '');
  }
});

test('fetch failures and unverifiable companies never qualify', () => {
  const failed = W.scoreAndGate({ assembled: W.assembleResearch(item(), { error: { message: 'timeout' } }, []), ch: { required: true, verified: false }, aiResponse: {}, now: NOW });
  assert.equal(failed.stage, 'New Lead');
  assert.match(failed.last_error, /Website fetch failed/);
  const unverified = W.scoreAndGate({ assembled: assembled(), ch: { required: true, verified: false, definitive: false, reason: 'No exact Companies House name match' }, aiResponse: {}, now: NOW });
  assert.equal(unverified.stage, 'Researched');
  assert.match(unverified.qualification_reasoning, /Needs manual check/);
  const dissolved = W.scoreAndGate({ assembled: assembled(), ch: { required: true, verified: false, definitive: true, number: '01234567', status: 'dissolved', type: 'ltd', reason: 'Companies House status is "dissolved", not active' }, aiResponse: {}, now: NOW });
  assert.equal(dissolved.stage, 'Disqualified');
  assert.equal(dissolved.company_status, 'dissolved');
});

test('channel score follows the published address', () => {
  assert.equal(W.channelScore(lead({ contact_email: '' })), 0);
  assert.equal(W.channelScore(lead({ contact_email: 'lettings@agency-one.example' })), 2);
  assert.equal(W.channelScore(lead({ contact_email: 'jane.smith@agency-one.example' })), 3);
  assert.equal(W.channelScore(lead({ contact_email: 'janesmith@gmail.com' })), 2);
});

test('Gemini parsing tolerates code fences and reports blocks', () => {
  assert.equal(parseGeminiJson({ candidates: [{ content: { parts: [{ text: '```json\n{"a":1}\n```' }] } }] }).value.a, 1);
  assert.match(parseGeminiJson({ promptFeedback: { blockReason: 'SAFETY' } }).error, /SAFETY/);
  assert.equal(parseGeminiJson({ candidates: [{ content: { parts: [{ text: '[1]' }] } }] }).ok, false);
});
