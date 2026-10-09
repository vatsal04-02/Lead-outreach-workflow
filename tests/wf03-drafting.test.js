'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/lib/drafting');
const W3 = require('../src/wf03-draft-logic');
const { parseSettings, formatEvidence } = require('../src/lib/common');
const { NOW, settingsRows, nichesRows, lead } = require('./helpers/fixtures');

const gemini = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const EVIDENCE = formatEvidence([
  { quote: 'We aim to respond to all enquiries within 24 hours.', url: 'https://www.agency-one.example', signal: '24h reply promise' },
  { quote: 'Get an instant online valuation', url: 'https://www.agency-one.example', signal: 'valuation form' },
]);
const settings = parseSettings(settingsRows());
const niche = nichesRows()[0];

function qualified(overrides = {}) {
  return lead({ stage: 'Qualified', evidence: EVIDENCE, opportunity_hypothesis: 'Auto-acknowledging enquiries may help.', contact_name: 'Jane Smith', ...overrides });
}

function draftFor(l, observation = '') {
  return D.composeEmail({ templateId: 'uk-estate-letting-v1', lead: l, niche, settings, observation: observation || D.TEMPLATES['uk-estate-letting-v1'].fallbackObservation(D.templateContext(l, niche)), subject: '' });
}

function check(l, email) {
  return D.checkDraft({ subject: email.subject, body: email.body, lead: l, niche, settings, templateId: 'uk-estate-letting-v1' });
}

test('the template draft passes every check and contains the legal footer', () => {
  const l = qualified();
  const email = draftFor(l);
  const c = check(l, email);
  assert.equal(c.result, 'PASS', c.reasons.join('; '));
  assert.match(email.body, /^Hi Jane,/);
  assert.match(email.body, /FlowHQ Test Ltd · https:\/\/flowhq\.example/);
  assert.match(email.body, /1 Test Street, Testville, TE1 1ST/);
  assert.match(email.body, /reply "unsubscribe"/);
  assert.match(email.body, /Privacy notice: https:\/\/flowhq\.example\/privacy$/);
  assert.match(email.body, /free 15-minute enquiry workflow review for Agency One Lettings be useful\?/);
  assert.ok(D.wordCount(email.body.split('\n\nTest Sender')[0]) <= D.MAX_BODY_WORDS);
});

test('quoted agency wording may contain otherwise banned words, FlowHQ claims may not', () => {
  const l = qualified();
  const quoted = draftFor(l, `I was looking at Agency One Lettings's website and noticed "Get an instant online valuation".`);
  assert.equal(check(l, quoted).result, 'PASS');
  const claim = draftFor(l, 'I was looking at Agency One Lettings\'s website. Our clients get guaranteed results instantly.');
  const c = check(l, claim);
  assert.equal(c.pass, false);
  assert.match(c.result, /banned phrase: our clients, guaranteed, instantly/);
});

test('quotes that are not in the stored evidence fail', () => {
  const l = qualified();
  const c = check(l, draftFor(l, 'I was looking at Agency One Lettings\'s website and noticed "We never answer the phone".'));
  assert.match(c.result, /quoted text is not found in the stored evidence/);
});

test('numbers must be supported by the evidence', () => {
  const l = qualified();
  assert.equal(check(l, draftFor(l, "I was looking at Agency One Lettings's website and noticed you reply within 24 hours.")).result, 'PASS');
  const c = check(l, draftFor(l, "I was looking at Agency One Lettings's website and noticed 73% of enquiries arrive after 6pm."));
  assert.match(c.result, /number "73" is not supported/);
});

test('edited or missing footers, placeholders, extra links and bad subjects fail', () => {
  const l = qualified();
  const email = draftFor(l);
  assert.match(check(l, { ...email, body: email.body.replace('reply "unsubscribe"', 'ignore this') }).result, /signature\/footer/);
  assert.match(check(l, { ...email, body: email.body.replace('Hi Jane,', 'Hi {first_name},') }).result, /unresolved placeholder/);
  assert.match(check(l, { ...email, body: email.body.replace('FlowHQ builds', 'See https://tracker.example/x. FlowHQ builds') }).result, /tracker\.example is not allowed/);
  assert.match(check(l, { ...email, subject: 'Re: your enquiry' }).result, /pretends to be a reply/);
  assert.match(check(l, { ...email, subject: 'FREE REVIEW' }).result, /all capitals/);
  assert.match(check(l, { ...email, subject: 'Hello!' }).result, /contains "!"/);
  const long = draftFor(l, `I was looking at Agency One Lettings's website and noticed ${'many things '.repeat(40)}`);
  assert.match(check(l, long).result, /body is \d+ words \(max 120\)/);
});

test('missing sender settings fail the check (compliance rule 4)', () => {
  const l = qualified();
  const email = draftFor(l);
  const c = D.checkDraft({ subject: email.subject, body: email.body, lead: l, niche, settings: { ...settings, BUSINESS_LEGAL_NAME: '' }, templateId: 'uk-estate-letting-v1' });
  assert.match(c.result, /missing settings: BUSINESS_LEGAL_NAME/);
});

// ---------- WF03 ----------

test('selectDrafts picks Qualified leads to generate and Needs Edit drafts to re-check', () => {
  const l1 = qualified({ lead_id: 'one.example' });
  const l2 = qualified({ lead_id: 'two.example', stage: 'Draft Ready', approval_status: 'Needs Edit', template_id: 'uk-estate-letting-v1' });
  Object.assign(l2, draftFor(l2) && { email_subject: draftFor(l2).subject, email_body: draftFor(l2).body });
  const l3 = qualified({ lead_id: 'three.example', stage: 'Draft Ready', approval_status: 'Pending' });
  const r = W3.selectDrafts({ settingsRows: settingsRows(), nichesRows: nichesRows(), leadsRows: [l1, l2, l3], suppressionRows: [], model: 'gemini-2.5-flash', now: NOW });
  assert.deepEqual(r.generate.map((g) => g.lead_id), ['one.example']);
  assert.deepEqual(r.recheck.map((g) => [g.lead_id, g.draft_check_result]), [['two.example', 'PASS']]);
  for (const u of r.recheck) assert.deepEqual(Object.keys(u).sort(), [...W3.WF03_RECHECK_COLUMNS].sort());
});

test('suppressed leads are not drafted', () => {
  const l = qualified({ lead_id: 'gone.example', contact_email: 'info@gone.example' });
  const r = W3.selectDrafts({ settingsRows: settingsRows(), nichesRows: nichesRows(), leadsRows: [l], suppressionRows: [{ email: 'info@gone.example', reason: 'unsubscribe' }], model: 'm', now: NOW });
  assert.equal(r.generate.length, 0);
  assert.match(r.recheck[0].last_error, /Not drafted: contact_email is on the Suppression list/);
});

test('drafting refuses to start without sender settings or a known template', () => {
  assert.throws(() => W3.selectDrafts({ settingsRows: settingsRows({ BUSINESS_POSTAL_ADDRESS: '' }), nichesRows: nichesRows(), leadsRows: [], suppressionRows: [], model: 'm', now: NOW }), /BUSINESS_POSTAL_ADDRESS/);
  assert.throws(() => W3.selectDrafts({ settingsRows: settingsRows({ PRIVACY_URL: 'flowhq.example/privacy' }), nichesRows: nichesRows(), leadsRows: [], suppressionRows: [], model: 'm', now: NOW }), /PRIVACY_URL \(must be a full https/);
  assert.throws(() => W3.selectDrafts({ settingsRows: settingsRows(), nichesRows: nichesRows({ template_id: 'nope' }), leadsRows: [], suppressionRows: [], model: 'm', now: NOW }), /unknown template_id "nope"/);
});

function itemFor(l) {
  return W3.selectDrafts({ settingsRows: settingsRows(), nichesRows: nichesRows(), leadsRows: [l], suppressionRows: [], model: 'm', now: NOW }).generate[0];
}

test('a good AI sentence is used and the lead moves to Draft Ready / Pending', () => {
  const l = qualified();
  const obs = "I was looking at Agency One Lettings's website and noticed you aim to respond to enquiries within 24 hours.";
  const u = W3.assembleDraft({ item: itemFor(l), aiResponse: gemini({ subject: 'Enquiries at Agency One Lettings', observation: obs }), now: NOW });
  assert.deepEqual(Object.keys(u).sort(), [...W3.WF03_DRAFT_COLUMNS].sort());
  assert.equal(u.draft_check_result, 'PASS');
  assert.equal(u.stage, 'Draft Ready');
  assert.equal(u.approval_status, 'Pending');
  assert.equal(u.email_subject, 'Enquiries at Agency One Lettings');
  assert.ok(u.email_body.includes(obs));
  assert.equal(u.last_error, '');
});

test('an AI sentence with invented claims is replaced by the evidence sentence', () => {
  const l = qualified();
  const u = W3.assembleDraft({ item: itemFor(l), aiResponse: gemini({ subject: 'Hi!', observation: 'Agency One Lettings loses 40% of leads; we guarantee results.' }), now: NOW });
  assert.equal(u.draft_check_result, 'PASS');
  assert.match(u.last_error, /AI sentence rejected/);
  assert.match(u.email_body, /noticed this: "We aim to respond to all enquiries within 24 hours\."/);
  assert.equal(u.email_subject, 'Enquiry follow-up at Agency One Lettings');
});

test('AI outage still produces a checked draft from the template', () => {
  const u = W3.assembleDraft({ item: itemFor(qualified()), aiResponse: { error: { message: '503' } }, now: NOW });
  assert.equal(u.draft_check_result, 'PASS');
  assert.match(u.last_error, /AI request failed: 503/);
});

test('without evidence the draft fails and stays Qualified', () => {
  const l = qualified({ evidence: '' });
  const u = W3.assembleDraft({ item: itemFor(l), aiResponse: { error: 'x' }, now: NOW });
  assert.equal(u.stage, 'Qualified');
  assert.match(u.draft_check_result, /^FAIL/);
});

test('draft prompt forbids claims and statistics', () => {
  const p = W3.draftPrompt(qualified(), niche);
  assert.match(p, /no claims about FlowHQ results/);
  assert.match(p, /no statistics/);
});
