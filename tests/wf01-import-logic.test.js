'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processImport,
  parseHost,
  registrableDomain,
  normaliseEmail,
  isValidEmail,
  normaliseDate,
  IMPORT_STATUS,
} = require('../src/wf01-import-logic');
const { TABS } = require('../src/schema');

const NOW = '2026-10-09T10:00:00.000Z';

// Synthetic test data only: every address uses the reserved .example TLD. The
// .co.uk strings further down are parsing-only checks of the public-suffix logic.
function settingsRows(overrides = {}) {
  const values = { ACTIVE_NICHE: 'uk-estate-letting', SENDING_ENABLED: 'FALSE', ...overrides };
  return Object.entries(values).map(([key, value], i) => ({ row_number: i + 2, key, value, notes: '' }));
}

function nichesRows(overrides = {}) {
  return [{ row_number: 2, niche_id: 'uk-estate-letting', active: 'TRUE', country: 'UK', timezone: 'Europe/London', ...overrides }];
}

let nextRow = 2;
function importRow(overrides = {}) {
  return {
    row_number: nextRow++,
    company_name: 'Example Lettings Ltd',
    website: 'https://www.example-lettings.example',
    city: 'Reading',
    region: 'Berkshire',
    contact_name: '',
    contact_role: '',
    contact_email: 'info@example-lettings.example',
    email_source_url: 'https://www.example-lettings.example/contact',
    phone: '',
    discovery_source: 'manual',
    discovery_source_url: 'https://www.example-lettings.example/',
    discovered_at: '2026-10-08',
    notes: '',
    import_status: '',
    import_message: '',
    lead_id: '',
    processed_at: '',
    ...overrides,
  };
}

function run({ importRows, leadsRows = [], suppressionRows = [], settings, niches } = {}) {
  return processImport({
    settingsRows: settings || settingsRows(),
    nichesRows: niches || nichesRows(),
    leadsRows,
    suppressionRows,
    importRows,
    now: NOW,
  });
}

function statusOf(result, rowNumber) {
  return result.importUpdates.find((u) => u.row_number === rowNumber);
}

// ---------- happy path ----------

test('valid row becomes a New Lead with normalised fields', () => {
  const row = importRow({ contact_email: ' MAILTO:Info@Example-Lettings.example ', website: 'www.example-lettings.example/' });
  const result = run({ importRows: [row] });

  assert.equal(result.leadsToAppend.length, 1);
  const lead = result.leadsToAppend[0];
  assert.equal(lead.lead_id, 'example-lettings.example');
  assert.equal(lead.contact_email, 'info@example-lettings.example');
  assert.equal(lead.website, 'https://www.example-lettings.example/');
  assert.equal(lead.stage, 'New Lead');
  assert.equal(lead.niche_id, 'uk-estate-letting');
  assert.equal(lead.country, 'UK');
  assert.equal(lead.discovered_at, '2026-10-08');
  assert.equal(lead.last_updated, NOW);

  const u = statusOf(result, row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.IMPORTED);
  assert.equal(u.import_message, 'OK');
  assert.equal(u.lead_id, 'example-lettings.example');
  assert.equal(u.processed_at, NOW);
});

test('every Leads key written is a real Leads column and every update key is a real Import column', () => {
  const result = run({ importRows: [importRow(), importRow({ contact_email: 'bad' })] });
  for (const lead of result.leadsToAppend) {
    for (const key of Object.keys(lead)) assert.ok(TABS.Leads.includes(key), `unknown Leads column ${key}`);
  }
  for (const u of result.importUpdates) {
    for (const key of Object.keys(u)) {
      assert.ok(key === 'row_number' || TABS.Import.includes(key), `unknown Import column ${key}`);
    }
  }
});

test('blank discovered_at defaults to the run timestamp', () => {
  const result = run({ importRows: [importRow({ discovered_at: '' })] });
  assert.equal(result.leadsToAppend[0].discovered_at, NOW);
});

// ---------- required fields ----------

for (const field of ['company_name', 'website', 'contact_email', 'email_source_url']) {
  test(`missing ${field} is rejected as invalid`, () => {
    const row = importRow({ [field]: '   ' });
    const result = run({ importRows: [row] });
    assert.equal(result.leadsToAppend.length, 0);
    const u = statusOf(result, row.row_number);
    assert.equal(u.import_status, IMPORT_STATUS.INVALID);
    assert.match(u.import_message, new RegExp(`${field} is required`));
  });
}

test('all missing required fields are reported together', () => {
  const row = importRow({ company_name: '', website: '', contact_email: '', email_source_url: '', city: 'Leeds' });
  const u = statusOf(run({ importRows: [row] }), row.row_number);
  assert.equal(u.import_message.split('; ').length, 4);
});

test('email_source_url must be a full http(s) URL', () => {
  for (const bad of ['example-lettings.example/contact', 'ftp://example-lettings.example/contact', 'see website']) {
    const row = importRow({ email_source_url: bad });
    const u = statusOf(run({ importRows: [row] }), row.row_number);
    assert.equal(u.import_status, IMPORT_STATUS.INVALID, bad);
    assert.match(u.import_message, /email_source_url must be a full http\(s\):\/\/ URL/);
  }
});

test('invalid website and discovery_source_url are rejected', () => {
  const a = importRow({ website: 'not a website' });
  const b = importRow({ discovery_source_url: 'zoopla' });
  const result = run({ importRows: [a, b] });
  assert.match(statusOf(result, a.row_number).import_message, /website is not a valid web address/);
  assert.match(statusOf(result, b.row_number).import_message, /discovery_source_url must be a full/);
});

test('unparseable discovered_at is rejected', () => {
  const row = importRow({ discovered_at: 'last tuesday' });
  assert.equal(statusOf(run({ importRows: [row] }), row.row_number).import_status, IMPORT_STATUS.INVALID);
});

// ---------- invalid emails ----------

test('invalid email addresses are rejected', () => {
  const bad = [
    'info', 'info@', '@agency.example', 'info@@agency.example', 'info@example', 'info@agency..example',
    'in fo@agency.example', 'info@agency.example; sales@agency.example', 'info@agency.example,sales@agency.example',
    '.info@agency.example', 'info.@agency.example', 'info@-agency.example', 'info@192.168.0.1', 'info@example.c0m',
  ];
  for (const email of bad) {
    const row = importRow({ contact_email: email });
    const u = statusOf(run({ importRows: [row] }), row.row_number);
    assert.equal(u.import_status, IMPORT_STATUS.INVALID, `expected ${email} to be rejected`);
  }
});

test('valid email variants are accepted', () => {
  for (const email of ['lettings@agency.example', 'first.last+web@agency.example', 'Sales@Branch.Agency.example']) {
    assert.ok(isValidEmail(normaliseEmail(email)), email);
  }
});

// ---------- duplicates ----------

test('duplicate of an existing Leads row (same domain) is rejected', () => {
  const leadsRows = [{ row_number: 2, lead_id: 'example-lettings.example', contact_email: 'other@example-lettings.example' }];
  const row = importRow({ website: 'http://example-lettings.example/about' });
  const u = statusOf(run({ importRows: [row], leadsRows }), row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.DUPLICATE);
  assert.match(u.import_message, /already exists in Leads/);
});

test('duplicate of an existing Leads email under a different website is rejected', () => {
  const leadsRows = [{ row_number: 2, lead_id: 'old-site.example', contact_email: 'INFO@example-lettings.example' }];
  const row = importRow();
  const u = statusOf(run({ importRows: [row], leadsRows }), row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.DUPLICATE);
  assert.match(u.import_message, /contact_email already belongs to lead old-site.example/);
});

test('duplicates within one import batch keep only the first row', () => {
  const first = importRow();
  const sameSite = importRow({ website: 'https://branch.example-lettings.example', contact_email: 'branch@example-lettings.example' });
  const sameEmail = importRow({ website: 'https://another-agency.example', email_source_url: 'https://another-agency.example/contact' });
  const result = run({ importRows: [first, sameSite, sameEmail] });

  assert.equal(result.leadsToAppend.length, 1);
  assert.equal(statusOf(result, first.row_number).import_status, IMPORT_STATUS.IMPORTED);
  assert.match(statusOf(result, sameSite.row_number).import_message, new RegExp(`same website as Import row ${first.row_number}`));
  assert.match(statusOf(result, sameEmail.row_number).import_message, new RegExp(`same contact_email as Import row ${first.row_number}`));
});

// ---------- suppression ----------

test('suppressed email is rejected', () => {
  const row = importRow();
  const suppressionRows = [{ email: 'Info@Example-Lettings.example', domain: '', reason: 'unsubscribe' }];
  const u = statusOf(run({ importRows: [row], suppressionRows }), row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.SUPPRESSED);
  assert.match(u.import_message, /contact_email is on the Suppression list/);
});

test('suppressed domain blocks any address or subdomain of that agency', () => {
  const suppressionRows = [{ email: '', domain: 'https://www.example-lettings.example/', reason: 'manual' }];
  const viaWebsite = importRow({ contact_email: 'info@example-lettings.example' });
  const viaSubdomain = importRow({ website: 'https://lettings.example-lettings.example', contact_email: 'a@lettings.example-lettings.example' });
  const result = run({ importRows: [viaWebsite, viaSubdomain], suppressionRows });
  assert.equal(statusOf(result, viaWebsite.row_number).import_status, IMPORT_STATUS.SUPPRESSED);
  assert.equal(statusOf(result, viaSubdomain.row_number).import_status, IMPORT_STATUS.SUPPRESSED);
  assert.equal(result.leadsToAppend.length, 0);
});

test('a suppressed email also suppresses its company domain', () => {
  const suppressionRows = [{ email: 'director@example-lettings.example', domain: '', reason: 'unsubscribe' }];
  const row = importRow({ contact_email: 'info@example-lettings.example' });
  const u = statusOf(run({ importRows: [row], suppressionRows }), row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.SUPPRESSED);
  assert.match(u.import_message, /domain is on the Suppression list/);
});

test('suppressing a shared mail provider address does not block other users of that provider', () => {
  const suppressionRows = [
    { email: 'someone@gmail.com', domain: '', reason: 'bounce' },
    { email: '', domain: 'gmail.com', reason: 'manual' },
  ];
  const row = importRow({ contact_email: 'smithlettings@gmail.com' });
  const result = run({ importRows: [row], suppressionRows });
  const u = statusOf(result, row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.IMPORTED);
  assert.match(u.import_message, /shared mail provider/);
});

test('suppression takes priority over duplicate detection', () => {
  const leadsRows = [{ row_number: 2, lead_id: 'example-lettings.example', contact_email: 'info@example-lettings.example' }];
  const suppressionRows = [{ email: 'info@example-lettings.example', domain: '', reason: 'unsubscribe' }];
  const row = importRow();
  assert.equal(statusOf(run({ importRows: [row], leadsRows, suppressionRows }), row.row_number).import_status, IMPORT_STATUS.SUPPRESSED);
});

// ---------- repeat imports ----------

test('rows that already have an import_status are skipped and not rewritten', () => {
  const done = importRow({ import_status: 'IMPORTED', lead_id: 'example-lettings.example' });
  const result = run({ importRows: [done] });
  assert.equal(result.leadsToAppend.length, 0);
  assert.equal(result.importUpdates.length, 0);
  assert.equal(result.summary.skippedAlreadyProcessed, 1);
});

test('running the same import twice never creates a second lead', () => {
  // Simulate the sheet: run once, apply writes, run again on the resulting state.
  const importRows = [importRow(), importRow({ website: 'https://second-agency.example', contact_email: 'hello@second-agency.example', email_source_url: 'https://second-agency.example/contact-us' })];
  const first = run({ importRows });
  assert.equal(first.leadsToAppend.length, 2);

  const leadsRows = first.leadsToAppend.map((l, i) => ({ row_number: i + 2, ...l }));
  const afterStatus = importRows.map((r) => ({ ...r, ...statusOf(first, r.row_number) }));
  const second = run({ importRows: afterStatus, leadsRows });
  assert.equal(second.leadsToAppend.length, 0);
  assert.equal(second.importUpdates.length, 0);

  // Even if someone clears the status column, dedupe against Leads still blocks it.
  const cleared = importRows.map((r) => ({ ...r, import_status: '' }));
  const third = run({ importRows: cleared, leadsRows });
  assert.equal(third.leadsToAppend.length, 0);
  assert.ok(third.importUpdates.every((u) => u.import_status === IMPORT_STATUS.DUPLICATE));
});

test('empty spreadsheet rows are ignored', () => {
  const blank = { row_number: 99, ...Object.fromEntries(TABS.Import.map((h) => [h, ''])) };
  const result = run({ importRows: [blank, {}] });
  assert.equal(result.importUpdates.length, 0);
  assert.equal(result.summary.skippedEmpty, 2);
});

// ---------- fail closed on configuration ----------

test('missing ACTIVE_NICHE aborts the whole import', () => {
  assert.throws(() => run({ importRows: [importRow()], settings: settingsRows({ ACTIVE_NICHE: '' }) }), /ACTIVE_NICHE is missing/);
});

test('unknown or inactive niche aborts the whole import', () => {
  assert.throws(() => run({ importRows: [importRow()], niches: nichesRows({ niche_id: 'other' }) }), /has no row in the Niches tab/);
  assert.throws(() => run({ importRows: [importRow()], niches: nichesRows({ active: 'FALSE' }) }), /is not active/);
  assert.throws(() => run({ importRows: [importRow()], niches: nichesRows({ active: true, country: '' }) }), /has no country/);
});

test('Sheets boolean TRUE is accepted for Niches.active', () => {
  const result = run({ importRows: [importRow()], niches: nichesRows({ active: true }) });
  assert.equal(result.leadsToAppend.length, 1);
});

test('row without row_number aborts rather than losing its status', () => {
  const row = importRow();
  delete row.row_number;
  assert.throws(() => run({ importRows: [row] }), /missing row_number/);
});

// ---------- warnings ----------

test('warnings are recorded for mismatched email domain and off-site email source', () => {
  const row = importRow({ contact_email: 'info@other-domain.example', email_source_url: 'https://directory.example.org/agent/123', city: '' });
  const u = statusOf(run({ importRows: [row] }), row.row_number);
  assert.equal(u.import_status, IMPORT_STATUS.IMPORTED);
  assert.match(u.import_message, /differs from website domain/);
  assert.match(u.import_message, /not on the agency website/);
  assert.match(u.import_message, /city is blank/);
});

// ---------- helpers ----------

test('registrableDomain handles UK, AU and plain suffixes', () => {
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('branch.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('a.b.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('shop.example.com'), 'example.com');
});

test('parseHost rejects unusable addresses', () => {
  assert.equal(parseHost('https://Example.co.uk:8443/x?y#z'), 'example.co.uk');
  assert.equal(parseHost('example.co.uk/contact'), 'example.co.uk');
  for (const bad of ['', 'localhost', 'http://localhost:5678', 'javascript:alert(1)', 'mailto:a@b.example', 'http://1.2.3.4/', 'http://user@example.com']) {
    assert.equal(parseHost(bad), '', bad);
  }
  assert.equal(parseHost('example.co.uk', { requireScheme: true }), '');
});

test('normaliseDate converts Sheets serial dates and rejects nonsense', () => {
  assert.equal(normaliseDate(46304), '2026-10-09T00:00:00.000Z');
  assert.equal(normaliseDate('2026-10-08'), '2026-10-08');
  assert.equal(normaliseDate(''), '');
  assert.equal(normaliseDate('soon'), null);
});
