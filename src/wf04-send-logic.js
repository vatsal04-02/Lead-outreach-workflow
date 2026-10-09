'use strict';

// WF04 Approved Sender: pure logic (docs/02-mvp-architecture.md §7).
//
// Embedded after common.js and drafting.js into the Code nodes of
// workflows/WF04-approved-sender.json. IMPORTS and the EXPORT tail are stripped.
//
// One run sends at most ONE email. Every gate fails closed: a missing or invalid
// setting, an unreadable tab, or any doubt means nothing is sent.

// ---- IMPORTS (stripped when embedded in n8n) ----
const {
  STAGE, text, registrableDomain, normaliseEmail, isValidEmail, emailDomain, timeOf, parseSettings,
  resolveActiveNiche, buildSuppressionIndex, suppressionReason, realRows, zonedParts, isValidTimeZone,
  clip, parseIntSetting, FREE_MAIL_DOMAINS,
} = require('./lib/common');
const { checkDraft, missingSenderSettings } = require('./lib/drafting');
// ---- END IMPORTS ----

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_DAILY_LIMIT = 100;
// After this many failed Gmail attempts in one day, sending pauses until tomorrow.
const MAX_FAILURES_PER_DAY = 2;
const SEND_STATUS = { SENDING: 'Sending', SENT: 'Sent', TEST_SENT: 'TestSent', FAILED: 'Failed' };
const LOG_STATUS = { SENT: 'sent', TEST_SENT: 'test_sent', FAILED: 'failed' };

const WF04_LOCK_COLUMNS = ['lead_id', 'send_status', 'last_updated'];
const WF04_RESULT_COLUMNS = ['lead_id', 'send_status', 'sent_at', 'gmail_message_id', 'gmail_thread_id', 'stage', 'last_updated', 'last_error'];
const WF04_NOTE_COLUMNS = ['lead_id', 'last_updated', 'last_error'];

// "exactly TRUE" (architecture §3.1). Sheets returns a ticked TRUE cell as boolean true.
function isExactlyTrue(v) {
  return v === true || (typeof v === 'string' && v.trim() === 'TRUE');
}

// Test mode stays on unless the value is exactly FALSE.
function isTestMode(v) {
  return !(v === false || (typeof v === 'string' && v.trim() === 'FALSE'));
}

function parseClock(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text(v));
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : NaN;
}

function parseEmailList(v) {
  return text(v).split(/[,;\s]+/).map(normaliseEmail).filter(Boolean);
}

// Validates every setting the sender depends on. Throws (→ WF00 alert) on bad config.
function sendingConfig(settings, nichesRows) {
  const problems = [];
  const niche = resolveActiveNiche(settings, nichesRows, 'sending');
  const tz = text(niche.row.timezone);
  if (!isValidTimeZone(tz)) problems.push(`Niches.timezone "${tz}" is not a valid IANA time zone`);
  const dailyLimit = parseIntSetting(settings.DAILY_SEND_LIMIT, 1, MAX_DAILY_LIMIT);
  if (Number.isNaN(dailyLimit)) problems.push(`DAILY_SEND_LIMIT must be a whole number from 1 to ${MAX_DAILY_LIMIT}`);
  const spacing = parseIntSetting(settings.MIN_MINUTES_BETWEEN_SENDS, 0, 1440);
  if (Number.isNaN(spacing)) problems.push('MIN_MINUTES_BETWEEN_SENDS must be a whole number from 0 to 1440');
  const days = text(settings.SEND_DAYS).split(/[,\s]+/).filter(Boolean);
  if (!days.length || days.some((d) => !DAYS.includes(d))) problems.push(`SEND_DAYS must list days from ${DAYS.join(',')}`);
  const start = parseClock(settings.SEND_WINDOW_START);
  const end = parseClock(settings.SEND_WINDOW_END);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) problems.push('SEND_WINDOW_START/SEND_WINDOW_END must be HH:MM with start before end');
  const testMode = isTestMode(settings.TEST_MODE);
  const testRecipient = normaliseEmail(settings.TEST_RECIPIENT);
  if (testMode && !isValidEmail(testRecipient)) problems.push('TEST_MODE is on but TEST_RECIPIENT is not a valid email address');
  const allowlist = parseEmailList(settings.LIVE_RECIPIENT_ALLOWLIST);
  if (allowlist.some((e) => !isValidEmail(e))) problems.push('LIVE_RECIPIENT_ALLOWLIST contains an invalid email address');
  const missing = missingSenderSettings(settings);
  if (missing.length) problems.push(`missing settings: ${missing.join(', ')}`);
  if (problems.length) throw new Error(`Sending blocked by configuration: ${problems.join('; ')}.`);
  return { niche, tz, dailyLimit, spacing, days, start, end, testMode, testRecipient, allowlist };
}

// Counts today's attempts from both the Send_Log and the Leads tab, so a failed
// Send_Log append can't let the daily cap be exceeded.
function todaysActivity(cfg, leadsRows, sendLogRows, nowMs) {
  const today = zonedParts(nowMs, cfg.tz).date;
  const isToday = (ms) => Number.isFinite(ms) && zonedParts(ms, cfg.tz).date === today;
  const sentLeads = new Set();
  let failures = 0;
  let lastAttempt = NaN;
  for (const row of sendLogRows) {
    const t = timeOf(row.attempted_at);
    if (Number.isFinite(t) && !(t <= lastAttempt)) lastAttempt = t;
    if (!isToday(t)) continue;
    const s = text(row.status);
    if (s === LOG_STATUS.SENT || s === LOG_STATUS.TEST_SENT) sentLeads.add(text(row.lead_id) || `row:${row.row_number}`);
    if (s === LOG_STATUS.FAILED) failures += 1;
  }
  for (const lead of leadsRows) {
    const s = text(lead.send_status);
    const t = s === SEND_STATUS.SENDING ? timeOf(lead.last_updated) : timeOf(lead.sent_at);
    if ([SEND_STATUS.SENDING, SEND_STATUS.SENT, SEND_STATUS.TEST_SENT].includes(s)) {
      if (Number.isFinite(t) && !(t <= lastAttempt)) lastAttempt = t;
      if (isToday(t)) sentLeads.add(text(lead.lead_id));
    }
  }
  return { sentToday: sentLeads.size, failuresToday: failures, lastAttempt };
}

// Has this address or company already received a real email?
function previouslyContacted(sendLogRows, leadsRows, lead) {
  const email = normaliseEmail(lead.contact_email);
  const leadId = text(lead.lead_id).toLowerCase();
  const mailDomain = registrableDomain(emailDomain(email));
  const companyDomains = new Set([leadId]);
  if (mailDomain && !FREE_MAIL_DOMAINS.has(mailDomain)) companyDomains.add(mailDomain);
  for (const row of sendLogRows) {
    if (text(row.status) !== LOG_STATUS.SENT) continue;
    const to = normaliseEmail(row.to_email);
    const toDomain = registrableDomain(emailDomain(to));
    if (to === email) return `a real email was already sent to ${email}`;
    if (text(row.lead_id).toLowerCase() === leadId) return `lead ${leadId} was already emailed`;
    if (!FREE_MAIL_DOMAINS.has(toDomain) && companyDomains.has(toDomain)) return `domain ${toDomain} was already emailed`;
  }
  for (const other of leadsRows) {
    if (other === lead || text(other.lead_id).toLowerCase() === leadId) continue;
    if (text(other.send_status) === SEND_STATUS.SENT && normaliseEmail(other.contact_email) === email) return `${email} was already emailed as lead ${text(other.lead_id)}`;
  }
  return '';
}

function gateAndPick({ settingsRows, nichesRows, leadsRows, suppressionRows, sendLogRows, now }) {
  const nowIso = text(now) || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const settings = parseSettings(realRows(settingsRows));
  const leads = realRows(leadsRows);
  const sendLog = realRows(sendLogRows);
  const skip = (reason, extra = {}) => ({ action: 'skip', reason, notes: [], ...extra });

  // 1. Global kill switch, checked before anything else.
  if (!isExactlyTrue(settings.SENDING_ENABLED)) return skip('SENDING_ENABLED is not TRUE');

  // 2. Configuration (throws on anything invalid).
  const cfg = sendingConfig(settings, realRows(nichesRows));

  // 3. Allowed day and sending window, in the niche's time zone.
  const local = zonedParts(nowMs, cfg.tz);
  if (!cfg.days.includes(local.weekday)) return skip(`${local.weekday} is not in SEND_DAYS (${cfg.tz})`);
  if (local.minutes < cfg.start || local.minutes >= cfg.end) return skip(`outside the sending window ${text(settings.SEND_WINDOW_START)}-${text(settings.SEND_WINDOW_END)} ${cfg.tz}`);

  // 4. Daily cap, failure breaker and spacing.
  const activity = todaysActivity(cfg, leads, sendLog, nowMs);
  if (activity.sentToday >= cfg.dailyLimit) return skip(`daily limit reached (${activity.sentToday}/${cfg.dailyLimit})`);
  if (activity.failuresToday >= MAX_FAILURES_PER_DAY) return skip(`${activity.failuresToday} failed sends today; sending paused until tomorrow`);
  if (Number.isFinite(activity.lastAttempt) && nowMs - activity.lastAttempt < cfg.spacing * 60000) {
    return skip(`last send was less than ${cfg.spacing} minutes ago`);
  }
  const stuck = leads.find((l) => text(l.send_status) === SEND_STATUS.SENDING);
  if (stuck) return skip(`lead ${text(stuck.lead_id)} is stuck in "Sending"; check Gmail's Sent folder and resolve it by hand before more emails go out`);

  // 5. Candidates, oldest approval first, each re-checked right now.
  const sup = buildSuppressionIndex(realRows(suppressionRows));
  const candidates = leads
    .filter((l) => text(l.stage) === STAGE.APPROVED && text(l.approval_status) === 'Approved' && !text(l.send_status) && text(l.niche_id) === cfg.niche.niche_id)
    .sort((a, b) => (timeOf(a.approved_at) || 0) - (timeOf(b.approved_at) || 0) || Number(a.row_number || 0) - Number(b.row_number || 0));

  const notes = [];
  const block = (lead, reason) => {
    const msg = clip(`Not sent: ${reason}`, 300);
    if (text(lead.last_error) !== msg) notes.push({ lead_id: text(lead.lead_id), last_updated: nowIso, last_error: msg });
  };
  for (const lead of candidates) {
    const email = normaliseEmail(lead.contact_email);
    if (!isValidEmail(email)) { block(lead, 'contact_email is not valid'); continue; }
    if (!text(lead.draft_check_result).startsWith('PASS')) { block(lead, 'draft_check_result is not PASS'); continue; }
    const supReason = suppressionReason(sup, email, lead.lead_id);
    if (supReason) { block(lead, supReason); continue; }
    const prior = previouslyContacted(sendLog, leads, lead);
    if (prior) { block(lead, prior); continue; }
    const check = checkDraft({ subject: lead.email_subject, body: lead.email_body, lead, niche: cfg.niche.row, settings, templateId: lead.template_id });
    if (!check.pass) { block(lead, `draft re-check failed: ${check.reasons.join('; ')}`); continue; }
    if (!cfg.testMode && cfg.allowlist.length && !cfg.allowlist.includes(email)) { block(lead, `${email} is not on LIVE_RECIPIENT_ALLOWLIST`); continue; }

    const to = cfg.testMode ? cfg.testRecipient : email;
    return {
      action: 'send',
      reason: cfg.testMode ? `TEST_MODE: redirected to ${to}` : 'live send',
      notes,
      send: {
        lead_id: text(lead.lead_id),
        to,
        intended_to: email,
        subject: cfg.testMode ? `[TEST] ${text(lead.email_subject)}` : text(lead.email_subject),
        body: cfg.testMode
          ? `TEST MODE: in live mode this email would go to ${email}.\n------------------------------------------\n\n${String(lead.email_body).trim()}`
          : String(lead.email_body).trim(),
        sender_name: text(settings.SENDER_NAME),
        test_mode: cfg.testMode,
        lock_token: nowIso,
        stage_before: text(lead.stage),
      },
    };
  }
  return skip(candidates.length ? 'no approved lead passed the pre-send checks' : 'no approved leads waiting', { notes });
}

// The lock is ours only if the row still shows our exact token.
function verifyLock(leadsRows, send) {
  const row = realRows(leadsRows).find((l) => text(l.lead_id) === send.lead_id);
  if (!row) return { ok: false, reason: `lead ${send.lead_id} not found after locking` };
  if (text(row.send_status) !== SEND_STATUS.SENDING || text(row.last_updated) !== send.lock_token) {
    return { ok: false, reason: `lock for ${send.lead_id} is held by another run (send_status "${text(row.send_status)}")` };
  }
  return { ok: true };
}

function lockUpdate(send) {
  return { lead_id: send.lead_id, send_status: SEND_STATUS.SENDING, last_updated: send.lock_token };
}

function recordSuccess(send, gmail, now) {
  const ts = text(now) || new Date().toISOString();
  const g = gmail || {};
  const status = send.test_mode ? SEND_STATUS.TEST_SENT : SEND_STATUS.SENT;
  return {
    leadUpdate: {
      lead_id: send.lead_id,
      send_status: status,
      sent_at: ts,
      gmail_message_id: text(g.id),
      gmail_thread_id: text(g.threadId),
      // A test send never counts as contacting the lead.
      stage: send.test_mode ? send.stage_before : STAGE.CONTACTED,
      last_updated: ts,
      last_error: '',
    },
    logRow: {
      lead_id: send.lead_id,
      to_email: send.to,
      subject: send.subject,
      attempted_at: ts,
      status: send.test_mode ? LOG_STATUS.TEST_SENT : LOG_STATUS.SENT,
      gmail_message_id: text(g.id),
      gmail_thread_id: text(g.threadId),
      test_mode: send.test_mode ? 'TRUE' : 'FALSE',
      error: '',
    },
  };
}

function recordFailure(send, error, now) {
  const ts = text(now) || new Date().toISOString();
  const e = error || {};
  const message = clip(typeof e === 'string' ? e : text(e.message) || text(e.description) || JSON.stringify(e), 300);
  return {
    leadUpdate: {
      lead_id: send.lead_id,
      send_status: SEND_STATUS.FAILED,
      sent_at: '',
      gmail_message_id: '',
      gmail_thread_id: '',
      stage: send.stage_before,
      last_updated: ts,
      last_error: `Gmail send failed: ${message}`,
    },
    logRow: {
      lead_id: send.lead_id,
      to_email: send.to,
      subject: send.subject,
      attempted_at: ts,
      status: LOG_STATUS.FAILED,
      gmail_message_id: '',
      gmail_thread_id: '',
      test_mode: send.test_mode ? 'TRUE' : 'FALSE',
      error: message,
    },
    alert: `Gmail send failed for lead_id=${send.lead_id}: ${message}. The lead is marked Failed and will not be retried automatically.`,
  };
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = {
  SEND_STATUS,
  LOG_STATUS,
  MAX_FAILURES_PER_DAY,
  WF04_LOCK_COLUMNS,
  WF04_RESULT_COLUMNS,
  WF04_NOTE_COLUMNS,
  isExactlyTrue,
  isTestMode,
  sendingConfig,
  gateAndPick,
  verifyLock,
  lockUpdate,
  recordSuccess,
  recordFailure,
};
