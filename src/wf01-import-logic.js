'use strict';

// WF01 Import & Dedupe: pure logic.
//
// `npm run build` embeds src/lib/common.js followed by this file into the
// "Validate & Dedupe" Code node of workflows/WF01-import-dedupe.json. The IMPORTS
// block and everything after the EXPORT marker are stripped when embedding, so
// keep the rest free of `require` and of Node-only globals.

// ---- IMPORTS (stripped when embedded in n8n) ----
const {
  FREE_MAIL_DOMAINS, text, isTrue, parseHost, registrableDomain, normaliseEmail, isValidEmail,
  emailDomain, normaliseDate, parseSettings, resolveActiveNiche, buildSuppressionIndex, suppressionReason,
} = require('./lib/common');
// ---- END IMPORTS ----

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
  return { leadIds, leadEmails, suppression: buildSuppressionIndex(suppressionRows) };
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

    const suppressed = suppressionReason(idx.suppression, v.email, leadId);
    if (suppressed) {
      summary.suppressed += 1;
      update(IMPORT_STATUS.SUPPRESSED, suppressed, leadId);
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
