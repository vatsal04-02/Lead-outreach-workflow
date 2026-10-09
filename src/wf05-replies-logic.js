'use strict';

// WF05 Replies & Bounces: pure logic (docs/02-mvp-architecture.md §6).
//
// Embedded after common.js into the "Classify Messages" Code node of
// workflows/WF05-replies-bounces.json. IMPORTS and the EXPORT tail are stripped.
//
// Matches recent inbox messages to real (non-test) sends via the Gmail thread ID
// or, for bounces, the failed recipient address. Opt-outs and bounces are decided
// by keyword rules only (no AI reads private replies) and are suppressed
// immediately. Everything else is marked for a human to read.

// ---- IMPORTS (stripped when embedded in n8n) ----
const {
  STAGE, text, normaliseEmail, isValidEmail, registrableDomain, emailDomain, timeOf, realRows,
  buildSuppressionIndex, FREE_MAIL_DOMAINS, clip,
} = require('./lib/common');
// ---- END IMPORTS ----

const WF05_COLUMNS = ['lead_id', 'stage', 'reply_status', 'reply_received_at', 'reply_category', 'next_action', 'last_updated'];

const REPLY_STATUS = { REPLIED: 'replied', BOUNCED: 'bounced', UNSUBSCRIBED: 'unsubscribed', AUTO: 'auto_reply' };
const AUTO_CATEGORIES = new Set(['', 'needs_review', 'auto_reply', 'bounce', 'unsubscribe']);
// Stages a human has moved the lead into; WF05 never overwrites them.
const SALES_STAGES = new Set([STAGE.MEETING, STAGE.PROPOSAL, STAGE.WON, STAGE.LOST]);

const OPT_OUT = /\b(unsubscribe|remove me|take me off|opt[ -]?out|stop (?:emailing|contacting|sending|messaging)|do not (?:contact|email|e-mail)|don'?t (?:contact|email|e-mail)|no more (?:emails|e-mails|messages)|not interested,? (?:please )?(?:remove|stop))\b/i;
const AUTO_REPLY_SUBJECT = /\b(automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office|away from (?:the|my) office|on (?:annual )?leave|autoreply|abwesenheit)\b/i;
const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (?:subsystem|system))/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|delivery (?:has )?failed|failure notice|returned mail|mail delivery failed|could not be delivered)/i;

function headerValue(message, name) {
  const h = message.headers || {};
  const raw = h[name] || h[name.toLowerCase()];
  if (!raw) return '';
  const line = Array.isArray(raw) ? raw.join(', ') : String(raw);
  return line.replace(new RegExp(`^${name}\\s*:\\s*`, 'i'), '').trim();
}

function fromAddress(message) {
  const f = message.from;
  if (f && Array.isArray(f.value) && f.value[0]) return normaliseEmail(f.value[0].address);
  const m = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(typeof f === 'string' ? f : (f && f.text) || '');
  return m ? normaliseEmail(m[0]) : '';
}

// Only the newly written part of a reply: quoted history (which contains our own
// footer and its "unsubscribe" wording) must never trigger an opt-out.
function newContent(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^>/.test(l)) break;
    if (/^On .{4,200}wrote:?$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || /^_{10,}$/.test(l)) break;
    if (/^(From|Sent|De|Von):\s/i.test(l) && out.length) break;
    if (/^(?:Le|Am) .{4,200}(?:a écrit|schrieb)\s*:?$/i.test(l)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function classifyMessage(message, sentEmails) {
  const subject = text(message.subject);
  const from = fromAddress(message);
  if (BOUNCE_FROM.test(from) || BOUNCE_FROM.test(text(message.from && message.from.text)) || BOUNCE_SUBJECT.test(subject)) {
    const failed = [];
    const header = headerValue(message, 'X-Failed-Recipients');
    for (const e of header.split(/[,\s]+/)) if (isValidEmail(normaliseEmail(e))) failed.push(normaliseEmail(e));
    if (!failed.length) {
      for (const m of String(message.text || '').matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
        const e = normaliseEmail(m[0]);
        if (sentEmails.has(e)) failed.push(e);
      }
    }
    return { kind: 'bounce', failed: [...new Set(failed)] };
  }
  const autoSubmitted = headerValue(message, 'Auto-Submitted').toLowerCase();
  if ((autoSubmitted && autoSubmitted !== 'no') || headerValue(message, 'X-Autoreply') || headerValue(message, 'X-Autorespond') || AUTO_REPLY_SUBJECT.test(subject)) {
    return { kind: 'auto_reply' };
  }
  const fresh = newContent(message.text);
  if (OPT_OUT.test(fresh) || /\bunsubscribe\b/i.test(subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, ''))) return { kind: 'opt_out', from };
  return { kind: 'reply', from };
}

function messageTime(message) {
  const t = timeOf(message.date);
  if (Number.isFinite(t)) return t;
  const internal = Number(message.internalDate);
  return Number.isFinite(internal) && internal > 0 ? internal : NaN;
}

function processMessages({ leadsRows, sendLogRows, suppressionRows, messages, now }) {
  const ts = text(now) || new Date().toISOString();
  const leads = realRows(leadsRows);
  const leadById = new Map(leads.map((l) => [text(l.lead_id), l]));
  const byThread = new Map();
  const byEmail = new Map();
  for (const row of realRows(sendLogRows)) {
    if (text(row.status) !== 'sent') continue; // test sends are never matched
    if (text(row.gmail_thread_id)) byThread.set(text(row.gmail_thread_id), text(row.lead_id));
    if (text(row.to_email)) byEmail.set(normaliseEmail(row.to_email), text(row.lead_id));
  }
  const sentEmails = new Set(byEmail.keys());
  const existing = buildSuppressionIndex(realRows(suppressionRows));
  const alreadySuppressed = new Set(existing.suppressedEmails);

  const state = new Map(); // lead_id -> working copy of WF05 columns
  const suppressions = [];
  const summary = { messages: 0, matched: 0, unmatched: 0, alreadyProcessed: 0, replies: 0, optOuts: 0, bounces: 0, autoReplies: 0 };

  const working = (leadId) => {
    if (!state.has(leadId)) {
      const lead = leadById.get(leadId);
      const row = {};
      for (const c of WF05_COLUMNS) row[c] = lead[c] === undefined || lead[c] === null ? '' : lead[c];
      state.set(leadId, { row, changed: false, watermark: timeOf(lead.reply_received_at) });
    }
    return state.get(leadId);
  };
  const suppress = (email, domain, reason, source) => {
    const e = normaliseEmail(email);
    if (!isValidEmail(e) || alreadySuppressed.has(e)) return;
    alreadySuppressed.add(e);
    suppressions.push({ email: e, domain: text(domain), reason, source, added_at: ts });
  };

  const sorted = realRows(messages)
    .map((m) => ({ m, t: messageTime(m) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0));

  for (const { m, t } of sorted) {
    summary.messages += 1;
    const c = classifyMessage(m, sentEmails);
    let leadId = byThread.get(text(m.threadId)) || '';
    if (!leadId && c.kind === 'bounce') leadId = c.failed.map((e) => byEmail.get(e)).find(Boolean) || '';
    if (!leadId || !leadById.has(leadId)) { summary.unmatched += 1; continue; }
    summary.matched += 1;
    const w = working(leadId);
    // Already handled in an earlier run (idempotency watermark).
    if (Number.isFinite(t) && Number.isFinite(w.watermark) && t <= w.watermark) { summary.alreadyProcessed += 1; continue; }
    const when = Number.isFinite(t) ? new Date(t).toISOString() : ts;
    const lead = leadById.get(leadId);
    const r = w.row;
    const companyDomain = text(lead.lead_id);
    const source = `gmail:${text(m.id)}`;

    if (c.kind === 'bounce') {
      summary.bounces += 1;
      const failed = c.failed.length ? c.failed : [normaliseEmail(lead.contact_email)];
      failed.forEach((e) => suppress(e, '', 'bounce', source));
      if (r.reply_status !== REPLY_STATUS.UNSUBSCRIBED) {
        r.reply_status = REPLY_STATUS.BOUNCED;
        r.reply_category = 'bounce';
        r.next_action = 'Email bounced: check the address before any further contact';
      }
    } else if (c.kind === 'opt_out') {
      summary.optOuts += 1;
      suppress(lead.contact_email, companyDomain, 'unsubscribe', source);
      if (c.from && c.from !== normaliseEmail(lead.contact_email)) {
        const d = registrableDomain(emailDomain(c.from));
        suppress(c.from, FREE_MAIL_DOMAINS.has(d) ? '' : d, 'unsubscribe', source);
      }
      r.reply_status = REPLY_STATUS.UNSUBSCRIBED;
      r.reply_category = 'unsubscribe';
      if (SALES_STAGES.has(text(r.stage))) {
        r.next_action = 'Opt-out received: stop all marketing; review the open opportunity by hand';
      } else {
        r.stage = STAGE.UNSUBSCRIBED;
        r.next_action = 'Opt-out received: do not contact again';
      }
    } else if (c.kind === 'auto_reply') {
      summary.autoReplies += 1;
      // An auto-reply never overrides a real reply, bounce or opt-out.
      if (!text(r.reply_status)) {
        r.reply_status = REPLY_STATUS.AUTO;
        r.reply_category = 'auto_reply';
        r.next_action = 'Auto-reply received: no action needed';
      }
    } else {
      summary.replies += 1;
      if (r.reply_status !== REPLY_STATUS.UNSUBSCRIBED) {
        r.reply_status = REPLY_STATUS.REPLIED;
        if (AUTO_CATEGORIES.has(text(r.reply_category))) r.reply_category = 'needs_review';
        r.next_action = 'Read the reply in Gmail, then set reply_category (positive / neutral / negative) and the next stage';
        if (text(r.stage) === STAGE.CONTACTED) r.stage = STAGE.REPLIED;
      }
    }
    r.reply_received_at = when;
    r.last_updated = ts;
    w.watermark = Number.isFinite(t) ? t : w.watermark;
    w.changed = true;
  }

  const leadUpdates = [...state.values()].filter((w) => w.changed).map((w) => ({ ...w.row, next_action: clip(w.row.next_action, 300) }));
  return { leadUpdates, suppressions, summary };
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { WF05_COLUMNS, REPLY_STATUS, classifyMessage, newContent, processMessages };
