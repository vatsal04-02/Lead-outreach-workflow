'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W5 = require('../src/wf05-replies-logic');
const W6 = require('../src/wf06-metrics-logic');
const { TABS } = require('../src/schema');
const { NOW, lead } = require('./helpers/fixtures');

const FOOTER_QUOTE = `On Tue, 13 Oct 2026 at 11:00, Test Sender <me@flowhq.example> wrote:
> Hi Jane,
> If you'd rather not hear from us, reply "unsubscribe" and we won't contact you again.`;

function contacted(overrides = {}) {
  return lead({ stage: 'Contacted', send_status: 'Sent', gmail_thread_id: 'thread-1', ...overrides });
}
const SEND_LOG = [
  { lead_id: 'agency-one.example', to_email: 'info@agency-one.example', status: 'sent', gmail_thread_id: 'thread-1', attempted_at: '2026-10-13T10:00:00Z' },
  { lead_id: 'agency-two.example', to_email: 'info@agency-two.example', status: 'test_sent', gmail_thread_id: 'thread-test', attempted_at: '2026-10-13T10:00:00Z' },
];

function msg(overrides = {}) {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    threadId: 'thread-1',
    subject: 'Re: Enquiry follow-up at Agency One Lettings',
    from: { value: [{ address: 'info@agency-one.example', name: 'Jane' }], text: 'Jane <info@agency-one.example>' },
    date: '2026-10-13T12:00:00.000Z',
    text: `Thanks, happy to chat next week.\n\n${FOOTER_QUOTE}`,
    headers: {},
    ...overrides,
  };
}

function run(messages, { leads = [contacted()], sendLog = SEND_LOG, suppression = [] } = {}) {
  return W5.processMessages({ leadsRows: leads, sendLogRows: sendLog, suppressionRows: suppression, messages, now: NOW });
}

test('a normal reply marks the lead Replied for review, ignoring the quoted footer', () => {
  const r = run([msg()]);
  assert.equal(r.suppressions.length, 0);
  const u = r.leadUpdates[0];
  assert.deepEqual(Object.keys(u).sort(), [...W5.WF05_COLUMNS].sort());
  assert.equal(u.stage, 'Replied');
  assert.equal(u.reply_status, 'replied');
  assert.equal(u.reply_category, 'needs_review');
  assert.equal(u.reply_received_at, '2026-10-13T12:00:00.000Z');
});

test('an opt-out suppresses email and domain and marks the lead Unsubscribed', () => {
  const r = run([msg({ text: `Please unsubscribe us.\n\n${FOOTER_QUOTE}` })]);
  assert.deepEqual(r.suppressions.map((s) => [s.email, s.domain, s.reason]), [['info@agency-one.example', 'agency-one.example', 'unsubscribe']]);
  for (const s of r.suppressions) assert.deepEqual(Object.keys(s), TABS.Suppression);
  assert.equal(r.leadUpdates[0].stage, 'Unsubscribed');
  assert.equal(r.leadUpdates[0].reply_category, 'unsubscribe');
});

test('opt-out phrasing variants and subject-line unsubscribes are recognised', () => {
  for (const t of ['Remove me from your list', 'please stop emailing us', "Don't contact us again", 'Opt out']) {
    assert.equal(run([msg({ text: t })]).leadUpdates[0].stage, 'Unsubscribed', t);
  }
  assert.equal(run([msg({ subject: 'Unsubscribe', text: '' })]).leadUpdates[0].stage, 'Unsubscribed');
});

test('a reply from a different address also suppresses that address', () => {
  const r = run([msg({ from: { value: [{ address: 'jane@agency-one-group.example' }] }, text: 'Unsubscribe' })]);
  assert.deepEqual(r.suppressions.map((s) => s.email).sort(), ['info@agency-one.example', 'jane@agency-one-group.example']);
});

test('bounces are suppressed using X-Failed-Recipients or the sent address', () => {
  const header = run([msg({ threadId: 'other', from: { value: [{ address: 'mailer-daemon@googlemail.com' }] }, subject: 'Delivery Status Notification (Failure)', headers: { 'x-failed-recipients': 'X-Failed-Recipients: info@agency-one.example' }, text: '' })]);
  assert.deepEqual(header.suppressions.map((s) => [s.email, s.reason]), [['info@agency-one.example', 'bounce']]);
  assert.equal(header.leadUpdates[0].reply_status, 'bounced');
  assert.equal(header.leadUpdates[0].stage, 'Contacted');
  const body = run([msg({ threadId: 'other', from: { value: [{ address: 'postmaster@mail.example' }] }, subject: 'Undeliverable', text: 'Your message to info@agency-one.example could not be delivered. reply "unsubscribe"' })]);
  assert.equal(body.suppressions[0].reason, 'bounce');
});

test('auto-replies are recorded but never override a real reply', () => {
  const ooo = msg({ subject: 'Automatic reply: Enquiry follow-up', text: 'I am out of the office.', headers: { 'auto-submitted': 'Auto-Submitted: auto-replied' } });
  const r = run([ooo]);
  assert.equal(r.leadUpdates[0].reply_status, 'auto_reply');
  assert.equal(r.leadUpdates[0].stage, 'Contacted');
  const both = run([msg({ date: '2026-10-13T12:00:00Z' }), { ...ooo, date: '2026-10-13T13:00:00Z' }]);
  assert.equal(both.leadUpdates[0].reply_status, 'replied');
  assert.equal(both.leadUpdates[0].stage, 'Replied');
});

test('an unsubscribe after a reply wins; a reply after an unsubscribe does not undo it', () => {
  const a = run([msg({ date: '2026-10-13T12:00:00Z' }), msg({ date: '2026-10-13T13:00:00Z', text: 'Actually, unsubscribe' })]);
  assert.equal(a.leadUpdates[0].stage, 'Unsubscribed');
  const b = run([msg({ date: '2026-10-13T12:00:00Z', text: 'unsubscribe' }), msg({ date: '2026-10-13T13:00:00Z', text: 'thanks' })]);
  assert.equal(b.leadUpdates[0].stage, 'Unsubscribed');
  assert.equal(b.leadUpdates[0].reply_status, 'unsubscribed');
});

test('human sales stages and categories are never overwritten', () => {
  const r = run([msg({ text: 'unsubscribe' })], { leads: [contacted({ stage: 'Proposal Sent', reply_category: 'positive', reply_status: 'replied', reply_received_at: '2026-10-13T11:00:00Z' })] });
  assert.equal(r.leadUpdates[0].stage, 'Proposal Sent');
  assert.match(r.leadUpdates[0].next_action, /review the open opportunity/);
  assert.equal(r.suppressions.length, 1);
  const k = run([msg({ text: 'more questions' })], { leads: [contacted({ stage: 'Replied', reply_category: 'positive', reply_status: 'replied', reply_received_at: '2026-10-13T11:00:00Z' })] });
  assert.equal(k.leadUpdates[0].reply_category, 'positive');
});

test('repeat runs are idempotent', () => {
  const first = run([msg({ text: 'unsubscribe' })]);
  const leadAfter = { ...contacted(), ...first.leadUpdates[0] };
  const second = run([msg({ text: 'unsubscribe' })], { leads: [leadAfter], suppression: first.suppressions });
  assert.equal(second.leadUpdates.length, 0);
  assert.equal(second.suppressions.length, 0);
  assert.equal(second.summary.alreadyProcessed, 1);
});

test('test sends and unknown threads are never matched; empty inbox is fine', () => {
  const r = run([msg({ threadId: 'thread-test', text: 'unsubscribe' }), msg({ threadId: 'nope' })]);
  assert.equal(r.leadUpdates.length, 0);
  assert.equal(r.suppressions.length, 0);
  assert.equal(r.summary.unmatched, 2);
  assert.equal(run([]).leadUpdates.length, 0);
  assert.equal(run([{}]).summary.messages, 0);
});

test('already-suppressed addresses are not appended twice', () => {
  const r = run([msg({ text: 'unsubscribe' })], { suppression: [{ email: 'info@agency-one.example', reason: 'manual' }] });
  assert.equal(r.suppressions.length, 0);
  assert.equal(r.leadUpdates[0].stage, 'Unsubscribed');
});

test('quoted history is removed before keyword matching', () => {
  assert.equal(W5.newContent(`Sounds good\n\n${FOOTER_QUOTE}`), 'Sounds good');
  assert.equal(W5.newContent('Ok\n-----Original Message-----\nunsubscribe'), 'Ok');
  assert.equal(W5.newContent('Ok\n> unsubscribe'), 'Ok');
});

// ---------- WF06 ----------

test('metrics are cumulative snapshots with exactly the Metrics columns', () => {
  const leads = [
    lead({ lead_id: 'a', stage: 'New Lead' }),
    lead({ lead_id: 'b', stage: 'Disqualified' }),
    lead({ lead_id: 'c', stage: 'Qualified' }),
    lead({ lead_id: 'd', stage: 'Contacted', approval_status: 'Approved' }),
    lead({ lead_id: 'e', stage: 'Replied', approval_status: 'Approved', reply_status: 'replied', reply_category: 'positive' }),
    lead({ lead_id: 'f', stage: 'Won', approval_status: 'Approved', reply_status: 'replied' }),
    lead({ lead_id: 'g', stage: 'Unsubscribed', approval_status: 'Approved', reply_status: 'unsubscribed' }),
    lead({ lead_id: 'h', stage: 'Draft Ready', approval_status: 'Rejected' }),
  ];
  const sendLog = [{ status: 'sent' }, { status: 'sent' }, { status: 'sent' }, { status: 'sent' }, { status: 'test_sent' }, { status: 'failed' }];
  const suppression = [{ email: 'x@g.example', reason: 'unsubscribe' }, { email: 'y@z.example', reason: 'bounce' }, { email: 'y@z.example', reason: 'bounce' }];
  const m = W6.computeMetrics({ leadsRows: leads, sendLogRows: sendLog, suppressionRows: suppression, now: '2026-10-13T20:00:00Z', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(Object.keys(m), TABS.Metrics);
  assert.equal(m.date, '2026-10-14'); // 01:30 IST next day
  assert.equal(m.new_leads, 8);
  assert.equal(m.qualified, 6);
  assert.equal(m.qualification_rate, 0.857);
  assert.equal(m.drafts_approved, 4);
  assert.equal(m.drafts_rejected, 1);
  assert.equal(m.emails_sent, 4);
  assert.equal(m.bounces, 1);
  assert.equal(m.bounce_rate, 0.25);
  assert.equal(m.unsubscribes, 1);
  assert.equal(m.replies, 3);
  assert.equal(m.positive_replies, 1);
  assert.equal(m.meetings_booked, 1);
  assert.equal(m.proposals_sent, 1);
  assert.equal(m.clients_won, 1);
  assert.equal(m.won_value, '');
});

test('metrics handle empty tabs and reject a bad time zone', () => {
  const m = W6.computeMetrics({ leadsRows: [{}], sendLogRows: [], suppressionRows: [], now: NOW, timeZone: 'Asia/Kolkata' });
  assert.equal(m.new_leads, 0);
  assert.equal(m.qualification_rate, '');
  assert.equal(m.bounce_rate, '');
  assert.throws(() => W6.computeMetrics({ leadsRows: [], sendLogRows: [], suppressionRows: [], now: NOW, timeZone: 'Nowhere' }), /not a valid IANA time zone/);
});
