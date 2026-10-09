'use strict';

// Company-registry verification, routed by the lead's country (WF02).
//
// Each country has an adapter with the same shape:
//   provider   identifier stored in Leads.registry_provider
//   live       true only when the official source has been implemented AND tested;
//              a non-live adapter never makes a request and always returns UNVERIFIED
//   plan(ctx)  -> { request_url, source_url, matched_by } or { skip }
//   evaluate(plan, response) -> verification result
//
// Results are deliberately conservative. No match, an ambiguous match, an API
// failure, an unsupported country or a non-live adapter all give UNVERIFIED, which
// means "we could not confirm it", never "the business does not exist".
// INELIGIBLE is used only when the registry record is identified by company
// number and itself says the company is not active or not an eligible type.
//
// Embedded into WF02's Code nodes after common.js (IMPORTS/EXPORT stripped).

// ---- IMPORTS (stripped when embedded in n8n) ----
const { text, clip, parseHost } = require('./common');
// ---- END IMPORTS ----

const REGISTRY_STATUS = {
  VERIFIED: 'VERIFIED',
  MANUAL_VERIFIED: 'MANUAL_VERIFIED',
  INELIGIBLE: 'INELIGIBLE',
  UNVERIFIED: 'UNVERIFIED',
};

// Leads columns that hold the registry result (appended to the end of Leads).
const REGISTRY_COLUMNS = [
  'registry_country', 'registry_provider', 'registry_status', 'registry_source_url',
  'registry_checked_at', 'registry_match_rationale',
];

const COUNTRY_ALIASES = {
  GB: ['gb', 'uk', 'united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'england and wales'],
  US: ['us', 'usa', 'united states', 'united states of america', 'u.s.', 'u.s.a.'],
  IN: ['in', 'ind', 'india', 'bharat'],
};

// ISO 3166-1 alpha-2 code, or '' if the value isn't recognisable.
function normaliseCountry(value) {
  const v = text(value).toLowerCase();
  if (!v) return '';
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) if (aliases.includes(v)) return code;
  return /^[a-z]{2}$/.test(v) ? v.toUpperCase() : '';
}

function errorMessage(response) {
  const e = response && response.error;
  if (!e) return '';
  return typeof e === 'string' ? e : text(e.message) || text(e.description) || JSON.stringify(e);
}

function normaliseCompanyName(name) {
  return text(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|limited|ltd|llp|plc|company|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseUkCompanyNumber(value) {
  const v = text(value).toUpperCase().replace(/\s+/g, '');
  if (/^\d{1,8}$/.test(v)) return v.padStart(8, '0');
  if (/^(SC|NI|OC|SO|NC|R0|NL|SL)\d{6}$/.test(v)) return v;
  return '';
}

// ---------- GB: Companies House (official, free API key) ----------

const CH_API = 'https://api.company-information.service.gov.uk';
const CH_WEB = 'https://find-and-update.company-information.service.gov.uk';
// Companies House `type` values that count as "limited company or LLP".
const UK_ELIGIBLE_TYPES = new Set([
  'ltd', 'llp', 'plc', 'private-limited-guarant-nsc', 'private-limited-guarant-nsc-limited-exemption',
  'private-limited-shares-section-30-exemption',
]);

const companiesHouse = {
  provider: 'companies_house',
  live: true,
  requestField: 'ch_request_url',
  plan({ companyName, companyNumber, numberSource }) {
    const number = normaliseUkCompanyNumber(companyNumber);
    if (number) {
      return {
        request_url: `${CH_API}/company/${encodeURIComponent(number)}`,
        source_url: `${CH_WEB}/company/${encodeURIComponent(number)}`,
        matched_by: `company number ${number} (${numberSource || 'given'})`,
        company_number: number,
      };
    }
    if (!text(companyName)) return { skip: 'no company name or company number to look up' };
    const q = encodeURIComponent(text(companyName));
    return {
      request_url: `${CH_API}/search/companies?q=${q}&items_per_page=5`,
      source_url: `${CH_WEB}/search/companies?q=${q}`,
      matched_by: 'exact company-name search',
      company_name: text(companyName),
    };
  },
  evaluate(plan, response) {
    const r = response || {};
    const err = errorMessage(r);
    if (err) {
      return { status: REGISTRY_STATUS.UNVERIFIED, rationale: `Companies House lookup by ${plan.matched_by} failed (${clip(err, 160)}). This does not mean the company is unregistered.` };
    }
    if (text(r.company_number) && text(r.company_status)) {
      const rec = { number: text(r.company_number), status: text(r.company_status), type: text(r.type), name: text(r.company_name) };
      const facts = `${rec.name || 'record'} (${rec.number}), status "${rec.status}", type "${rec.type}"`;
      const company = { company_number: rec.number, company_status: rec.status, legal_entity_type: rec.type };
      const sourceUrl = `${CH_WEB}/company/${encodeURIComponent(rec.number)}`;
      if (rec.status !== 'active') return { status: REGISTRY_STATUS.INELIGIBLE, rationale: `Matched by ${plan.matched_by}: ${facts}. Not active.`, company, sourceUrl };
      if (!UK_ELIGIBLE_TYPES.has(rec.type)) return { status: REGISTRY_STATUS.INELIGIBLE, rationale: `Matched by ${plan.matched_by}: ${facts}. Not a limited company or LLP.`, company, sourceUrl };
      return { status: REGISTRY_STATUS.VERIFIED, rationale: `Matched by ${plan.matched_by}: ${facts}.`, company, sourceUrl };
    }
    if (Array.isArray(r.items)) {
      const wanted = normaliseCompanyName(plan.company_name);
      const matches = r.items.filter((i) => i && normaliseCompanyName(i.title) === wanted);
      if (matches.length === 0) {
        return { status: REGISTRY_STATUS.UNVERIFIED, rationale: `No exact name match for "${plan.company_name}" among ${r.items.length} Companies House search result(s). The business may trade under a different legal name; this does not mean it is unregistered.` };
      }
      if (matches.length > 1) {
        return { status: REGISTRY_STATUS.UNVERIFIED, rationale: `Ambiguous: ${matches.length} Companies House companies share the name "${plan.company_name}" (${matches.map((m) => text(m.company_number)).join(', ')}).` };
      }
      const m = matches[0];
      const rec = { number: text(m.company_number), status: text(m.company_status), type: text(m.company_type), name: text(m.title) };
      const company = { company_number: rec.number, company_status: rec.status, legal_entity_type: rec.type };
      const sourceUrl = rec.number ? `${CH_WEB}/company/${encodeURIComponent(rec.number)}` : '';
      if (rec.status === 'active' && UK_ELIGIBLE_TYPES.has(rec.type)) {
        return { status: REGISTRY_STATUS.VERIFIED, rationale: `Exactly one Companies House result has the same name: ${rec.name} (${rec.number}), active, type "${rec.type}".`, company, sourceUrl };
      }
      // A name match is weaker than a number match: the inactive record may be a
      // different or former entity, so this is not proof of ineligibility.
      return { status: REGISTRY_STATUS.UNVERIFIED, rationale: `The only exact-name match is ${rec.name} (${rec.number}), status "${rec.status}", type "${rec.type}". It may be a different or former entity; check by hand.`, company, sourceUrl };
    }
    return { status: REGISTRY_STATUS.UNVERIFIED, rationale: 'Unexpected Companies House response; nothing could be confirmed.' };
  },
};

// ---------- US and IN: designed, not live ----------
// These adapters never make a request. They become live only when an official
// source, its terms and FlowHQ's credentials have been confirmed and tested.

const usStateRegistries = {
  provider: 'us_state_registry',
  live: false,
  plan() {
    return {
      skip: 'US company registration is held by each state (e.g. a Secretary of State business search). No official US registry source or credentials are configured for FlowHQ, so nothing was queried. Verify by hand with the relevant state registry.',
    };
  },
  evaluate() {
    return { status: REGISTRY_STATUS.UNVERIFIED, rationale: 'US registry adapter is not live.' };
  },
};

const indiaMca = {
  provider: 'mca_india',
  live: false,
  plan() {
    return {
      skip: "Indian company registration is held by the Ministry of Corporate Affairs (MCA). No official MCA data access or credentials are configured for FlowHQ, so nothing was queried. Verify by hand on the MCA portal.",
    };
  },
  evaluate() {
    return { status: REGISTRY_STATUS.UNVERIFIED, rationale: 'India registry adapter is not live.' };
  },
};

const REGISTRY_ADAPTERS = { GB: companiesHouse, US: usStateRegistries, IN: indiaMca };

// ---------- router ----------

// A human can record a manual check: registry_status = MANUAL_VERIFIED together
// with an http(s) registry_source_url and a registry_match_rationale.
function manualVerification(lead) {
  if (text(lead.registry_status) !== REGISTRY_STATUS.MANUAL_VERIFIED) return null;
  if (!parseHost(lead.registry_source_url, { requireScheme: true }) || !text(lead.registry_match_rationale)) return null;
  return lead;
}

function planRegistryLookup({ lead, country, companyNumber, numberSource }) {
  const code = normaliseCountry(country);
  const base = { country_code: code, provider: 'none', live: false, request_url: '', source_url: '', matched_by: '', skip: '' };
  const manual = manualVerification(lead || {});
  if (manual) return { ...base, provider: text(manual.registry_provider) || 'manual', manual: true };
  if (!code) return { ...base, skip: `Country "${text(country)}" is not recognised, so no registry could be chosen.` };
  const adapter = REGISTRY_ADAPTERS[code];
  if (!adapter) return { ...base, skip: `No registry adapter for country ${code}; registration was not checked.` };
  const plan = adapter.live ? adapter.plan({ companyName: lead && lead.company_name, companyNumber, numberSource }) : adapter.plan();
  return { ...base, ...plan, provider: adapter.provider, live: adapter.live, request_url: adapter.live && !plan.skip ? plan.request_url : '' };
}

// Turns a plan plus the HTTP response into the Leads registry columns.
function evaluateRegistry(plan, response, now) {
  const ts = text(now) || new Date().toISOString();
  const p = plan || {};
  const out = (status, rationale, sourceUrl, company) => ({
    registry_country: p.country_code || '',
    registry_provider: p.provider || 'none',
    registry_status: status,
    registry_source_url: text(sourceUrl),
    registry_checked_at: ts,
    registry_match_rationale: clip(rationale, 500),
    company: company || null,
  });
  if (p.manual) return { ...out(REGISTRY_STATUS.MANUAL_VERIFIED, '', '', null), manual: true };
  if (p.skip || !p.request_url) return out(REGISTRY_STATUS.UNVERIFIED, p.skip || 'No lookup was made.', '', null);
  const adapter = REGISTRY_ADAPTERS[p.country_code];
  const r = adapter.evaluate(p, response);
  return out(r.status, r.rationale, r.sourceUrl || p.source_url, r.company);
}

function isRegistryVerified(result) {
  return [REGISTRY_STATUS.VERIFIED, REGISTRY_STATUS.MANUAL_VERIFIED].includes(text(result && result.registry_status));
}

// A niche that names a legal-entity requirement needs a verified registry record.
function registryRequired(niche) {
  const v = text(niche && niche.legal_entity_required).toLowerCase();
  return Boolean(v) && v !== 'none';
}

// Leads columns to write: registry columns always, company columns when known.
// A manual verification keeps the human's values untouched.
function registryColumns(result, lead) {
  if (result.manual) {
    const keep = {};
    for (const c of REGISTRY_COLUMNS) keep[c] = lead[c] === undefined || lead[c] === null ? '' : lead[c];
    return keep;
  }
  const cols = {};
  for (const c of REGISTRY_COLUMNS) cols[c] = result[c];
  if (result.company) Object.assign(cols, result.company);
  return cols;
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = {
  REGISTRY_STATUS,
  REGISTRY_COLUMNS,
  REGISTRY_ADAPTERS,
  UK_ELIGIBLE_TYPES,
  normaliseCountry,
  normaliseCompanyName,
  normaliseUkCompanyNumber,
  manualVerification,
  planRegistryLookup,
  evaluateRegistry,
  isRegistryVerified,
  registryRequired,
  registryColumns,
};
