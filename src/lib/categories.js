'use strict';

// Industry → OpenStreetMap tag filters used by the Overpass discovery provider.
//
// This is configuration data, not workflow logic: a campaign selects industries
// by name (or `all`) in Niches.industries, or overrides them completely with
// explicit filters in Niches.osm_tag_filters ("office=lawyer; craft=plumber").
// OSM coverage varies by country and category; an empty result is recorded,
// never treated as "no such businesses exist".

// ---- IMPORTS (stripped when embedded in n8n) ----
const { text, listSetting } = require('./common');
// ---- END IMPORTS ----

const INDUSTRY_TAGS = {
  dentist: ['amenity=dentist', 'healthcare=dentist'],
  clinic: ['amenity=clinic', 'healthcare=clinic'],
  doctors: ['amenity=doctors', 'healthcare=doctor'],
  physiotherapy: ['healthcare=physiotherapist'],
  diagnostic_lab: ['healthcare=laboratory'],
  veterinary: ['amenity=veterinary'],
  lawyer: ['office=lawyer'],
  accountant: ['office=accountant', 'office=tax_advisor'],
  consultant: ['office=consulting'],
  recruitment: ['office=employment_agency'],
  insurance: ['office=insurance'],
  financial_advisor: ['office=financial_advisor'],
  architect: ['office=architect'],
  estate_agent: ['office=estate_agent', 'shop=estate_agent'],
  property_management: ['office=property_management'],
  plumber: ['craft=plumber'],
  electrician: ['craft=electrician'],
  hvac: ['craft=hvac'],
  cleaning: ['craft=cleaning'],
  repair: ['craft=electronics_repair'],
  hotel: ['tourism=hotel', 'tourism=guest_house'],
  restaurant: ['amenity=restaurant'],
  cafe: ['amenity=cafe'],
  salon: ['shop=hairdresser', 'shop=beauty'],
  spa: ['shop=massage'],
  gym: ['leisure=fitness_centre'],
  school: ['amenity=school'],
  college: ['amenity=college'],
  training: ['amenity=language_school', 'amenity=driving_school', 'amenity=music_school', 'amenity=prep_school'],
  marketing_agency: ['office=advertising_agency'],
  it_services: ['office=it'],
  software: ['office=it'],
  wholesale: ['shop=wholesale'],
  retail: ['shop'],
  car_dealer: ['shop=car'],
  garage: ['shop=car_repair'],
  car_parts: ['shop=car_parts'],
};

// Industries that OSM cannot reasonably discover (no physical premises tagged).
const NOT_DISCOVERABLE_VIA_OSM = new Set(['ecommerce', 'distributor']);

const TAG_FILTER = /^([a-z][a-z0-9_:]{0,40})(?:=([a-z0-9][a-z0-9_:;.-]{0,60}))?$/;

function parseTagFilter(value) {
  const m = TAG_FILTER.exec(text(value).toLowerCase());
  return m ? { key: m[1], value: m[2] || '' } : null;
}

// Returns [{ category, filters: [{key, value}] }] for a campaign, plus problems.
function campaignCategories(niche) {
  const problems = [];
  const custom = listSetting(niche && niche.osm_tag_filters);
  if (custom.length) {
    const filters = custom.map(parseTagFilter);
    if (filters.some((f) => !f)) problems.push(`osm_tag_filters contains an invalid filter (use key=value, e.g. office=lawyer)`);
    return { categories: [{ category: 'custom', filters: filters.filter(Boolean) }], problems };
  }
  const wanted = listSetting(niche && niche.industries).map((x) => x.toLowerCase().replace(/[\s-]+/g, '_'));
  const names = wanted.includes('all') ? Object.keys(INDUSTRY_TAGS).filter((k) => k !== 'retail') : wanted;
  const categories = [];
  for (const name of names) {
    if (NOT_DISCOVERABLE_VIA_OSM.has(name)) { problems.push(`industry "${name}" cannot be discovered through OpenStreetMap; use manual import (WF01)`); continue; }
    if (!INDUSTRY_TAGS[name]) { problems.push(`unknown industry "${name}" (see src/lib/categories.js or set osm_tag_filters)`); continue; }
    categories.push({ category: name, filters: INDUSTRY_TAGS[name].map(parseTagFilter) });
  }
  return { categories, problems };
}

// The industry a discovered OSM element belongs to, from its own tags (observed).
function categoryForTags(tags, categories) {
  const t = tags || {};
  for (const c of categories) {
    if (c.filters.some((f) => (f.value ? text(t[f.key]).toLowerCase() === f.value : Boolean(text(t[f.key]))))) return c.category;
  }
  return '';
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { INDUSTRY_TAGS, NOT_DISCOVERABLE_VIA_OSM, parseTagFilter, campaignCategories, categoryForTags };
