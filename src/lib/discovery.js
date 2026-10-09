'use strict';

// Business discovery through the OpenStreetMap Overpass API (WF02).
//
// Provider: OpenStreetMap data via an Overpass API instance (default
// https://overpass-api.de/api/interpreter, configurable in WF02's Config node).
// - No API key. Open data under the ODbL (attribution: "© OpenStreetMap contributors").
// - Supplies business names, websites, addresses and category tags. Coverage is
//   uneven and incomplete; zero results never mean "no such businesses".
// - Public instances have a fair-use policy; WF02 runs few, small, rate-limited
//   queries and records each one in the Discovery_Log tab so they rotate.
// The provider interface is plan → HTTP request → normalise; another provider can
// replace it by implementing the same two functions.

// ---- IMPORTS (stripped when embedded in n8n) ----
const {
  STAGE, text, isTrue, parseHost, businessKey, isNonResearchableSite, normaliseCountry, listSetting,
  buildSuppressionIndex, suppressionReason, realRows, timeOf, clip, parseIntSetting, parseSettings, resolveActiveNiche,
} = require('./common');
const { campaignCategories, categoryForTags } = require('./categories');
// ---- END IMPORTS ----

const PROVIDER = 'osm_overpass';
const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const REGION_PATTERN = /^[\p{L}\p{N} .,'()&-]{2,80}$/u;

function queryKey(nicheId, region, category) {
  return `${nicheId}|${region}|${category}`.toLowerCase();
}

function escapeOverpass(s) {
  return text(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Overpass QL: businesses with a website, matching the category filters, inside
// the named administrative area of the given country.
function overpassQuery({ countryCode, region, filters, limit }) {
  const selectors = [];
  for (const f of filters) {
    const tag = f.value ? `["${escapeOverpass(f.key)}"="${escapeOverpass(f.value)}"]` : `["${escapeOverpass(f.key)}"]`;
    for (const site of ['website', 'contact:website']) selectors.push(`  nwr${tag}["${site}"](area.searchArea);`);
  }
  return [
    '[out:json][timeout:60];',
    `area["ISO3166-1"="${escapeOverpass(countryCode)}"]["admin_level"="2"]->.country;`,
    `rel(area.country)["boundary"="administrative"]["name"="${escapeOverpass(region)}"];`,
    'map_to_area->.searchArea;',
    '(',
    ...selectors,
    ');',
    `out center tags ${limit};`,
  ].join('\n');
}

// Chooses which (region × category) searches to run now. Never-run searches go
// first, then the oldest; completed searches are repeated only after
// DISCOVERY_REFRESH_DAYS; failed ones are retried on the next run.
function planDiscovery({ settings, niche, discoveryLogRows, overpassUrl, now }) {
  const none = (reason) => ({ queries: [], skipReason: reason });
  if (!isTrue(settings.DISCOVERY_ENABLED)) return none('DISCOVERY_ENABLED is not TRUE');
  const row = niche.row || {};
  if (text(row.discovery_provider) !== PROVIDER) return none(`campaign discovery_provider is "${text(row.discovery_provider) || 'blank'}" (set it to ${PROVIDER} to discover)`);
  const problems = [];
  const countryCode = normaliseCountry(row.country);
  if (!countryCode) problems.push(`campaign country "${text(row.country)}" is not recognised`);
  const regions = listSetting(row.regions);
  if (!regions.length) problems.push('campaign regions is blank (list cities or areas, separated by ;)');
  for (const r of regions) if (!REGION_PATTERN.test(r)) problems.push(`region "${r}" contains unsupported characters`);
  const { categories, problems: catProblems } = campaignCategories(row);
  problems.push(...catProblems);
  if (!categories.length) problems.push('campaign has no discoverable industries');
  const perRun = parseIntSetting(settings.DISCOVERY_QUERIES_PER_RUN, 1, 10);
  if (Number.isNaN(perRun)) problems.push('DISCOVERY_QUERIES_PER_RUN must be a whole number from 1 to 10');
  const refreshDays = parseIntSetting(settings.DISCOVERY_REFRESH_DAYS, 1, 365);
  if (Number.isNaN(refreshDays)) problems.push('DISCOVERY_REFRESH_DAYS must be a whole number from 1 to 365');
  const maxNew = parseIntSetting(row.max_discovered_per_run || '20', 1, 200);
  if (Number.isNaN(maxNew)) problems.push('campaign max_discovered_per_run must be a whole number from 1 to 200');
  const url = text(overpassUrl) || DEFAULT_OVERPASS_URL;
  if (!parseHost(url, { requireScheme: true })) problems.push(`overpass_url "${url}" is not a valid URL`);
  if (problems.length) throw new Error(`Discovery configuration problem: ${problems.join('; ')}. Fix the campaign row or Settings, or set DISCOVERY_ENABLED to FALSE.`);

  const lastRun = new Map();
  for (const r of realRows(discoveryLogRows)) {
    const k = text(r.query_key).toLowerCase();
    const t = timeOf(r.run_at);
    if (!k || !Number.isFinite(t)) continue;
    const prev = lastRun.get(k);
    if (!prev || t > prev.t) lastRun.set(k, { t, status: text(r.status) });
  }
  const nowMs = Date.parse(text(now) || new Date().toISOString());
  const due = [];
  for (const region of regions) {
    for (const c of categories) {
      const key = queryKey(niche.niche_id, region, c.category);
      const prev = lastRun.get(key);
      const isDue = !prev || prev.status === 'FAILED' || nowMs - prev.t >= refreshDays * 86400000;
      if (isDue) due.push({ key, region, category: c.category, filters: c.filters, last: prev ? prev.t : -1 });
    }
  }
  due.sort((a, b) => a.last - b.last);
  const limit = Math.min(200, maxNew * 3);
  const queries = due.slice(0, perRun).map((q) => {
    const ql = overpassQuery({ countryCode, region: q.region, filters: q.filters, limit });
    return {
      query_key: q.key,
      niche_id: niche.niche_id,
      provider: PROVIDER,
      country: countryCode,
      region: q.region,
      category: q.category,
      request_url: `${url}?data=${encodeURIComponent(ql)}`,
    };
  });
  return { queries, skipReason: queries.length ? '' : 'every search for this campaign ran within DISCOVERY_REFRESH_DAYS', maxNew };
}

function websiteOf(tags) {
  const raw = text(tags.website || tags['contact:website'] || tags.url);
  if (!raw) return '';
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return parseHost(url, { requireScheme: true }) ? url : '';
}

// Turns Overpass responses into new Leads rows (deduplicated, suppression-checked)
// and one Discovery_Log row per query.
function normaliseDiscoveries({ queries, responses, leadsRows, suppressionRows, niche, maxNew, now }) {
  const ts = text(now) || new Date().toISOString();
  const known = new Set(realRows(leadsRows).map((l) => text(l.lead_id).toLowerCase()).filter(Boolean));
  const sup = buildSuppressionIndex(realRows(suppressionRows));
  const { categories } = campaignCategories(niche.row || {});
  const newLeads = [];
  const logRows = [];
  queries.forEach((q, i) => {
    const r = responses[i] || {};
    const log = { query_key: q.query_key, niche_id: q.niche_id, provider: q.provider, country: q.country, region: q.region, category: q.category, run_at: ts, status: 'OK', results: 0, new_leads: 0, duplicates: 0, skipped: 0, error: '' };
    const err = r.error ? (typeof r.error === 'string' ? r.error : text(r.error.message) || JSON.stringify(r.error)) : '';
    if (err || !Array.isArray(r.elements)) {
      log.status = 'FAILED';
      log.error = clip(err || 'unexpected Overpass response (no elements array)', 300);
      logRows.push(log);
      return;
    }
    log.results = r.elements.length;
    if (!r.elements.length) log.status = 'EMPTY';
    for (const el of r.elements) {
      const tags = (el && el.tags) || {};
      const name = clip(tags.name, 120);
      const website = websiteOf(tags);
      if (!name || !website || isNonResearchableSite(website)) { log.skipped += 1; continue; }
      const leadId = businessKey(website);
      if (!leadId || known.has(leadId)) { log.duplicates += 1; continue; }
      if (suppressionReason(sup, '', leadId)) { log.skipped += 1; continue; }
      if (newLeads.length >= maxNew) { log.skipped += 1; continue; }
      known.add(leadId);
      log.new_leads += 1;
      const osmType = ['node', 'way', 'relation'].includes(el.type) ? el.type : 'node';
      newLeads.push({
        lead_id: leadId,
        niche_id: q.niche_id,
        country: text(niche.row && niche.row.country),
        company_name: name,
        website,
        city: clip(tags['addr:city'] || q.region, 80),
        region: clip(tags['addr:state'] || tags['addr:county'] || '', 80),
        discovery_source: PROVIDER,
        discovery_source_url: `https://www.openstreetmap.org/${osmType}/${Number(el.id) || 0}`,
        discovered_at: ts,
        stage: STAGE.NEW,
        business_category: categoryForTags(tags, categories) || q.category,
        discovery_status: 'DISCOVERED',
        research_status: 'PENDING',
        notes: 'Discovered via OpenStreetMap (data © OpenStreetMap contributors, ODbL). No contact details taken from OSM.',
        last_updated: ts,
      });
    }
    logRows.push(log);
  });
  return { newLeads, logRows };
}

// WF02 entry point: reads Settings and the active campaign row itself.
function planDiscoveryFromRows({ settingsRows, nichesRows, discoveryLogRows, overpassUrl, now }) {
  const settings = parseSettings(realRows(settingsRows));
  const niche = resolveActiveNiche(settings, realRows(nichesRows), 'discovery');
  return { ...planDiscovery({ settings, niche, discoveryLogRows, overpassUrl, now }), niche };
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { PROVIDER, DEFAULT_OVERPASS_URL, queryKey, overpassQuery, planDiscovery, planDiscoveryFromRows, normaliseDiscoveries, websiteOf };
