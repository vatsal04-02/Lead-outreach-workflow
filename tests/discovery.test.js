'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/lib/discovery');
const C = require('../src/lib/categories');
const R = require('../src/lib/robots');
const { businessKey, isNonResearchableSite, normaliseCountry } = require('../src/lib/common');
const { TABS } = require('../src/schema');
const { nichesRows } = require('./helpers/fixtures');

const NOW = '2026-10-13T10:00:00.000Z';
const SETTINGS = { DISCOVERY_ENABLED: 'TRUE', DISCOVERY_QUERIES_PER_RUN: '2', DISCOVERY_REFRESH_DAYS: '30' };
const niche = (o = {}) => ({ niche_id: o.niche_id || 'uk-estate-letting', row: nichesRows(o)[0] });
const plan = (o = {}) => D.planDiscovery({ settings: { ...SETTINGS, ...(o.settings || {}) }, niche: niche(o.niche), discoveryLogRows: o.log || [], overpassUrl: o.url, now: NOW });

// ---------- dedupe keys ----------

test('business keys dedupe by domain, but not across shared hosting platforms', () => {
  assert.equal(businessKey('https://www.agency.example/branches/reading'), 'agency.example');
  assert.equal(businessKey('https://branch.agency.co.uk'), 'agency.co.uk');
  assert.equal(businessKey('https://joes.wixsite.com/plumbing'), 'joes.wixsite.com');
  assert.notEqual(businessKey('https://joes.wixsite.com'), businessKey('https://anns.wixsite.com'));
  assert.equal(businessKey('https://sites.google.com/view/smile-dental/home'), 'sites.google.com/view/smile-dental');
  assert.equal(businessKey('https://www.facebook.com/JoesPlumbing/about'), 'facebook.com/joesplumbing');
  assert.equal(isNonResearchableSite('https://facebook.com/x'), true);
  assert.equal(isNonResearchableSite('https://joes.wixsite.com'), false);
  assert.equal(businessKey('not a url'), '');
});

test('countries normalise to ISO codes', () => {
  for (const [v, c] of [['UK', 'GB'], ['India', 'IN'], ['USA', 'US'], ['Canada', 'CA'], ['Australia', 'AU'], ['de', 'DE'], ['Narnia', '']]) assert.equal(normaliseCountry(v), c, v);
});

// ---------- categories ----------

test('industries map to OSM tag filters; all, custom filters and undiscoverable industries', () => {
  const one = C.campaignCategories({ industries: 'dentist; plumber' });
  assert.deepEqual(one.categories.map((c) => c.category), ['dentist', 'plumber']);
  assert.deepEqual(one.categories[0].filters, [{ key: 'amenity', value: 'dentist' }, { key: 'healthcare', value: 'dentist' }]);
  const all = C.campaignCategories({ industries: 'all' });
  assert.ok(all.categories.length > 30);
  assert.ok(!all.categories.some((c) => c.category === 'retail'), '"all" excludes the generic retail filter');
  const custom = C.campaignCategories({ industries: 'dentist', osm_tag_filters: 'office=lawyer; craft' });
  assert.deepEqual(custom.categories, [{ category: 'custom', filters: [{ key: 'office', value: 'lawyer' }, { key: 'craft', value: '' }] }]);
  assert.match(C.campaignCategories({ industries: 'ecommerce' }).problems[0], /cannot be discovered through OpenStreetMap/);
  assert.match(C.campaignCategories({ industries: 'spaceships' }).problems[0], /unknown industry/);
  assert.match(C.campaignCategories({ osm_tag_filters: 'office"]; out;' }).problems[0], /invalid filter/);
  assert.equal(C.categoryForTags({ amenity: 'dentist' }, one.categories), 'dentist');
});

// ---------- planning ----------

test('discovery is off unless DISCOVERY_ENABLED is exactly TRUE and the campaign uses OSM', () => {
  assert.equal(plan({ settings: { DISCOVERY_ENABLED: 'FALSE' } }).queries.length, 0);
  assert.match(plan({ niche: { discovery_provider: '' } }).skipReason, /discovery_provider is "blank"/);
});

test('bad discovery configuration fails loudly', () => {
  assert.throws(() => plan({ niche: { regions: '' } }), /regions is blank/);
  assert.throws(() => plan({ niche: { regions: 'Reading"]; out;' } }), /unsupported characters/);
  assert.throws(() => plan({ niche: { country: 'Narnia' } }), /not recognised/);
  assert.throws(() => plan({ settings: { DISCOVERY_QUERIES_PER_RUN: '50' } }), /DISCOVERY_QUERIES_PER_RUN/);
  assert.throws(() => plan({ url: 'ftp://x' }), /overpass_url/);
});

test('queries rotate: never-run first, failed retried, completed only after the refresh period', () => {
  const p = plan();
  assert.equal(p.queries.length, 2);
  assert.deepEqual(p.queries.map((q) => [q.region, q.category]), [['Reading', 'estate_agent'], ['Reading', 'property_management']]);
  const log = [
    { query_key: 'uk-estate-letting|reading|estate_agent', run_at: '2026-10-12T10:00:00Z', status: 'OK' },
    { query_key: 'uk-estate-letting|reading|property_management', run_at: '2026-10-12T10:00:00Z', status: 'FAILED' },
  ];
  const next = plan({ log });
  assert.deepEqual(next.queries.map((q) => q.query_key), ['uk-estate-letting|leicester|estate_agent', 'uk-estate-letting|leicester|property_management']);
  const later = plan({ log, settings: { DISCOVERY_QUERIES_PER_RUN: '10' } });
  assert.ok(later.queries.some((q) => q.query_key.endsWith('reading|property_management')), 'failed search retried');
  assert.ok(!later.queries.some((q) => q.query_key.endsWith('reading|estate_agent')), 'completed search not repeated within 30 days');
  const old = [{ query_key: 'uk-estate-letting|reading|estate_agent', run_at: '2026-08-01T10:00:00Z', status: 'OK' }];
  assert.ok(plan({ log: old, settings: { DISCOVERY_QUERIES_PER_RUN: '10' } }).queries.some((q) => q.query_key.endsWith('reading|estate_agent')));
});

test('the Overpass query targets the campaign country, region and categories, websites only', () => {
  const q = plan({ niche: { country: 'IN', regions: 'Pune', industries: 'dentist' } }).queries[0];
  assert.match(q.request_url, /^https:\/\/overpass-api\.de\/api\/interpreter\?data=/);
  const ql = decodeURIComponent(q.request_url.split('?data=')[1]);
  assert.match(ql, /area\["ISO3166-1"="IN"\]/);
  assert.match(ql, /\["name"="Pune"\]/);
  assert.match(ql, /nwr\["amenity"="dentist"\]\["website"\]\(area\.searchArea\)/);
  assert.match(ql, /out center tags 60;/);
  assert.equal(q.country, 'IN');
});

// ---------- normalising results ----------

function normalise(elements, opts = {}) {
  const queries = [{ query_key: 'k', niche_id: 'uk-estate-letting', provider: 'osm_overpass', country: 'GB', region: 'Reading', category: 'estate_agent' }];
  return D.normaliseDiscoveries({ queries, responses: [opts.response || { elements }], leadsRows: opts.leads || [], suppressionRows: opts.suppression || [], niche: niche(), maxNew: opts.maxNew || 20, now: NOW });
}

const el = (id, tags) => ({ type: 'node', id, tags: { name: `Agency ${id}`, office: 'estate_agent', ...tags } });

test('discovered businesses become New Lead rows with exactly the Leads columns, OSM attribution and no contact', () => {
  const r = normalise([el(1, { website: 'https://www.one.example', email: 'osm@one.example', 'addr:city': 'Reading' })]);
  assert.equal(r.newLeads.length, 1);
  const l = r.newLeads[0];
  for (const k of Object.keys(l)) assert.ok(TABS.Leads.includes(k), k);
  assert.equal(l.lead_id, 'one.example');
  assert.equal(l.stage, 'New Lead');
  assert.equal(l.discovery_status, 'DISCOVERED');
  assert.equal(l.research_status, 'PENDING');
  assert.equal(l.discovery_source_url, 'https://www.openstreetmap.org/node/1');
  assert.equal(l.contact_email, undefined, 'emails from OSM are never used');
  assert.match(l.notes, /© OpenStreetMap contributors/);
  assert.deepEqual(Object.keys(r.logRows[0]), TABS.Discovery_Log);
  assert.equal(r.logRows[0].status, 'OK');
});

test('duplicates, profile pages, missing websites, suppressed domains and the cap are skipped', () => {
  const r = normalise([
    el(1, { website: 'one.example' }),
    el(2, { website: 'https://branch.one.example' }),
    el(3, { website: 'https://facebook.com/agency3' }),
    el(4, {}),
    el(5, { 'contact:website': 'https://known.example' }),
    el(6, { website: 'https://blocked.example' }),
    el(7, { website: 'https://seven.example' }),
    el(8, { website: 'https://eight.example' }),
  ], { leads: [{ lead_id: 'known.example' }], suppression: [{ domain: 'blocked.example', reason: 'manual' }], maxNew: 2 });
  assert.deepEqual(r.newLeads.map((l) => l.lead_id), ['one.example', 'seven.example']);
  const log = r.logRows[0];
  assert.equal(log.results, 8);
  assert.equal(log.new_leads, 2);
  assert.equal(log.duplicates, 2);
  assert.equal(log.skipped, 4);
});

test('failed and empty searches are logged, never treated as "no businesses exist"', () => {
  assert.equal(normalise(null, { response: { error: 'getaddrinfo ENOTFOUND overpass-api.de' } }).logRows[0].status, 'FAILED');
  assert.equal(normalise(null, { response: { remark: 'runtime error' } }).logRows[0].status, 'FAILED');
  const empty = normalise([]);
  assert.equal(empty.logRows[0].status, 'EMPTY');
  assert.equal(empty.newLeads.length, 0);
});

test('repeat discovery of the same businesses adds nothing', () => {
  const first = normalise([el(1, { website: 'https://one.example' })]);
  const second = normalise([el(1, { website: 'https://one.example' })], { leads: first.newLeads });
  assert.equal(second.newLeads.length, 0);
  assert.equal(second.logRows[0].duplicates, 1);
});

// ---------- robots.txt ----------

test('robots.txt parsing: specific agent group, longest match, wildcards', () => {
  const rules = R.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: OtherBot\nDisallow: /');
  assert.equal(R.isAllowed(rules, 'https://a.example/private/x'), false);
  assert.equal(R.isAllowed(rules, 'https://a.example/private/ok/1'), true);
  assert.equal(R.isAllowed(rules, 'https://a.example/doc.pdf'), false);
  assert.equal(R.isAllowed(rules, 'https://a.example/'), true);
  assert.equal(R.isAllowed(R.parseRobots('User-agent: flowhq-research\nDisallow: /'), 'https://a.example/'), false);
  assert.equal(R.isAllowed(R.parseRobots('User-agent: *\nDisallow:'), 'https://a.example/'), true);
  assert.equal(R.robotsUrl('https://a.example/x/y'), 'https://a.example/robots.txt');
});
