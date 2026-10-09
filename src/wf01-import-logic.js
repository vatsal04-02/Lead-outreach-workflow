'use strict';

// WF01 Import & Dedupe: pure logic.
//
// This file is embedded verbatim into the "Validate & Dedupe" Code node of
// workflows/WF01-import-dedupe.json by `npm run build` (everything after the
// EXPORT marker is stripped). Keep it free of `require` and of Node-only globals
// so it runs unchanged inside n8n's Code node sandbox.

const IMPORT_STATUS = {
  IMPORTED: 'IMPORTED',
  INVALID: 'REJECTED_INVALID',
  DUPLICATE: 'REJECTED_DUPLICATE',
  SUPPRESSED: 'REJECTED_SUPPRESSED',
};

// Columns a human fills in on the Import tab. A row with all of these blank is
// treated as an empty spreadsheet row and ignored.
const IMPORT_INPUT_FIELDS = [
  'company_name', 'website', 'city', 'region', 'contact_name', 'contact_role',
  'contact_email', 'email_source_url', 'phone', 'discovery_source',
  'discovery_source_url', 'discovered_at', 'notes',
];

// docs/02-mvp-architecture.md §6: "Rejects ... rows without email_source_url".
// An email without a source would break the "never guessed" rule, so both are required.
const REQUIRED_FIELDS = ['company_name', 'website', 'contact_email', 'email_source_url'];

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

function parseSettings(settingsRows) {
  const settings = {};
  for (const row of settingsRows || []) {
    const key = text(row && row.key);
    if (key) settings[key] = row.value;
  }
  return settings;
}

// Fails closed: an import without a valid, active niche is aborted entirely.
function resolveActiveNiche(settings, nichesRows) {
  const nicheId = text(settings.ACTIVE_NICHE);
  if (!nicheId) throw new Error('Settings.ACTIVE_NICHE is missing or blank; import aborted.');
  const niche = (nichesRows || []).find((n) => n && text(n.niche_id) === nicheId);
  if (!niche) throw new Error(`ACTIVE_NICHE "${nicheId}" has no row in the Niches tab; import aborted.`);
  if (!isTrue(niche.active)) throw new Error(`Niche "${nicheId}" is not active (Niches.active must be TRUE); import aborted.`);
  if (!text(niche.country)) throw new Error(`Niche "${nicheId}" has no country; import aborted.`);
  return { niche_id: nicheId, country: text(niche.country) };
}

function buildIndexes(leadsRows, suppressionRows) {
  const leadIds = new Map();
  const leadEmails = new Map();
  for (const row of leadsRows || []) {
    if (!row) continue;
    const id = text(row.lead_id).toLowerCase();
    if (id) leadIds.set(id, row.row_number);
    const email = normaliseEmail(row.contact_email);
    if (email) leadEmails.set(email, id || '(unknown lead_id)');
  }

  const suppressedEmails = new Set();
  const suppressedDomains = new Set();
  for (const row of suppressionRows || []) {
    if (!row) continue;
    const email = normaliseEmail(row.email);
    if (email) {
      suppressedEmails.add(email);
      // Domain-level suppression (architecture §3.4), except for shared mail providers.
      if (isValidEmail(email)) {
        const d = registrableDomain(emailDomain(email));
        if (!FREE_MAIL_DOMAINS.has(d)) suppressedDomains.add(d);
      }
    }
    const domain = registrableDomain(parseHost(row.domain));
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) suppressedDomains.add(domain);
  }
  return { leadIds, leadEmails, suppressedEmails, suppressedDomains };
}

function isEmptyImportRow(row) {
  return IMPORT_INPUT_FIELDS.every((f) => text(row[f]) === '');
}

function validateRow(row) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!text(row[field])) errors.push(`${field} is required`);
  }

  const websiteHost = text(row.website) ? parseHost(row.website) : '';
  if (text(row.website) && !websiteHost) errors.push('website is not a valid web address');

  const email = normaliseEmail(row.contact_email);
  if (email) {
    if (/[,;\s]/.test(email)) errors.push('contact_email must contain exactly one address');
    else if (!isValidEmail(email)) errors.push(`contact_email "${email}" is not a valid email address`);
  }

  const sourceHost = text(row.email_source_url) ? parseHost(row.email_source_url, { requireScheme: true }) : '';
  if (text(row.email_source_url) && !sourceHost) {
    errors.push('email_source_url must be a full http(s):// URL');
  }

  if (text(row.discovery_source_url) && !parseHost(row.discovery_source_url, { requireScheme: true })) {
    errors.push('discovery_source_url must be a full http(s):// URL');
  }

  const discoveredAt = normaliseDate(row.discovered_at);
  if (discoveredAt === null) errors.push('discovered_at is not a recognisable date (use YYYY-MM-DD)');

  return { errors, websiteHost, email, sourceHost, discoveredAt };
}

function warningsFor({ leadId, email, sourceHost, row }) {
  const warnings = [];
  const mailDomain = registrableDomain(emailDomain(email));
  if (FREE_MAIL_DOMAINS.has(mailDomain)) {
    warnings.push(`contact_email uses a shared mail provider (${mailDomain}); confirm the agency publishes it`);
  } else if (mailDomain !== leadId) {
    warnings.push(`contact_email domain (${mailDomain}) differs from website domain (${leadId})`);
  }
  if (registrableDomain(sourceHost) !== leadId) {
    warnings.push('email_source_url is not on the agency website; the ICP requires the email to be published on its own site');
  }
  if (!text(row.city)) warnings.push('city is blank');
  if (!text(row.discovery_source_url)) warnings.push('discovery_source_url is blank');
  return warnings;
}

function websiteUrl(raw) {
  const value = text(raw);
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// Main entry point. All inputs are arrays of row objects as returned by the
// n8n Google Sheets "Get Row(s)" operation (each with a `row_number`).
function processImport({ settingsRows, nichesRows, leadsRows, suppressionRows, importRows, now }) {
  const timestamp = text(now) || new Date().toISOString();
  const settings = parseSettings(settingsRows);
  const niche = resolveActiveNiche(settings, nichesRows);
  const idx = buildIndexes(leadsRows, suppressionRows);

  const leadsToAppend = [];
  const importUpdates = [];
  const summary = { imported: 0, invalid: 0, duplicate: 0, suppressed: 0, skippedAlreadyProcessed: 0, skippedEmpty: 0 };
  const batchIds = new Map();
  const batchEmails = new Map();

  for (const row of importRows || []) {
    if (!row || isEmptyImportRow(row)) {
      summary.skippedEmpty += 1;
      continue;
    }
    if (text(row.import_status)) {
      summary.skippedAlreadyProcessed += 1;
      continue;
    }
    if (row.row_number === undefined || row.row_number === null || row.row_number === '') {
      throw new Error('Import row is missing row_number; cannot write its status back. Import aborted.');
    }

    const update = (status, message, leadId = '') => {
      importUpdates.push({
        row_number: row.row_number,
        import_status: status,
        import_message: message,
        lead_id: leadId,
        processed_at: timestamp,
      });
    };

    const v = validateRow(row);
    if (v.errors.length) {
      summary.invalid += 1;
      update(IMPORT_STATUS.INVALID, v.errors.join('; '));
      continue;
    }

    const leadId = registrableDomain(v.websiteHost);
    const mailDomain = registrableDomain(emailDomain(v.email));

    if (idx.suppressedEmails.has(v.email)) {
      summary.suppressed += 1;
      update(IMPORT_STATUS.SUPPRESSED, 'contact_email is on the Suppression list', leadId);
      continue;
    }
    if (idx.suppressedDomains.has(leadId) || (!FREE_MAIL_DOMAINS.has(mailDomain) && idx.suppressedDomains.has(mailDomain))) {
      summary.suppressed += 1;
      update(IMPORT_STATUS.SUPPRESSED, 'domain is on the Suppression list', leadId);
      continue;
    }

    let duplicate = '';
    if (idx.leadIds.has(leadId)) duplicate = `lead_id ${leadId} already exists in Leads`;
    else if (idx.leadEmails.has(v.email)) duplicate = `contact_email already belongs to lead ${idx.leadEmails.get(v.email)} in Leads`;
    else if (batchIds.has(leadId)) duplicate = `same website as Import row ${batchIds.get(leadId)} in this run`;
    else if (batchEmails.has(v.email)) duplicate = `same contact_email as Import row ${batchEmails.get(v.email)} in this run`;
    if (duplicate) {
      summary.duplicate += 1;
      update(IMPORT_STATUS.DUPLICATE, duplicate, leadId);
      continue;
    }

    batchIds.set(leadId, row.row_number);
    batchEmails.set(v.email, row.row_number);

    leadsToAppend.push({
      lead_id: leadId,
      niche_id: niche.niche_id,
      country: niche.country,
      company_name: text(row.company_name),
      website: websiteUrl(row.website),
      city: text(row.city),
      region: text(row.region),
      contact_name: text(row.contact_name),
      contact_role: text(row.contact_role),
      contact_email: v.email,
      email_source_url: text(row.email_source_url),
      phone: text(row.phone),
      discovery_source: text(row.discovery_source),
      discovery_source_url: text(row.discovery_source_url),
      discovered_at: v.discoveredAt || timestamp,
      stage: 'New Lead',
      notes: text(row.notes),
      last_updated: timestamp,
    });
    summary.imported += 1;
    const warnings = warningsFor({ leadId, email: v.email, sourceHost: v.sourceHost, row });
    update(IMPORT_STATUS.IMPORTED, warnings.length ? `Warnings: ${warnings.join('; ')}` : 'OK', leadId);
  }

  return { leadsToAppend, importUpdates, summary, activeNiche: niche.niche_id };
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = {
  IMPORT_STATUS,
  REQUIRED_FIELDS,
  FREE_MAIL_DOMAINS,
  processImport,
  parseHost,
  registrableDomain,
  normaliseEmail,
  isValidEmail,
  normaliseDate,
  parseSettings,
  resolveActiveNiche,
  isTrue,
};
