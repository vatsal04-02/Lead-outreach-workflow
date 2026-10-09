'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W4 = require('../src/wf04-send-logic');
const D = require('../src/lib/drafting');
const { parseSettings, formatEvidence } = require('../src/lib/common');
const { TABS } = require('../src/schema');
const { NOW, settingsRows, nichesRows, lead } = require('./helpers/fixtures');

const EVIDENCE = formatEvidence([{ quote: 'We aim to respond to all enquiries within 24 hours.', url: 'https://www.agency-one.example', signal: '24h' }]);
const LIVE = { SENDING_ENABLED: 'TRUE', TEST_MODE: 'TRUE', TEST_RECIPIENT: 'inbox@flowhq.example' };

function approved(overrides = {}) {
  const base = lead({ stage: 'Approved', approval_status: 'Approved', approved_at: '2026-10-12T09:00:00Z', evidence: EVIDENCE, template_id: 'uk-estate-letting-v1', ...overrides });
  if (!overrides.email_body) {
    const settings = parseSettings(settingsRows());
    const ctx = D.templateContext(base, nichesRows()[0]);
    const email = D.composeEmail({ templateId: 'uk-estate-letting-v1', lead: base, niche: nichesRows()[0], settings, observation: D.TEMPLATES['uk-estate-letting-v1'].fallbackObservation(ctx), subject: '' });
    base.email_subject = email.subject;
    base.email_body = email.body;
    base.draft_check_result = 'PASS';
  }
  return base;
}

function run({ settings = {}, leads = [approved()], suppression = [], sendLog = [], niches, now = NOW } = {}) {
  return W4.gateAndPick({ settingsRows: settingsRows({ ...LIVE, ...settings }), nichesRows: niches || nichesRows(), leadsRows: leads, suppressionRows: suppression, sendLogRows: sendLog, now });
}

// ---------- kill switch and modes ----------

test('nothing happens unless SENDING_ENABLED is exactly TRUE, even with broken config', () => {
  for (const v of ['FALSE', 'true', 'True', '', 'yes', '1']) {
    const r = run({ settings: { SENDING_ENABLED: v, DAILY_SEND_LIMIT: 'broken' } });
    assert.equal(r.action, 'skip', v);
    assert.equal(r.reason, 'SENDING_ENABLED is not TRUE');
  }
  assert.equal(W4.isExactlyTrue(true), true);
});

test('test mode redirects the one email to TEST_RECIPIENT with a [TEST] subject', () => {
  const r = run();
  assert.equal(r.action, 'send');
  assert.equal(r.send.to, 'inbox@flowhq.example');
  assert.equal(r.send.intended_to, 'info@agency-one.example');
  assert.match(r.send.subject, /^\[TEST\] /);
  assert.match(r.send.body, /^TEST MODE: in live mode this email would go to info@agency-one\.example/);
  assert.equal(r.send.test_mode, true);
  assert.equal(r.send.lock_token, NOW);
});

test('test mode stays on for any value other than exactly FALSE', () => {
  for (const v of ['false', '', 'off', 'no']) assert.equal(run({ settings: { TEST_MODE: v } }).send.test_mode, true, v);
  assert.equal(run({ settings: { TEST_MODE: 'FALSE' } }).send.test_mode, false);
});

test('invalid configuration blocks sending with an error (alert via WF00)', () => {
  const bad = [
    [{ TEST_RECIPIENT: '' }, /TEST_RECIPIENT/],
    [{ DAILY_SEND_LIMIT: '0' }, /DAILY_SEND_LIMIT/],
    [{ DAILY_SEND_LIMIT: '500' }, /DAILY_SEND_LIMIT/],
    [{ MIN_MINUTES_BETWEEN_SENDS: '-1' }, /MIN_MINUTES_BETWEEN_SENDS/],
    [{ SEND_DAYS: 'Monday' }, /SEND_DAYS/],
    [{ SEND_WINDOW_START: '17:00' }, /SEND_WINDOW/],
    [{ SEND_WINDOW_END: '25:00' }, /SEND_WINDOW/],
    [{ BUSINESS_LEGAL_NAME: '' }, /BUSINESS_LEGAL_NAME/],
    [{ LIVE_RECIPIENT_ALLOWLIST: 'not-an-email' }, /LIVE_RECIPIENT_ALLOWLIST/],
    [{ ACTIVE_NICHE: '' }, /sending aborted/],
  ];
  for (const [s, re] of bad) assert.throws(() => run({ settings: s }), re, JSON.stringify(s));
  assert.throws(() => run({ niches: nichesRows({ timezone: 'Mars/Base' }) }), /time zone/);
});

// ---------- days and window ----------

test('only on SEND_DAYS inside the window, in the niche time zone', () => {
  assert.match(run({ now: '2026-10-17T10:00:00.000Z' }).reason, /Sat is not in SEND_DAYS/);
  assert.match(run({ now: '2026-10-13T08:00:00.000Z' }).reason, /outside the sending window/); // 09:00 London
  assert.equal(run({ now: '2026-10-13T08:30:00.000Z' }).action, 'send'); // 09:30 London, start inclusive
  assert.match(run({ now: '2026-10-13T15:00:00.000Z' }).reason, /outside the sending window/); // 16:00 London, end exclusive
  // After the clocks change (GMT), 09:30 London is 09:30 UTC.
  assert.match(run({ now: '2026-11-03T09:00:00.000Z' }).reason, /outside the sending window/);
  assert.equal(run({ now: '2026-11-03T09:30:00.000Z' }).action, 'send');
});

// ---------- limits ----------

test('the daily limit counts today\'s sends from Send_Log and Leads', () => {
  const today = (id, status = 'sent') => ({ lead_id: id, status, attempted_at: '2026-10-13T08:40:00.000Z', to_email: `x@${id}` });
  const sendLog = [today('a.example'), today('b.example', 'test_sent')];
  assert.match(run({ settings: { DAILY_SEND_LIMIT: '2' }, sendLog }).reason, /daily limit reached \(2\/2\)/);
  const yesterday = [{ lead_id: 'a.example', status: 'sent', attempted_at: '2026-10-12T10:00:00.000Z', to_email: 'x@a.example' }];
  assert.equal(run({ settings: { DAILY_SEND_LIMIT: '1' }, sendLog: yesterday }).action, 'send');
  const leads = [approved(), lead({ lead_id: 'c.example', send_status: 'Sent', sent_at: '2026-10-13T08:00:00.000Z' })];
  assert.match(run({ settings: { DAILY_SEND_LIMIT: '1' }, leads }).reason, /daily limit reached/);
});

test('two failed sends in a day pause sending until tomorrow', () => {
  const failed = (i) => ({ lead_id: `f${i}.example`, status: 'failed', attempted_at: `2026-10-13T0${i}:00:00.000Z` });
  assert.match(run({ sendLog: [failed(6), failed(7)] }).reason, /2 failed sends today/);
  assert.equal(run({ sendLog: [failed(6)] }).action, 'send');
});

test('minimum spacing between sends', () => {
  const recent = [{ lead_id: 'a.example', status: 'test_sent', attempted_at: '2026-10-13T09:55:00.000Z', to_email: 'x@a.example' }];
  assert.match(run({ sendLog: recent }).reason, /less than 8 minutes ago/);
  assert.equal(run({ sendLog: recent, settings: { MIN_MINUTES_BETWEEN_SENDS: '5' } }).action, 'send');
});

test('a lead stuck in Sending stops all sending until resolved', () => {
  const leads = [approved(), lead({ lead_id: 'stuck.example', send_status: 'Sending', last_updated: '2026-10-12T10:00:00.000Z' })];
  assert.match(run({ leads }).reason, /stuck in "Sending"/);
});

// ---------- per-lead re-checks ----------

test('only Approved/Approved/unsent leads of the active niche are candidates', () => {
  const leads = [
    approved({ lead_id: 'a.example', approval_status: 'Pending' }),
    approved({ lead_id: 'b.example', stage: 'Draft Ready' }),
    approved({ lead_id: 'c.example', send_status: 'TestSent' }),
    approved({ lead_id: 'd.example', send_status: 'Failed' }),
    approved({ lead_id: 'e.example', niche_id: 'other' }),
  ];
  assert.equal(run({ leads }).reason, 'no approved leads waiting');
});

test('oldest approval is sent first', () => {
  const leads = [approved({ lead_id: 'late.example', approved_at: '2026-10-12T12:00:00Z' }), approved({ lead_id: 'early.example', approved_at: '2026-10-11T12:00:00Z' })];
  assert.equal(run({ leads }).send.lead_id, 'early.example');
});

test('suppressed, already-contacted and failing drafts are skipped with a note, and the next lead is sent', () => {
  const suppressed = approved({ lead_id: 'sup.example', contact_email: 'info@sup.example', approved_at: '2026-10-10T00:00:00Z' });
  const contacted = approved({ lead_id: 'dup.example', contact_email: 'info@dup.example', approved_at: '2026-10-10T01:00:00Z' });
  const edited = approved({ lead_id: 'edit.example', contact_email: 'info@edit.example', approved_at: '2026-10-10T02:00:00Z' });
  edited.email_body = edited.email_body.replace(/Privacy notice: .*$/, '');
  const notPass = approved({ lead_id: 'np.example', contact_email: 'info@np.example', approved_at: '2026-10-10T03:00:00Z', draft_check_result: 'FAIL: x', email_body: 'x' });
  const good = approved({ lead_id: 'good.example', contact_email: 'info@good.example', approved_at: '2026-10-11T00:00:00Z' });
  const r = run({
    leads: [suppressed, contacted, edited, notPass, good],
    suppression: [{ email: 'info@sup.example', domain: '', reason: 'unsubscribe' }],
    sendLog: [{ lead_id: 'old.example', to_email: 'sales@dup.example', status: 'sent', attempted_at: '2026-09-01T10:00:00Z' }],
  });
  assert.equal(r.send.lead_id, 'good.example');
  const notes = Object.fromEntries(r.notes.map((n) => [n.lead_id, n.last_error]));
  assert.match(notes['sup.example'], /Suppression list/);
  assert.match(notes['dup.example'], /domain dup\.example was already emailed/);
  assert.match(notes['edit.example'], /draft re-check failed: .*signature\/footer/);
  assert.match(notes['np.example'], /draft_check_result is not PASS/);
  for (const n of r.notes) assert.deepEqual(Object.keys(n).sort(), [...W4.WF04_NOTE_COLUMNS].sort());
});

test('test sends never count as having contacted a lead', () => {
  const sendLog = [{ lead_id: 'agency-one.example', to_email: 'inbox@flowhq.example', status: 'test_sent', attempted_at: '2026-10-01T10:00:00Z' }];
  assert.equal(run({ sendLog }).action, 'send');
});

test('notes are not rewritten when the same reason is already recorded', () => {
  const s = approved({ contact_email: 'info@sup.example', lead_id: 'sup.example', last_error: 'Not sent: contact_email is on the Suppression list' });
  const r = run({ leads: [s], suppression: [{ email: 'info@sup.example', reason: 'manual' }] });
  assert.equal(r.notes.length, 0);
});

test('live mode honours LIVE_RECIPIENT_ALLOWLIST', () => {
  const blocked = run({ settings: { TEST_MODE: 'FALSE', LIVE_RECIPIENT_ALLOWLIST: 'me@flowhq.example' } });
  assert.equal(blocked.action, 'skip');
  assert.match(blocked.notes[0].last_error, /not on LIVE_RECIPIENT_ALLOWLIST/);
  const allowed = run({ settings: { TEST_MODE: 'FALSE', LIVE_RECIPIENT_ALLOWLIST: 'me@flowhq.example, info@agency-one.example' } });
  assert.equal(allowed.send.to, 'info@agency-one.example');
  assert.equal(allowed.send.subject.startsWith('[TEST]'), false);
});

// ---------- lock and results ----------

test('the lock must still carry this run\'s token', () => {
  const send = run().send;
  const locked = { ...approved(), ...W4.lockUpdate(send) };
  assert.equal(W4.verifyLock([locked], send).ok, true);
  assert.equal(W4.verifyLock([{ ...locked, last_updated: '2026-10-13T10:00:00.001Z' }], send).ok, false);
  assert.equal(W4.verifyLock([{ ...locked, send_status: 'Sent' }], send).ok, false);
  assert.equal(W4.verifyLock([], send).ok, false);
});

test('results write only real Leads and Send_Log columns', () => {
  const send = run().send;
  const ok = W4.recordSuccess(send, { id: 'm1', threadId: 't1' }, NOW);
  assert.deepEqual(Object.keys(ok.leadUpdate).sort(), [...W4.WF04_RESULT_COLUMNS].sort());
  assert.deepEqual(Object.keys(ok.logRow), TABS.Send_Log);
  assert.equal(ok.leadUpdate.send_status, 'TestSent');
  assert.equal(ok.leadUpdate.stage, 'Approved'); // a test send is not contact
  assert.equal(ok.logRow.status, 'test_sent');
  assert.equal(ok.logRow.test_mode, 'TRUE');

  const live = run({ settings: { TEST_MODE: 'FALSE' } }).send;
  const liveOk = W4.recordSuccess(live, { id: 'm2', threadId: 't2' }, NOW);
  assert.equal(liveOk.leadUpdate.send_status, 'Sent');
  assert.equal(liveOk.leadUpdate.stage, 'Contacted');
  assert.equal(liveOk.logRow.status, 'sent');
  assert.equal(liveOk.logRow.gmail_thread_id, 't2');

  const fail = W4.recordFailure(live, { message: 'invalid_grant' }, NOW);
  assert.equal(fail.leadUpdate.send_status, 'Failed');
  assert.equal(fail.leadUpdate.stage, 'Approved');
  assert.equal(fail.logRow.status, 'failed');
  assert.match(fail.alert, /lead_id=agency-one\.example/);
  assert.match(fail.leadUpdate.last_error, /invalid_grant/);
});
