'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/lib/registries');

const NOW = '2026-10-13T10:00:00.000Z';
const LEAD = { company_name: 'Agency One Lettings Ltd' };
const plan = (country, extra = {}) => R.planRegistryLookup({ lead: { ...LEAD, ...(extra.lead || {}) }, country, companyNumber: extra.number || '', numberSource: extra.source || '' });
const evaluate = (p, response) => R.evaluateRegistry(p, response, NOW);

// ---------- country routing ----------

test('country values are normalised to ISO codes', () => {
  for (const v of ['UK', 'uk', 'GB', 'United Kingdom', 'England', 'Scotland']) assert.equal(R.normaliseCountry(v), 'GB', v);
  for (const v of ['US', 'USA', 'United States', 'u.s.a.']) assert.equal(R.normaliseCountry(v), 'US', v);
  for (const v of ['IN', 'India', 'india']) assert.equal(R.normaliseCountry(v), 'IN', v);
  assert.equal(R.normaliseCountry('FR'), 'FR');
  assert.equal(R.normaliseCountry(''), '');
  assert.equal(R.normaliseCountry('Narnia'), '');
});

test('GB routes to Companies House; only GB is live', () => {
  const gb = plan('UK', { number: '1234567', source: 'website' });
  assert.equal(gb.country_code, 'GB');
  assert.equal(gb.provider, 'companies_house');
  assert.equal(gb.live, true);
  assert.equal(gb.request_url, 'https://api.company-information.service.gov.uk/company/01234567');
  assert.equal(gb.source_url, 'https://find-and-update.company-information.service.gov.uk/company/01234567');
  assert.equal(R.REGISTRY_ADAPTERS.US.live, false);
  assert.equal(R.REGISTRY_ADAPTERS.IN.live, false);
});

test('US and India adapters exist but never make a request and never verify', () => {
  for (const [country, provider] of [['US', 'us_state_registry'], ['IN', 'mca_india'], ['India', 'mca_india']]) {
    const p = plan(country, { number: '12345678' });
    assert.equal(p.provider, provider);
    assert.equal(p.live, false);
    assert.equal(p.request_url, '');
    // Even a response that looks like a perfect match is ignored for a non-live adapter.
    const r = evaluate(p, { company_number: '12345678', company_status: 'active', type: 'ltd' });
    assert.equal(r.registry_status, 'UNVERIFIED', country);
    assert.equal(r.registry_source_url, '');
    assert.match(r.registry_match_rationale, /nothing was queried/);
    assert.equal(R.isRegistryVerified(r), false);
  }
});

test('unsupported and unrecognised countries are UNVERIFIED, not failures', () => {
  const fr = evaluate(plan('FR'), {});
  assert.equal(fr.registry_status, 'UNVERIFIED');
  assert.equal(fr.registry_country, 'FR');
  assert.equal(fr.registry_provider, 'none');
  assert.match(fr.registry_match_rationale, /No registry adapter for country FR/);
  const unknown = evaluate(plan('Narnia'), {});
  assert.equal(unknown.registry_status, 'UNVERIFIED');
  assert.match(unknown.registry_match_rationale, /not recognised/);
  const blank = evaluate(plan(''), {});
  assert.equal(blank.registry_status, 'UNVERIFIED');
});

// ---------- Companies House outcomes ----------

test('no match is UNVERIFIED and explicitly not "does not exist"', () => {
  const r = evaluate(plan('GB'), { items: [{ title: 'SOMETHING ELSE LIMITED', company_number: '1', company_status: 'active', company_type: 'ltd' }] });
  assert.equal(r.registry_status, 'UNVERIFIED');
  assert.match(r.registry_match_rationale, /No exact name match/);
  assert.match(r.registry_match_rationale, /does not mean it is unregistered/);
  const empty = evaluate(plan('GB'), { items: [] });
  assert.equal(empty.registry_status, 'UNVERIFIED');
});

test('API failures (string, object, 404) are UNVERIFIED with the reason recorded', () => {
  for (const response of [{ error: 'URL parameter cannot be empty' }, { error: { message: '429 Too Many Requests' } }, { error: { message: 'The resource you are requesting could not be found (404)' } }]) {
    const r = evaluate(plan('GB', { number: '01234567', source: 'website' }), response);
    assert.equal(r.registry_status, 'UNVERIFIED');
    assert.match(r.registry_match_rationale, /lookup by company number 01234567 \(website\) failed/);
    assert.match(r.registry_match_rationale, /does not mean the company is unregistered/);
  }
  assert.equal(evaluate(plan('GB'), { unexpected: true }).registry_status, 'UNVERIFIED');
});

test('ambiguous name matches are UNVERIFIED and list the candidates', () => {
  const r = evaluate(plan('GB'), { items: [{ title: 'Agency One Lettings Ltd', company_number: '11111111' }, { title: 'AGENCY ONE LETTINGS LIMITED', company_number: '22222222' }] });
  assert.equal(r.registry_status, 'UNVERIFIED');
  assert.match(r.registry_match_rationale, /Ambiguous: 2 .*11111111, 22222222/);
});

test('INELIGIBLE needs a number match; an inactive name match stays UNVERIFIED', () => {
  const byNumber = evaluate(plan('GB', { number: '01234567', source: 'website' }), { company_number: '01234567', company_status: 'dissolved', type: 'ltd', company_name: 'AGENCY ONE LETTINGS LIMITED' });
  assert.equal(byNumber.registry_status, 'INELIGIBLE');
  assert.equal(byNumber.company.company_status, 'dissolved');
  const byName = evaluate(plan('GB'), { items: [{ title: 'AGENCY ONE LETTINGS LIMITED', company_number: '07654321', company_status: 'dissolved', company_type: 'ltd' }] });
  assert.equal(byName.registry_status, 'UNVERIFIED');
  assert.match(byName.registry_match_rationale, /may be a different or former entity/);
  assert.equal(byName.registry_source_url, 'https://find-and-update.company-information.service.gov.uk/company/07654321');
});

test('a verified result stores every provenance field', () => {
  const r = evaluate(plan('UK', { number: 'SC123456', source: 'entered in the Leads sheet' }), { company_number: 'SC123456', company_status: 'active', type: 'llp', company_name: 'AGENCY ONE LLP' });
  assert.deepEqual(Object.keys(R.registryColumns(r, {})).slice(0, 6), R.REGISTRY_COLUMNS);
  assert.equal(r.registry_status, 'VERIFIED');
  assert.equal(r.registry_country, 'GB');
  assert.equal(r.registry_provider, 'companies_house');
  assert.equal(r.registry_checked_at, NOW);
  assert.match(r.registry_match_rationale, /company number SC123456 \(entered in the Leads sheet\).*AGENCY ONE LLP/);
  assert.deepEqual(r.company, { company_number: 'SC123456', company_status: 'active', legal_entity_type: 'llp' });
});

test('no company name and no number is UNVERIFIED for insufficient evidence', () => {
  const p = R.planRegistryLookup({ lead: { company_name: '' }, country: 'GB', companyNumber: '' });
  assert.equal(p.request_url, '');
  assert.match(evaluate(p, {}).registry_match_rationale, /no company name or company number/);
});

// ---------- manual verification ----------

test('MANUAL_VERIFIED needs a source URL and rationale, and is then preserved', () => {
  const good = { registry_status: 'MANUAL_VERIFIED', registry_source_url: 'https://registry.example/x', registry_match_rationale: 'checked', registry_provider: 'manual', registry_country: 'IN' };
  const p = R.planRegistryLookup({ lead: { ...LEAD, ...good }, country: 'IN' });
  assert.equal(p.manual, true);
  const r = evaluate(p, {});
  assert.equal(R.isRegistryVerified(r), true);
  assert.deepEqual(R.registryColumns(r, good), { ...good, registry_checked_at: '' });
  for (const bad of [{ ...good, registry_source_url: '' }, { ...good, registry_source_url: 'not a url' }, { ...good, registry_match_rationale: '' }]) {
    assert.equal(R.planRegistryLookup({ lead: { ...LEAD, ...bad }, country: 'IN' }).manual, undefined);
  }
});

test('registry requirement follows the niche', () => {
  assert.equal(R.registryRequired({ legal_entity_required: 'limited_company_or_llp' }), true);
  assert.equal(R.registryRequired({ legal_entity_required: 'none' }), false);
  assert.equal(R.registryRequired({ legal_entity_required: '' }), false);
});
