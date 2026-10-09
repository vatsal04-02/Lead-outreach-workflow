'use strict';

// Cross-workflow integration test without n8n: chains the same logic modules the
// Code nodes run (WF01 → WF02 → WF03 → approval → WF04 → WF05 → WF06) over an
// in-memory sheet. The n8n-engine version of this chain is scripts/n8n-engine-test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TABS } = require('../src/schema');
const W1 = require('../src/wf01-import-logic');
const W2 = require('../src/wf02-research-logic');
const R = require('../src/lib/registries');
const W3 = require('../src/wf03-draft-logic');
const W4 = require('../src/wf04-send-logic');
const W5 = require('../src/wf05-replies-logic');
const W6 = require('../src/wf06-metrics-logic');
const { settingsRows, nichesRows } = require('./helpers/fixtures');

const NOW = '2026-10-13T10:00:00.000Z';
const gem = (o) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });

function sheet() {
  const s = { Leads: [], Suppression: [], Send_Log: [], Metrics: [] };
  s.rows = (tab) => s[tab].map((r, i) => ({ row_number: i + 2, ...r }));
  s.lead = (id) => s.Leads.find((l) => l.lead_id === id);
  s.update = (items) => {
    for (const it of items) {
      const row = s.lead(it.lead_id);
      if (row) Object.assign(row, it);
    }
  };
  return s;
}

test('one synthetic agency travels from import to unsubscribe, with every safety gate respected', () => {
  const s = sheet();
  let settings = settingsRows({ SENDING_ENABLED: 'FALSE', TEST_RECIPIENT: 'inbox@flowhq.example' });
  const niches = nichesRows();

  // WF01
  const imp = W1.processImport({
    settingsRows: settings, nichesRows: niches, leadsRows: [], suppressionRows: [], now: NOW,
    importRows: [{ row_number: 2, company_name: 'Kappa Lettings Ltd', website: 'https://kappa.example', city: 'Reading', contact_email: 'info@kappa.example', email_source_url: 'https://kappa.example/contact' }],
  });
  s.Leads.push(...imp.leadsToAppend.map((l) => ({ ...Object.fromEntries(TABS.Leads.map((c) => [c, ''])), ...l })));
  assert.equal(s.lead('kappa.example').stage, 'New Lead');

  // WF02
  const header = [Object.fromEntries(TABS.Leads.map((c) => [c, c]))];
  const batch = W2.selectResearchBatch({ settingsRows: settings, nichesRows: niches, leadsRows: s.rows('Leads'), suppressionRows: [], leadsHeaderRows: header, now: NOW });
  const item = batch.researchItems[0];
  const html = '<p>We aim to respond to all enquiries within 24 hours.</p><p>Kappa Lettings Ltd, company no. 09990009</p>';
  const assembled = W2.assembleResearch(item, { data: html }, []);
  assert.equal(assembled.ch_request_url, 'https://api.company-information.service.gov.uk/company/09990009');
  const registry = R.evaluateRegistry(assembled.registry_plan, { company_number: '09990009', company_status: 'active', type: 'ltd', company_name: 'KAPPA LETTINGS LIMITED' }, NOW);
  assert.ok(W2.buildAiRequest(assembled, registry, 'gemini-2.5-flash').request_url);
  const ai = gem({ fit_score: 3, problem_score: 2, contact_score: 1, evidence: [{ quote: 'We aim to respond to all enquiries within 24 hours.', url: 'https://kappa.example', signal: '24h' }], qualification_reasoning: 'Fits.', opportunity_hypothesis: 'Auto-acknowledge.' });
  s.update([W2.scoreAndGate({ assembled, registry, aiResponse: ai, now: NOW })]);
  assert.equal(s.lead('kappa.example').stage, 'Qualified');
  assert.equal(s.lead('kappa.example').registry_status, 'VERIFIED');

  // WF03 (AI unavailable → evidence-quoting template sentence)
  const drafts = W3.selectDrafts({ settingsRows: settings, nichesRows: niches, leadsRows: s.rows('Leads'), suppressionRows: [], model: 'm', now: NOW });
  s.update([W3.assembleDraft({ item: drafts.generate[0], aiResponse: { error: 'quota' }, now: NOW })]);
  assert.equal(s.lead('kappa.example').draft_check_result, 'PASS');

  // Human approval
  Object.assign(s.lead('kappa.example'), { stage: 'Approved', approval_status: 'Approved', approved_at: NOW });

  const wf04 = () => W4.gateAndPick({ settingsRows: settings, nichesRows: niches, leadsRows: s.rows('Leads'), suppressionRows: s.Suppression, sendLogRows: s.Send_Log, now: NOW });
  assert.equal(wf04().action, 'skip'); // SENDING_ENABLED=FALSE (default)

  // Test send
  settings = settingsRows({ SENDING_ENABLED: 'TRUE', TEST_RECIPIENT: 'inbox@flowhq.example' });
  let pick = wf04();
  assert.equal(pick.send.to, 'inbox@flowhq.example');
  s.update([W4.lockUpdate(pick.send)]);
  assert.ok(W4.verifyLock(s.rows('Leads'), pick.send).ok);
  let res = W4.recordSuccess(pick.send, { id: 'm1', threadId: 't1' }, NOW);
  s.update([res.leadUpdate]);
  s.Send_Log.push(res.logRow);
  assert.equal(wf04().reason, 'last send was less than 8 minutes ago');
  settings = settingsRows({ SENDING_ENABLED: 'TRUE', TEST_RECIPIENT: 'inbox@flowhq.example', MIN_MINUTES_BETWEEN_SENDS: '0' });
  assert.equal(wf04().reason, 'no approved leads waiting'); // TestSent is never picked again

  // Live send to an allowlisted address, a later minute
  settings = settingsRows({ SENDING_ENABLED: 'TRUE', TEST_MODE: 'FALSE', LIVE_RECIPIENT_ALLOWLIST: 'info@kappa.example', MIN_MINUTES_BETWEEN_SENDS: '0' });
  s.lead('kappa.example').send_status = '';
  pick = wf04();
  assert.equal(pick.send.to, 'info@kappa.example');
  s.update([W4.lockUpdate(pick.send)]);
  res = W4.recordSuccess(pick.send, { id: 'm2', threadId: 't2' }, NOW);
  s.update([res.leadUpdate]);
  s.Send_Log.push(res.logRow);
  assert.equal(s.lead('kappa.example').stage, 'Contacted');

  // WF05: opt-out
  const r5 = W5.processMessages({
    leadsRows: s.rows('Leads'), sendLogRows: s.Send_Log, suppressionRows: s.Suppression, now: NOW,
    messages: [{ id: 'r1', threadId: 't2', subject: 'Re: x', from: { value: [{ address: 'info@kappa.example' }] }, date: '2026-10-13T11:00:00Z', text: 'Please remove me', headers: {} }],
  });
  s.Suppression.push(...r5.suppressions);
  s.update(r5.leadUpdates);
  assert.equal(s.lead('kappa.example').stage, 'Unsubscribed');

  // Nothing can send to them again, even if someone re-approves the lead.
  Object.assign(s.lead('kappa.example'), { stage: 'Approved', send_status: '' });
  const blocked = wf04();
  assert.equal(blocked.action, 'skip');
  assert.match(blocked.notes[0].last_error, /Suppression list/);

  // WF06
  const m = W6.computeMetrics({ leadsRows: s.rows('Leads'), sendLogRows: s.Send_Log, suppressionRows: s.Suppression, now: NOW, timeZone: 'Asia/Kolkata' });
  assert.equal(m.emails_sent, 1); // the test send is not counted
  assert.equal(m.unsubscribes, 1);
});
