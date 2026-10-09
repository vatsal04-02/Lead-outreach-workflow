'use strict';

// Shared helpers for every workflow's Code nodes.
//
// `npm run build` concatenates this file in front of each workflow module when it
// embeds them into n8n Code nodes (the EXPORT tail is stripped), so everything
// here must run unchanged inside n8n's Code-node sandbox: no `require`, no
// Node-only globals, and plain JavaScript only.

// Two-label public suffixes for the target countries. This is deliberately not
// the full Public Suffix List; anything not listed is treated as a one-label suffix.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'id.au', 'asn.au',
  'co.nz', 'org.nz', 'net.nz',
  'ab.ca', 'bc.ca', 'mb.ca', 'nb.ca', 'nl.ca', 'ns.ca', 'nt.ca', 'nu.ca', 'on.ca', 'pe.ca', 'qc.ca', 'sk.ca', 'yk.ca',
]);

// Shared mailbox providers. A suppressed address at one of these must never
// suppress every other user of the provider, and an agency using one gets a warning.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com',
  'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com',
  'aol.com', 'aol.co.uk', 'btinternet.com', 'btopenworld.com', 'sky.com', 'virginmedia.com',
  'talktalk.net', 'ntlworld.com', 'blueyonder.co.uk', 'mail.com', 'gmx.com', 'gmx.co.uk',
  'protonmail.com', 'proton.me', 'zoho.com', 'bigpond.com', 'optusnet.com.au', 'shaw.ca',
  'rogers.com', 'sympatico.ca',
]);

// Lead stages, exactly as in docs/02-mvp-architecture.md §4.
const STAGE = {
  NEW: 'New Lead',
  RESEARCHED: 'Researched',
  QUALIFIED: 'Qualified',
  DISQUALIFIED: 'Disqualified',
  DRAFT_READY: 'Draft Ready',
  APPROVED: 'Approved',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  MEETING: 'Meeting Opportunity',
  PROPOSAL: 'Proposal Sent',
  WON: 'Won',
  LOST: 'Lost',
  UNSUBSCRIBED: 'Unsubscribed',
};

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isTrue(value) {
  return value === true || text(value).toUpperCase() === 'TRUE';
}

// Returns the lower-cased hostname, or '' if the value is not a usable web address.
// With requireScheme, bare domains like "example.co.uk" are rejected.
function parseHost(value, { requireScheme = false } = {}) {
  const raw = text(value);
  if (!raw || /\s/.test(raw)) return '';
  const match = /^(?:(https?):\/\/)?([^/?#]+)(?:[/?#].*)?$/i.exec(raw);
  if (!match) return '';
  if (!match[1] && requireScheme) return '';
  let authority = match[2];
  if (authority.includes('@')) return '';
  authority = authority.replace(/:\d+$/, '');
  const host = authority.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return '';
  const labels = host.split('.');
  const labelOk = (l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l);
  if (!labels.every(labelOk)) return '';
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return '';
  return host;
}

function registrableDomain(host) {
  const h = text(host).toLowerCase().replace(/^www\./, '');
  if (!h) return '';
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function normaliseEmail(value) {
  return text(value).replace(/^mailto:/i, '').replace(/\?.*$/, '').trim().toLowerCase();
}

function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return false;
  return domain !== '' && parseHost(domain) === domain;
}

function emailDomain(email) {
  return email.slice(email.indexOf('@') + 1);
}

// Google Sheets may return a date cell as a serial day number (days since 1899-12-30).
function normaliseDate(value) {
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString();
  }
  const raw = text(value);
  if (!raw) return '';
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

// Milliseconds since epoch for a timestamp cell, or NaN.
function timeOf(value) {
  const d = normaliseDate(value);
  return d ? Date.parse(d) : NaN;
}

function parseSettings(settingsRows) {
  const settings = {};
  for (const row of settingsRows || []) {
    const key = text(row && row.key);
    if (key) settings[key] = row.value;
  }
  return settings;
}

// Fails closed: without a valid, active niche the calling workflow is aborted.
function resolveActiveNiche(settings, nichesRows, action = 'import') {
  const nicheId = text(settings.ACTIVE_NICHE);
  if (!nicheId) throw new Error(`Settings.ACTIVE_NICHE is missing or blank; ${action} aborted.`);
  const niche = (nichesRows || []).find((n) => n && text(n.niche_id) === nicheId);
  if (!niche) throw new Error(`ACTIVE_NICHE "${nicheId}" has no row in the Niches tab; ${action} aborted.`);
  if (!isTrue(niche.active)) throw new Error(`Niche "${nicheId}" is not active (Niches.active must be TRUE); ${action} aborted.`);
  if (!text(niche.country)) throw new Error(`Niche "${nicheId}" has no country; ${action} aborted.`);
  return { niche_id: nicheId, country: text(niche.country), row: niche };
}

// Suppression applies to the exact address and to the company domain, except
// that shared mail providers are never suppressed at domain level (§3.4).
function buildSuppressionIndex(suppressionRows) {
  const suppressedEmails = new Set();
  const suppressedDomains = new Set();
  for (const row of suppressionRows || []) {
    if (!row) continue;
    const email = normaliseEmail(row.email);
    if (email) {
      suppressedEmails.add(email);
      if (isValidEmail(email)) {
        const d = registrableDomain(emailDomain(email));
        if (!FREE_MAIL_DOMAINS.has(d)) suppressedDomains.add(d);
      }
    }
    const domain = registrableDomain(parseHost(row.domain));
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) suppressedDomains.add(domain);
  }
  return { suppressedEmails, suppressedDomains };
}

// Returns '' when the contact may be used, otherwise a reason string.
function suppressionReason(index, email, leadId) {
  const e = normaliseEmail(email);
  if (e && index.suppressedEmails.has(e)) return 'contact_email is on the Suppression list';
  const lead = text(leadId).toLowerCase();
  const mailDomain = e && e.includes('@') ? registrableDomain(emailDomain(e)) : '';
  if ((lead && index.suppressedDomains.has(lead)) || (mailDomain && !FREE_MAIL_DOMAINS.has(mailDomain) && index.suppressedDomains.has(mailDomain))) {
    return 'domain is on the Suppression list';
  }
  return '';
}

// Rows from a Sheets read, minus the empty {} item n8n emits for an empty tab.
function realRows(rows) {
  return (rows || []).filter((r) => r && Object.keys(r).length > 0);
}

// Calendar parts of an instant in an IANA time zone (Intl is available both in
// Node and in the n8n Code-node sandbox; Luxon is not needed).
function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: text(timeZone) || 'invalid/zone' });
    return true;
  } catch (e) {
    return false;
  }
}

function clip(value, max) {
  const s = text(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Evidence is stored in Leads.evidence as one line per item:  "quote" — url [signal]
function formatEvidence(items) {
  return (items || [])
    .map((e) => `"${text(e.quote).replace(/"/g, "'")}" — ${text(e.url)}${text(e.signal) ? ` [${text(e.signal)}]` : ''}`)
    .join('\n');
}

function parseEvidence(value) {
  const out = [];
  for (const line of text(value).split('\n')) {
    const m = /^"(.*)" — (\S+)(?: \[(.*)\])?$/.exec(line.trim());
    if (m) out.push({ quote: m[1], url: m[2], signal: m[3] || '' });
  }
  return out;
}

// Whole numbers 0..max written as digits (Sheets may return them as numbers).
function parseIntSetting(value, min, max) {
  const s = text(value);
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return n >= min && n <= max ? n : NaN;
}

// Index of the input item an n8n output item came from (HTTP Request and Gmail
// nodes replace an item's JSON, so later Code nodes recover context this way).
function pairedIndex(item, fallback) {
  const p = item && (Array.isArray(item.pairedItem) ? item.pairedItem[0] : item.pairedItem);
  return p && typeof p.item === 'number' ? p.item : fallback;
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = {
  MULTI_LABEL_SUFFIXES,
  FREE_MAIL_DOMAINS,
  STAGE,
  text,
  isTrue,
  parseHost,
  registrableDomain,
  normaliseEmail,
  isValidEmail,
  emailDomain,
  normaliseDate,
  timeOf,
  parseSettings,
  resolveActiveNiche,
  buildSuppressionIndex,
  suppressionReason,
  realRows,
  zonedParts,
  isValidTimeZone,
  clip,
  formatEvidence,
  parseEvidence,
  parseIntSetting,
  pairedIndex,
};
