'use strict';

// Synthetic test data only. Every domain uses the reserved .example TLD.

const { SETTINGS_ROWS, NICHE_ROWS, TABS } = require('../../src/schema');

const NOW = '2026-10-13T10:00:00.000Z'; // a Tuesday, 11:00 in London (BST)

const SENDER_SETTINGS = {
  SENDER_NAME: 'Test Sender',
  BUSINESS_LEGAL_NAME: 'FlowHQ Test Ltd',
  BUSINESS_POSTAL_ADDRESS: '1 Test Street, Testville, TE1 1ST',
  WEBSITE_URL: 'https://flowhq.example',
  PRIVACY_URL: 'https://flowhq.example/privacy',
};

function settingsRows(overrides = {}) {
  const base = Object.fromEntries(SETTINGS_ROWS.map(([k, v]) => [k, v]));
  const values = { ...base, ...SENDER_SETTINGS, ...overrides };
  return Object.entries(values).map(([key, value], i) => ({ row_number: i + 2, key, value, notes: '' }));
}

function nichesRows(overrides = {}) {
  return [{ row_number: 2, ...NICHE_ROWS[0], ...overrides }];
}

function blankLead() {
  return Object.fromEntries(TABS.Leads.map((c) => [c, '']));
}

let rowCounter = 2;
function lead(overrides = {}) {
  return {
    ...blankLead(),
    row_number: rowCounter++,
    lead_id: 'agency-one.example',
    niche_id: 'uk-estate-letting',
    country: 'UK',
    company_name: 'Agency One Lettings Ltd',
    website: 'https://www.agency-one.example',
    city: 'Reading',
    contact_email: 'info@agency-one.example',
    email_source_url: 'https://www.agency-one.example/contact',
    stage: 'New Lead',
    ...overrides,
  };
}

module.exports = { NOW, SENDER_SETTINGS, settingsRows, nichesRows, lead, blankLead };
