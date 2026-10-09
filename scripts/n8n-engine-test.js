#!/usr/bin/env node
'use strict';

// Runs the generated workflows inside a real n8n engine against an in-memory
// fake Google Sheet. Google Sheets, HTTP (websites, Companies House, Gemini)
// and Gmail nodes are replaced by stub Code nodes with the same names and
// settings (executeOnce, alwaysOutputData, onError), so the embedded Code-node
// logic, wiring, item pairing, error outputs and branch order run exactly as n8n
// runs them. After each run the harness applies the write nodes' items to the
// fake sheet the way Google Sheets would, so workflows can be chained:
// WF01 → WF02 → WF03 → (human approval) → WF04 → WF05 → WF06.
//
// Nothing here touches Google, Gmail or the internet. All data is synthetic
// (.example domains).
//
//   N8N_BIN=/path/to/n8n N8N_USER_FOLDER=$(mktemp -d) node scripts/n8n-engine-test.js
//
// Use a throwaway N8N_USER_FOLDER: workflows are imported into that instance.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { FIXTURE_IMPORT_ROWS, FIXTURE_SUPPRESSION_ROWS } = require('./build');
const { TABS, SETTINGS_ROWS, NICHE_ROWS } = require('../src/schema');

const ROOT = path.resolve(__dirname, '..');
const N8N_BIN = process.env.N8N_BIN;
if (!N8N_BIN || !process.env.N8N_USER_FOLDER) {
  console.error('Set N8N_BIN to the n8n executable and N8N_USER_FOLDER to a throwaway directory.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhq-n8n-'));
const load = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
let runCounter = 0;

// ---------- fake Google Sheet ----------

class FakeSheet {
  // `headers` can override a tab's header row, e.g. to model a Leads tab that
  // hasn't been migrated yet. Like Google Sheets, updates to columns missing from
  // the header are silently dropped.
  constructor(initial = {}, headers = {}) {
    this.headers = { ...TABS, ...headers };
    this.tabs = {};
    for (const tab of Object.keys(TABS)) this.tabs[tab] = (initial[tab] || []).map((r) => this.blank(tab, r));
  }

  headerRow(tab) {
    return Object.fromEntries(this.headers[tab].map((h) => [h, h]));
  }

  blank(tab, row = {}) {
    return { ...Object.fromEntries(TABS[tab].map((h) => [h, ''])), ...row };
  }

  rows(tab) {
    return this.tabs[tab].map((r, i) => ({ row_number: i + 2, ...r }));
  }

  lead(id) {
    return this.tabs.Leads.find((l) => l.lead_id === id);
  }

  // Mirrors the Google Sheets node: append (unknown fields are an error),
  // appendOrUpdate on the matching column, update of the mapped columns only.
  apply(node, items) {
    const p = node.parameters;
    const tab = p.sheetName.value;
    const headers = TABS[tab];
    const asCell = (v) => (v === undefined || v === null ? '' : v);
    if (p.operation === 'append' || p.operation === 'appendOrUpdate') {
      for (const item of items) {
        for (const k of Object.keys(item)) if (!headers.includes(k)) throw new Error(`${node.name}: field '${k}' is not a ${tab} column`);
        const key = p.operation === 'appendOrUpdate' ? p.columns.matchingColumns[0] : null;
        const existing = key ? this.tabs[tab].find((r) => String(r[key]) === String(item[key])) : null;
        if (existing) Object.assign(existing, item);
        else this.tabs[tab].push(this.blank(tab, item));
      }
      return;
    }
    if (p.operation === 'update') {
      const key = p.columns.matchingColumns[0];
      const cols = Object.keys(p.columns.value).filter((c) => c !== 'row_number');
      for (const item of items) {
        const row = key === 'row_number' ? this.tabs[tab][Number(item.row_number) - 2] : this.tabs[tab].find((r) => String(r[key]) === String(item[key]));
        if (!row) continue; // Sheets skips keys it can't find
        for (const c of cols) if (this.headers[tab].includes(c)) row[c] = asCell(item[c]);
      }
      return;
    }
    throw new Error(`${node.name}: unsupported operation ${p.operation}`);
  }
}

// ---------- stubs ----------

const isRead = (n) => n.type === 'n8n-nodes-base.googleSheets' && !n.parameters.operation;
const isWrite = (n) => n.type === 'n8n-nodes-base.googleSheets' && Boolean(n.parameters.operation);

function stub(node, jsCode) {
  const { credentials, ...rest } = node;
  return { ...rest, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode } };
}

const emit = (rows) => `return ${JSON.stringify(rows.map((r) => ({ json: r })))};`;

// Read-after-write inside one run (WF04 re-reads Leads after locking a row).
function readAfterWrite(rows, writes) {
  return [
    `const rows = ${JSON.stringify(rows)};`,
    `for (const w of ${JSON.stringify(writes)}) {`,
    '  let items = [];',
    '  try { items = $(w.node).all().map((i) => i.json); } catch (e) { items = []; }',
    '  for (const it of items) { const r = rows.find((x) => String(x[w.match]) === String(it[w.match])); if (r) for (const c of w.cols) r[c] = it[c] === undefined || it[c] === null ? "" : it[c]; }',
    '}',
    'return rows.map((json) => ({ json }));',
  ].join('\n');
}

function httpStub(node, responses) {
  const field = /\$json\.(\w+)/.exec(node.parameters.url)[1];
  return stub(node, [
    `const R = ${JSON.stringify({ byUrl: {}, byBody: [], ...(responses || {}) })};`,
    'return $input.all().map((item, i) => {',
    `  const url = item.json.${field};`,
    '  let json;',
    "  if (!url) json = { error: 'URL parameter cannot be empty' };",
    '  else if (R.byUrl[url]) json = R.byUrl[url];',
    '  else {',
    "    const body = JSON.stringify(item.json.ai_body || '');",
    '    const hit = (R.byBody || []).find(([k]) => body.includes(k));',
    "    json = hit ? hit[1] : { error: { message: 'getaddrinfo ENOTFOUND (stub: no canned response)' } };",
    '  }',
    '  return { json, pairedItem: { item: i } };',
    '});',
  ].join('\n'));
}

function variant(file, sheet, opts = {}) {
  const wf = load(file);
  const writesSoFar = [];
  const nodes = wf.nodes.map((n) => {
    if (n.type === 'n8n-nodes-base.scheduleTrigger' || n.type === 'n8n-nodes-base.errorTrigger') {
      return { parameters: {}, id: n.id, name: n.name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: n.position };
    }
    if (isRead(n) && n.parameters.options && n.parameters.options.dataLocationOnSheet) {
      // Header read (header row 1 = first data row): the header comes back as an item.
      const tab = n.parameters.sheetName.value;
      return stub(n, emit([{ row_number: 1, ...sheet.headerRow(tab) }, ...sheet.rows(tab)]));
    }
    if (isRead(n)) {
      const tab = n.parameters.sheetName.value;
      const prior = writesSoFar.filter((w) => w.tab === tab);
      return stub(n, prior.length ? readAfterWrite(sheet.rows(tab), prior) : emit(sheet.rows(tab)));
    }
    if (isWrite(n)) {
      if (n.parameters.operation === 'update') {
        writesSoFar.push({ node: n.name, tab: n.parameters.sheetName.value, match: n.parameters.columns.matchingColumns[0], cols: Object.keys(n.parameters.columns.value) });
      }
      if ((opts.failWrites || []).includes(n.name)) return stub(n, `throw new Error('simulated Google Sheets outage in ${n.name}');`);
      return stub(n, 'return $input.all();');
    }
    if (n.type === 'n8n-nodes-base.httpRequest') return httpStub(n, (opts.http || {})[n.name]);
    if (n.type === 'n8n-nodes-base.gmail' && n.parameters.operation === 'getAll') return stub(n, emit(opts.inbox || []));
    if (n.type === 'n8n-nodes-base.gmail') {
      if (opts.gmailFails) return stub(n, "throw new Error('invalid_grant: Token has been expired or revoked.');");
      return stub(n, "return $input.all().map((item, i) => ({ json: { id: `msg-${item.json.lead_id || 'alert'}`, threadId: `thread-${item.json.lead_id || 'alert'}`, labelIds: ['SENT'], stub_to: item.json.to || item.json.alert_email, stub_subject: item.json.subject || item.json.email_subject }, pairedItem: { item: i } }));");
    }
    return n;
  });
  runCounter += 1;
  return { ...wf, nodes, id: `t${runCounter}${file.slice(0, 4).replace(/\W/g, '')}`, name: `${wf.name} [engine ${runCounter}]` };
}

// ---------- running ----------

function n8n(args) {
  try {
    return { ok: true, out: execFileSync(N8N_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}` };
  }
}

function parseRun(out) {
  // n8n prints task-runner log lines first; the run object starts on a line of its own.
  const lines = out.split('\n');
  const start = lines.indexOf('{');
  const end = lines.lastIndexOf('}');
  assert.ok(start !== -1 && end > start, `no JSON in output:\n${out.slice(0, 2000)}`);
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

function outputOf(run, name, output = 0) {
  const runs = run.data.resultData.runData[name];
  if (!runs) return null;
  return (runs[0].data?.main?.[output] || []).map((i) => i.json);
}

// Imports and executes a variant, then applies its writes to the fake sheet.
function execute(file, sheet, opts = {}) {
  const wf = variant(file, sheet, opts);
  const f = path.join(tmp, `${wf.id}.json`);
  fs.writeFileSync(f, JSON.stringify(wf));
  const imported = n8n(['import:workflow', `--input=${f}`]);
  assert.ok(imported.ok, `import failed:\n${imported.out}`);
  const r = n8n(['execute', `--id=${wf.id}`, '--rawOutput']);
  const run = parseRun(r.out);
  const original = load(file);
  const writes = original.nodes
    .filter(isWrite)
    .map((n) => ({ n, runs: run.data.resultData.runData[n.name] }))
    .filter((w) => w.runs && !w.runs[0].error)
    .sort((a, b) => a.runs[0].executionIndex - b.runs[0].executionIndex);
  for (const w of writes) sheet.apply(w.n, outputOf(run, w.n.name) || []);
  const error = run.data.resultData.error ? run.data.resultData.error.message : '';
  return { run, ok: r.ok && !error, error, out: (name, o) => outputOf(run, name, o) };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`);
  }
}

// ---------- synthetic data ----------

const SENDER = {
  SENDER_NAME: 'Engine Test Sender',
  BUSINESS_LEGAL_NAME: 'FlowHQ Engine Test Ltd',
  BUSINESS_POSTAL_ADDRESS: '1 Test Street, Testville, TE1 1ST',
  WEBSITE_URL: 'https://flowhq.example',
  PRIVACY_URL: 'https://flowhq.example/privacy',
  TEST_RECIPIENT: 'test-inbox@flowhq.example',
};
// The window is opened to the whole day so the result doesn't depend on when the
// suite runs (window logic itself is unit-tested with fixed clocks).
const ALWAYS_OPEN = { SEND_DAYS: 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', SEND_WINDOW_START: '00:00', SEND_WINDOW_END: '23:59', MIN_MINUTES_BETWEEN_SENDS: '0' };

function settingsWith(overrides = {}) {
  const v = { ...Object.fromEntries(SETTINGS_ROWS.map(([k, val]) => [k, val])), ...SENDER, ...overrides };
  return Object.entries(v).map(([key, value]) => ({ key, value, notes: '' }));
}
function setSetting(sheet, key, value) {
  const row = sheet.tabs.Settings.find((r) => r.key === key);
  if (row) row.value = value;
  else sheet.tabs.Settings.push(sheet.blank('Settings', { key, value }));
}

const gem = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const ALPHA_HOME = `<html><body><nav><a href="/contact">Contact us</a><a href="/about-us">About us</a></nav>
<p>Independent lettings agency in Reading.</p><p>We aim to respond to all enquiries within 24 hours.</p>
<footer>Alpha Lettings Ltd, registered in England, company no. 09990001.</footer></body></html>`;
const ALPHA_CONTACT = '<html><body><p>To book a viewing please call the office.</p><p>Email info@alpha-lettings.example</p></body></html>';
const ALPHA_ABOUT = '<html><body><p>Ada Example, Director, founded the agency.</p></body></html>';
const ALPHA_AI = gem({
  fit_score: 3, problem_score: 3, contact_score: 2,
  qualification_reasoning: 'Independent Reading lettings agency with a 24-hour reply promise and phone-only viewings.',
  evidence: [
    { quote: 'We aim to respond to all enquiries within 24 hours.', url: 'https://www.alpha-lettings.example', signal: '24h reply promise' },
    { quote: 'To book a viewing please call the office.', url: 'https://www.alpha-lettings.example/contact', signal: 'phone-only viewings' },
    { quote: 'We lose most weekend enquiries.', url: 'https://www.alpha-lettings.example', signal: 'invented' },
  ],
  opportunity_hypothesis: 'Automatic acknowledgement of enquiries might help outside office hours.',
  decision_maker: { name: 'Ada Example', role: 'Director', quote: 'Ada Example, Director, founded the agency.', url: 'https://www.alpha-lettings.example/about-us' },
  exclusions_found: [], no_solicitation_notice: { found: false, quote: '', url: '' },
});
const ALPHA_DRAFT_AI = gem({ subject: 'Enquiries at Alpha Lettings', observation: "I was looking at Alpha Lettings's website and noticed you aim to respond to enquiries within 24 hours." });

const WF02_HTTP = {
  'Fetch Homepage': {
    byUrl: {
      'https://www.alpha-lettings.example': { data: ALPHA_HOME },
      'https://gamma-homes.example': { data: '<p>Gamma Homes Ltd, company number 09990003.</p>' },
    },
  },
  'Fetch Pages': { byUrl: { 'https://www.alpha-lettings.example/contact': { data: ALPHA_CONTACT }, 'https://www.alpha-lettings.example/about-us': { data: ALPHA_ABOUT } } },
  'Companies House': {
    byUrl: {
      'https://api.company-information.service.gov.uk/company/09990001': { company_number: '09990001', company_status: 'active', type: 'ltd', company_name: 'ALPHA LETTINGS LIMITED' },
      'https://api.company-information.service.gov.uk/company/09990003': { company_number: '09990003', company_status: 'dissolved', type: 'ltd', company_name: 'GAMMA HOMES LIMITED' },
    },
  },
  Gemini: { byBody: [['alpha-lettings.example', ALPHA_AI]] },
};

const E2E_IMPORT = [
  { company_name: 'Alpha Lettings Ltd', website: 'https://www.alpha-lettings.example', city: 'Reading', contact_email: 'info@alpha-lettings.example', email_source_url: 'https://www.alpha-lettings.example/contact', discovery_source: 'engine-test', discovery_source_url: 'https://www.alpha-lettings.example/', discovered_at: '2026-10-01' },
  { company_name: 'Beta Estates Ltd', website: 'https://beta-estates.example', city: 'Leicester', contact_email: 'hello@beta-estates.example', email_source_url: 'https://beta-estates.example/contact', discovery_source: 'engine-test' },
  { company_name: 'Gamma Homes Ltd', website: 'https://gamma-homes.example', city: 'Norwich', contact_email: 'info@gamma-homes.example', email_source_url: 'https://gamma-homes.example/contact', discovery_source: 'engine-test' },
  { company_name: 'Delta Property Ltd', website: 'https://delta-property.example', city: 'Norwich', contact_email: 'info@delta-property.example', email_source_url: 'https://delta-property.example/contact', discovery_source: 'engine-test' },
];

// ---------- 1. imports of every generated file ----------

for (const file of fs.readdirSync(path.join(ROOT, 'workflows')).filter((f) => f.endsWith('.json')).sort()) {
  check(`imports unchanged: ${file}`, () => {
    const wf = { ...load(file), id: `imp${file.replace(/\W/g, '').slice(0, 12)}` };
    const target = path.join(tmp, `import-${file}`);
    fs.writeFileSync(target, JSON.stringify(wf));
    const r = n8n(['import:workflow', `--input=${target}`]);
    assert.ok(r.ok, r.out);
  });
}

// ---------- 2. WF01 (Phase 2 regression) ----------

const settingsBase = settingsWith(ALWAYS_OPEN);
check('WF01: Phase 2 fixtures match Import-expected-results.csv', () => {
  const sheet = new FakeSheet({ Settings: settingsBase, Niches: NICHE_ROWS, Import: FIXTURE_IMPORT_ROWS, Suppression: FIXTURE_SUPPRESSION_ROWS });
  const r = execute('WF01-import-dedupe.json', sheet);
  assert.ok(r.ok, r.error);
  const expected = fs.readFileSync(path.join(ROOT, 'sheets/test-fixtures/Import-expected-results.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  for (const [row, , status] of expected) assert.equal(sheet.tabs.Import[Number(row) - 2].import_status, status, `row ${row}`);
  assert.deepEqual(sheet.tabs.Leads.map((l) => l.lead_id), ['fixture-one.example', 'fixture-two.example', 'fixture-nine.example']);
  const rd = r.run.data.resultData.runData;
  assert.ok(rd['Append to Leads'][0].executionIndex < rd['Import Status Updates'][0].executionIndex, 'Leads must be appended before statuses');
  const again = execute('WF01-import-dedupe.json', sheet);
  assert.ok(again.ok);
  assert.equal(sheet.tabs.Leads.length, 3, 'repeat run must not add leads');
});

check('WF01: a failed Leads append writes no Import statuses (safe to re-run)', () => {
  const sheet = new FakeSheet({ Settings: settingsBase, Niches: NICHE_ROWS, Import: FIXTURE_IMPORT_ROWS.slice(0, 2) });
  const r = execute('WF01-import-dedupe.json', sheet, { failWrites: ['Append to Leads'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /simulated Google Sheets outage/);
  assert.equal(r.out('Update Import Rows'), null);
  assert.ok(sheet.tabs.Import.every((row) => row.import_status === ''));
  const retry = execute('WF01-import-dedupe.json', sheet);
  assert.ok(retry.ok);
  assert.equal(sheet.tabs.Leads.length, 2);
});

check('WF01: inactive niche fails the run and writes nothing', () => {
  const sheet = new FakeSheet({ Settings: settingsBase, Niches: [{ ...NICHE_ROWS[0], active: 'FALSE' }], Import: FIXTURE_IMPORT_ROWS });
  const r = execute('WF01-import-dedupe.json', sheet);
  assert.match(r.error, /is not active/);
  assert.equal(sheet.tabs.Leads.length, 0);
});

// ---------- 3. WF00 ----------

check('WF00: an error becomes an Errors row and an alert email; a Sheets outage does not block the email', () => {
  const sheet = new FakeSheet();
  const wf = load('WF00-error-handler.json');
  const sample = { execution: { id: '987', mode: 'trigger', lastNodeExecuted: 'Read Leads', error: { message: 'Engine test failure lead_id=engine.example' } }, workflow: { name: 'WF04 Approved Sender' } };
  // The Error Trigger is replaced by a Code node of the same name that emits a
  // sample error payload, fed by a manual Start node.
  const withSample = (file) => {
    const v = variant(file, sheet);
    v.nodes = v.nodes.map((n) => (n.name === 'On Workflow Error' ? { parameters: { jsCode: emit([sample]) }, id: n.id, name: n.name, type: 'n8n-nodes-base.code', typeVersion: 2, position: n.position } : n));
    v.nodes.push({ parameters: {}, id: 'engine-start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [-220, 0] });
    v.connections.Start = { main: [[{ node: 'On Workflow Error', type: 'main', index: 0 }]] };
    return v;
  };
  for (const failSheets of [false, true]) {
    const v = withSample('WF00-error-handler.json');
    if (failSheets) v.nodes = v.nodes.map((n) => (n.name === 'Append to Errors' ? stub(n, "throw new Error('sheets down');") : n));
    const f = path.join(tmp, `${v.id}.json`);
    fs.writeFileSync(f, JSON.stringify(v));
    assert.ok(n8n(['import:workflow', `--input=${f}`]).ok);
    const run = parseRun(n8n(['execute', `--id=${v.id}`, '--rawOutput']).out);
    const mail = outputOf(run, 'Email Alert');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].stub_to, 'PASTE_FLOWHQ_ALERT_EMAIL_HERE');
    if (!failSheets) {
      const row = outputOf(run, 'Append to Errors')[0];
      assert.deepEqual(Object.keys(row), TABS.Errors);
      assert.equal(row.lead_id, 'engine.example');
    }
  }
  void wf;
});

// ---------- 4. end-to-end WF01 → WF06 ----------

const e2e = new FakeSheet({
  Settings: settingsBase,
  Niches: NICHE_ROWS,
  Import: E2E_IMPORT,
});

check('E2E 1/9 WF01: four synthetic agencies imported as New Lead', () => {
  const r = execute('WF01-import-dedupe.json', e2e);
  assert.ok(r.ok, r.error);
  assert.deepEqual(e2e.tabs.Leads.map((l) => [l.lead_id, l.stage]), [
    ['alpha-lettings.example', 'New Lead'], ['beta-estates.example', 'New Lead'], ['gamma-homes.example', 'New Lead'], ['delta-property.example', 'New Lead'],
  ]);
  // Delta later opts out through another channel and is suppressed by hand.
  e2e.tabs.Suppression.push(e2e.blank('Suppression', { email: 'info@delta-property.example', reason: 'manual', source: 'engine-test', added_at: '2026-10-02' }));
});

check('E2E 2/9 WF02: research qualifies, disqualifies, and records failures without losing data', () => {
  const r = execute('WF02-research-qualify.json', e2e, { http: WF02_HTTP });
  assert.ok(r.ok, r.error);
  const alpha = e2e.lead('alpha-lettings.example');
  assert.equal(alpha.stage, 'Qualified', alpha.disqualify_reason || alpha.last_error);
  assert.equal(alpha.company_number, '09990001');
  assert.equal(alpha.registry_status, 'VERIFIED');
  assert.equal(alpha.registry_country, 'GB');
  assert.equal(alpha.registry_provider, 'companies_house');
  assert.equal(alpha.registry_source_url, 'https://find-and-update.company-information.service.gov.uk/company/09990001');
  assert.ok(alpha.registry_checked_at);
  assert.match(alpha.registry_match_rationale, /company number 09990001/);
  assert.ok(!/companies house/i.test(alpha.evidence), 'registry data never enters website evidence');
  assert.equal(alpha.contact_name, 'Ada Example');
  assert.equal(alpha.problem_score, 3);
  assert.ok(!alpha.evidence.includes('We lose most weekend enquiries'), 'invented quote must be dropped');
  assert.match(alpha.qualification_reasoning, /1 AI quote\(s\) discarded/);
  const beta = e2e.lead('beta-estates.example');
  assert.equal(beta.stage, 'New Lead');
  assert.match(beta.last_error, /Website fetch failed/);
  assert.equal(beta.registry_status, 'UNVERIFIED'); // registry lookup failed too: recorded, not inferred
  const gamma = e2e.lead('gamma-homes.example');
  assert.equal(gamma.stage, 'Disqualified');
  assert.match(gamma.disqualify_reason, /dissolved/);
  assert.equal(gamma.registry_status, 'INELIGIBLE');
  const delta = e2e.lead('delta-property.example');
  assert.equal(delta.stage, 'Disqualified');
  assert.match(delta.disqualify_reason, /Suppressed/);
  // Only alpha reached Gemini; no request was made for skipped leads.
  const gemIn = r.out('Build AI Requests').filter((i) => i.request_url);
  assert.deepEqual(gemIn.map((i) => i.lead_id), ['alpha-lettings.example']);
});

check('WF02 refuses to run on a Leads tab without the registry columns (nothing written)', () => {
  const oldHeaders = TABS.Leads.filter((c) => !c.startsWith('registry_'));
  const sheet = new FakeSheet({ Settings: settingsBase, Niches: NICHE_ROWS, Leads: [{ lead_id: 'omega.example', niche_id: 'uk-estate-letting', country: 'UK', company_name: 'Omega Ltd', website: 'https://omega.example', contact_email: 'info@omega.example', stage: 'New Lead' }] }, { Leads: oldHeaders });
  const r = execute('WF02-research-qualify.json', sheet, { http: WF02_HTTP });
  assert.equal(r.ok, false);
  assert.match(r.error, /missing columns: registry_country.*registry_match_rationale/);
  assert.equal(sheet.lead('omega.example').stage, 'New Lead');
  assert.equal(r.out('Fetch Homepage'), null, 'no website was fetched');
});

check('WF02: US and IN leads are routed to non-live adapters and never hit Companies House', () => {
  const sheet = new FakeSheet({
    Settings: settingsBase,
    Niches: NICHE_ROWS,
    Leads: [
      { lead_id: 'us-agency.example', niche_id: 'uk-estate-letting', country: 'US', company_name: 'US Agency LLC', website: 'https://us-agency.example', contact_email: 'info@us-agency.example', stage: 'New Lead' },
      { lead_id: 'in-agency.example', niche_id: 'uk-estate-letting', country: 'IN', company_name: 'IN Agency Pvt Ltd', website: 'https://in-agency.example', contact_email: 'info@in-agency.example', stage: 'New Lead' },
    ],
  });
  const http = { ...WF02_HTTP, 'Fetch Homepage': { byUrl: { 'https://us-agency.example': { data: '<p>Hello</p>' }, 'https://in-agency.example': { data: '<p>Hello</p>' } } } };
  const r = execute('WF02-research-qualify.json', sheet, { http });
  assert.ok(r.ok, r.error);
  const chCalls = (r.out('Build AI Requests') || []).map((i) => i.ch_request_url).filter(Boolean);
  assert.deepEqual(chCalls, [], 'Companies House must not be called for US/IN');
  for (const [id, provider] of [['us-agency.example', 'us_state_registry'], ['in-agency.example', 'mca_india']]) {
    const l = sheet.lead(id);
    assert.equal(l.registry_status, 'UNVERIFIED', id);
    assert.equal(l.registry_provider, provider);
    assert.equal(l.stage, 'Researched', 'this niche requires a verified legal entity');
  }
});

check('E2E 3/9 WF02 re-run: only the failed lead is retried', () => {
  const r = execute('WF02-research-qualify.json', e2e, { http: WF02_HTTP });
  assert.ok(r.ok, r.error);
  const items = r.out('Research Items');
  assert.deepEqual(items.map((i) => i.lead_id), ['beta-estates.example']);
  assert.equal(e2e.lead('alpha-lettings.example').stage, 'Qualified');
});

check('E2E 4/9 WF03: a checked draft is ready for approval', () => {
  const r = execute('WF03-draft-generation.json', e2e, { http: { Gemini: { byBody: [['Alpha Lettings', ALPHA_DRAFT_AI]] } } });
  assert.ok(r.ok, r.error);
  const alpha = e2e.lead('alpha-lettings.example');
  assert.equal(alpha.stage, 'Draft Ready');
  assert.equal(alpha.approval_status, 'Pending');
  assert.equal(alpha.draft_check_result, 'PASS');
  assert.equal(alpha.email_subject, 'Enquiries at Alpha Lettings');
  assert.match(alpha.email_body, /^Hi Ada,/);
  assert.match(alpha.email_body, /FlowHQ Engine Test Ltd · https:\/\/flowhq\.example/);
  const again = execute('WF03-draft-generation.json', e2e, { http: { Gemini: { byBody: [] } } });
  assert.ok(again.ok);
  assert.equal((again.out('Draft Items') || []).length, 0, 'no lead is drafted twice');
  assert.equal(again.out('Gemini'), null, 'Gemini is not called when there is nothing to draft');
});

function approve(id) {
  Object.assign(e2e.lead(id), { stage: 'Approved', approval_status: 'Approved', approved_by: 'engine-test', approved_at: '2026-10-05T09:00:00Z' });
}

check('E2E 5/9 WF04: with the default SENDING_ENABLED=FALSE nothing is sent', () => {
  approve('alpha-lettings.example');
  const r = execute('WF04-approved-sender.json', e2e);
  assert.ok(r.ok, r.error);
  assert.equal(r.out('Gate & Pick')[0].reason, 'SENDING_ENABLED is not TRUE');
  assert.equal(r.out('Send Email'), null);
  assert.equal(e2e.tabs.Send_Log.length, 0);
  assert.equal(e2e.lead('alpha-lettings.example').send_status, '');
});

check('E2E 6/9 WF04: TEST_MODE redirects to the test inbox, then never repeats', () => {
  setSetting(e2e, 'SENDING_ENABLED', 'TRUE');
  const r = execute('WF04-approved-sender.json', e2e);
  assert.ok(r.ok, r.error);
  const sent = r.out('Send Email')[0];
  assert.equal(sent.stub_to, 'test-inbox@flowhq.example');
  assert.match(sent.stub_subject, /^\[TEST\] /);
  const alpha = e2e.lead('alpha-lettings.example');
  assert.equal(alpha.send_status, 'TestSent');
  assert.equal(alpha.stage, 'Approved');
  assert.deepEqual(e2e.tabs.Send_Log.map((l) => [l.status, l.to_email, l.test_mode]), [['test_sent', 'test-inbox@flowhq.example', 'TRUE']]);
  const again = execute('WF04-approved-sender.json', e2e);
  assert.ok(again.ok);
  assert.equal(again.out('Send Email'), null);
  assert.equal(e2e.tabs.Send_Log.length, 1);
});

check('E2E 7/9 WF04: live send (allowlisted), then duplicates are refused even if re-approved', () => {
  setSetting(e2e, 'TEST_MODE', 'FALSE');
  setSetting(e2e, 'LIVE_RECIPIENT_ALLOWLIST', 'nobody@flowhq.example');
  e2e.lead('alpha-lettings.example').send_status = '';
  const blocked = execute('WF04-approved-sender.json', e2e);
  assert.ok(blocked.ok);
  assert.equal(blocked.out('Send Email'), null);
  assert.match(e2e.lead('alpha-lettings.example').last_error, /not on LIVE_RECIPIENT_ALLOWLIST/);

  setSetting(e2e, 'LIVE_RECIPIENT_ALLOWLIST', 'info@alpha-lettings.example');
  const r = execute('WF04-approved-sender.json', e2e);
  assert.ok(r.ok, r.error);
  assert.equal(r.out('Send Email')[0].stub_to, 'info@alpha-lettings.example');
  const alpha = e2e.lead('alpha-lettings.example');
  assert.equal(alpha.stage, 'Contacted');
  assert.equal(alpha.send_status, 'Sent');
  assert.equal(alpha.gmail_thread_id, 'thread-alpha-lettings.example');
  assert.equal(e2e.tabs.Send_Log.filter((l) => l.status === 'sent').length, 1);

  Object.assign(alpha, { stage: 'Approved', send_status: '' }); // a human mistake
  const dup = execute('WF04-approved-sender.json', e2e);
  assert.ok(dup.ok);
  assert.equal(dup.out('Send Email'), null);
  assert.match(e2e.lead('alpha-lettings.example').last_error, /already/);
  Object.assign(alpha, { stage: 'Contacted', send_status: 'Sent' });
});

check('E2E 8/9 WF04: a Gmail failure is logged, the lead is marked Failed and an alert is raised', () => {
  e2e.tabs.Leads.push(e2e.blank('Leads', { ...e2e.lead('alpha-lettings.example'), lead_id: 'zeta-lets.example', company_name: 'Zeta Lets Ltd', contact_email: 'info@zeta-lets.example', stage: 'Approved', send_status: '', gmail_thread_id: '', gmail_message_id: '', sent_at: '', last_error: '' }));
  const zeta = e2e.lead('zeta-lets.example');
  zeta.email_body = zeta.email_body.replace(/Alpha Lettings/g, 'Zeta Lets');
  zeta.email_subject = 'Enquiries at Zeta Lets';
  zeta.evidence = e2e.lead('alpha-lettings.example').evidence;
  setSetting(e2e, 'LIVE_RECIPIENT_ALLOWLIST', 'info@zeta-lets.example');
  const r = execute('WF04-approved-sender.json', e2e, { gmailFails: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Gmail send failed for lead_id=zeta-lets\.example: invalid_grant/);
  assert.equal(zeta.send_status, 'Failed');
  assert.equal(zeta.stage, 'Approved');
  assert.match(zeta.last_error, /invalid_grant/);
  assert.equal(e2e.tabs.Send_Log.filter((l) => l.status === 'failed').length, 1);
  const again = execute('WF04-approved-sender.json', e2e);
  assert.ok(again.ok);
  assert.equal(again.out('Send Email'), null, 'failed sends are never retried automatically');
});

check('E2E 9/9 WF05 + WF06: an opt-out reply suppresses and unsubscribes; metrics are idempotent', () => {
  const inbox = [{
    id: 'reply-1', threadId: 'thread-alpha-lettings.example', subject: 'Re: Enquiries at Alpha Lettings',
    from: { value: [{ address: 'info@alpha-lettings.example', name: 'Ada' }] }, date: '2026-10-06T12:00:00.000Z',
    text: 'Please unsubscribe us.\n\nOn Mon, 5 Oct 2026, Engine Test Sender wrote:\n> reply "unsubscribe" and we won\'t contact you again.', headers: {},
  }, {
    id: 'reply-2', threadId: 'thread-unknown', subject: 'Hello', from: { value: [{ address: 'someone@else.example' }] }, date: '2026-10-06T12:00:00.000Z', text: 'unsubscribe', headers: {},
  }];
  const r = execute('WF05-replies-bounces.json', e2e, { inbox });
  assert.ok(r.ok, r.error);
  const alpha = e2e.lead('alpha-lettings.example');
  assert.equal(alpha.stage, 'Unsubscribed');
  assert.equal(alpha.reply_status, 'unsubscribed');
  const sup = e2e.tabs.Suppression.filter((s) => s.reason === 'unsubscribe');
  assert.deepEqual(sup.map((s) => [s.email, s.domain]), [['info@alpha-lettings.example', 'alpha-lettings.example']]);
  const rd = r.run.data.resultData.runData;
  assert.ok(rd['Append Suppression'][0].executionIndex < rd['Update Leads (Replies)'][0].executionIndex, 'suppression first');
  const again = execute('WF05-replies-bounces.json', e2e, { inbox });
  assert.ok(again.ok);
  assert.equal(e2e.tabs.Suppression.filter((s) => s.reason === 'unsubscribe').length, 1);
  assert.equal(again.out('Classify Messages')[0].summary.alreadyProcessed, 1);

  const m1 = execute('WF06-daily-metrics.json', e2e);
  assert.ok(m1.ok, m1.error);
  const m2 = execute('WF06-daily-metrics.json', e2e);
  assert.ok(m2.ok);
  assert.equal(e2e.tabs.Metrics.length, 1, 'one row per day');
  const m = e2e.tabs.Metrics[0];
  assert.deepEqual(Object.keys(m), TABS.Metrics);
  assert.equal(m.new_leads, 5);
  assert.equal(m.emails_sent, 1);
  assert.equal(m.unsubscribes, 1);
  assert.equal(m.replies, 1);
});

check('Suppression is final: an unsubscribed contact is never drafted or sent again', () => {
  const alpha = e2e.lead('alpha-lettings.example');
  Object.assign(alpha, { stage: 'Approved', send_status: '', approval_status: 'Approved', last_error: '' });
  setSetting(e2e, 'LIVE_RECIPIENT_ALLOWLIST', '');
  const r = execute('WF04-approved-sender.json', e2e);
  assert.ok(r.ok, r.error);
  assert.equal(r.out('Send Email'), null);
  assert.match(alpha.last_error, /Suppression list/);
});

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
