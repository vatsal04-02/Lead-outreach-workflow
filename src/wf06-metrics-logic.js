'use strict';

// WF06 Daily Metrics: pure logic (docs/02-mvp-architecture.md §8).
//
// Each Metrics row is a snapshot of cumulative totals on its date; the change
// between two rows is that period's activity. Re-running on the same day
// replaces that day's row (append-or-update on `date`), so it is idempotent.

// ---- IMPORTS (stripped when embedded in n8n) ----
const { STAGE, text, normaliseEmail, realRows, zonedParts, isValidTimeZone } = require('./lib/common');
// ---- END IMPORTS ----

const QUALIFIED_OR_LATER = new Set([
  STAGE.QUALIFIED, STAGE.DRAFT_READY, STAGE.APPROVED, STAGE.CONTACTED, STAGE.REPLIED,
  STAGE.MEETING, STAGE.PROPOSAL, STAGE.WON, STAGE.LOST, STAGE.UNSUBSCRIBED,
]);
const RESEARCHED_OR_LATER = new Set([...QUALIFIED_OR_LATER, STAGE.RESEARCHED, STAGE.NEEDS_REVIEW, STAGE.DISQUALIFIED]);

function ratio(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 1000 : '';
}

function computeMetrics({ leadsRows, sendLogRows, suppressionRows, now, timeZone }) {
  const tz = text(timeZone);
  if (!isValidTimeZone(tz)) throw new Error(`metrics_timezone "${tz}" in the Config node is not a valid IANA time zone.`);
  const ms = Date.parse(text(now) || new Date().toISOString());
  const leads = realRows(leadsRows);
  const stage = (l) => text(l.stage);
  const count = (pred) => leads.filter(pred).length;
  const uniqueEmails = (reason) => new Set(realRows(suppressionRows).filter((r) => text(r.reason) === reason).map((r) => normaliseEmail(r.email)).filter(Boolean)).size;

  const qualified = count((l) => QUALIFIED_OR_LATER.has(stage(l)));
  const researched = count((l) => RESEARCHED_OR_LATER.has(stage(l)));
  const emailsSent = realRows(sendLogRows).filter((r) => text(r.status) === 'sent').length;
  const bounces = uniqueEmails('bounce');

  return {
    date: zonedParts(ms, tz).date,
    new_leads: leads.length,
    qualified,
    qualification_rate: ratio(qualified, researched),
    drafts_approved: count((l) => text(l.approval_status) === 'Approved'),
    drafts_rejected: count((l) => text(l.approval_status) === 'Rejected'),
    emails_sent: emailsSent,
    bounces,
    bounce_rate: ratio(bounces, emailsSent),
    unsubscribes: uniqueEmails('unsubscribe'),
    replies: count((l) => ['replied', 'unsubscribed'].includes(text(l.reply_status))),
    positive_replies: count((l) => text(l.reply_category) === 'positive'),
    meetings_booked: count((l) => [STAGE.MEETING, STAGE.PROPOSAL, STAGE.WON].includes(stage(l))),
    proposals_sent: count((l) => [STAGE.PROPOSAL, STAGE.WON].includes(stage(l))),
    clients_won: count((l) => stage(l) === STAGE.WON),
    // The Leads tab has no deal-value column, so this stays blank until one is agreed.
    won_value: '',
    discovered: count((l) => text(l.discovery_status) === 'DISCOVERED'),
    researched: count((l) => ['RESEARCHED', 'NEEDS_REVIEW'].includes(text(l.research_status))),
    needs_review: count((l) => stage(l) === STAGE.NEEDS_REVIEW),
    send_failures: realRows(sendLogRows).filter((r) => text(r.status) === 'failed').length,
  };
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { computeMetrics };
