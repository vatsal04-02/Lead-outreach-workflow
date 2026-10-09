'use strict';

// Guards against schema drift: the Sheet templates, the workflow JSON, and the
// architecture/strategy docs must all agree on tab and column names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TABS, SETTINGS_ROWS, NICHE_ROWS } = require('../src/schema');
const { SHEET_ID_PLACEHOLDER, ALERT_EMAIL_PLACEHOLDER } = require('../scripts/build');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const architecture = read('docs/02-mvp-architecture.md');
const strategy = read('docs/01-strategy-icp-offer.md');

function section(doc, startHeading, endHeading) {
  const start = doc.indexOf(startHeading);
  const end = doc.indexOf(endHeading, start + 1);
  assert.ok(start !== -1 && end !== -1, `missing section ${startHeading}`);
  return doc.slice(start, end);
}

// Backticked names in the first cell of each markdown table row.
function firstColumnNames(markdown) {
  const names = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const firstCell = line.split('|')[1];
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) names.push(...m[1].split(' / ').map((s) => s.trim()));
  }
  return names;
}

function csvHeader(rel) {
  return read(rel).split('\n')[0].split(',');
}

// ---------- docs ↔ schema ----------

test('Leads columns match architecture §3.3 exactly, in order', () => {
  assert.deepEqual(TABS.Leads, firstColumnNames(section(architecture, '### 3.3', '### 3.4')));
});

test('Settings keys match architecture §3.1 exactly, in order', () => {
  const documented = firstColumnNames(section(architecture, '### 3.1', '### 3.2'));
  assert.deepEqual(SETTINGS_ROWS.map(([k]) => k), documented);
});

test('Suppression, Send_Log and Errors columns match architecture §3.4/§3.5', () => {
  const s34 = section(architecture, '### 3.4', '### 3.5');
  const suppressionLine = s34.split('\n').find((l) => l.startsWith('`email`'));
  // Ignore the allowed values listed in brackets after `reason`.
  const withoutValues = suppressionLine.replace(/\([^)]*\)/g, '');
  assert.deepEqual(TABS.Suppression, [...withoutValues.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));

  const s35 = section(architecture, '### 3.5', '## 4.');
  const sendLog = s35.split('\n').find((l) => l.includes('`Send_Log`'));
  assert.deepEqual(TABS.Send_Log, [...sendLog.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
  const errors = s35.split('\n').find((l) => l.includes('`Errors`'));
  assert.deepEqual(TABS.Errors, [...errors.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
});

test('Niches columns match strategy §8 exactly, in order', () => {
  assert.deepEqual(TABS.Niches, firstColumnNames(section(strategy, '## 8.', '## 9.')));
  assert.deepEqual(Object.keys(NICHE_ROWS[0]), TABS.Niches);
});

test('Import columns match architecture §3.6 exactly, in order', () => {
  const s36 = section(architecture, '### 3.6', '## 4.');
  const firstParagraph = s36.split('\n').find((l) => l.startsWith('The human-filled'));
  const names = [...firstParagraph.replace(/\([^)]*\)/g, '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual(TABS.Import, names);
});

test('Import inputs are exactly the Leads columns a human fills in, plus status columns', () => {
  const statusColumns = ['import_status', 'import_message', 'lead_id', 'processed_at'];
  const inputs = TABS.Import.filter((c) => !statusColumns.includes(c));
  for (const c of inputs) assert.ok(TABS.Leads.includes(c), `${c} is not a Leads column`);
  assert.deepEqual(TABS.Import.slice(-4), statusColumns);
});

test('every tab has a CSV template with identical headers', () => {
  for (const [tab, headers] of Object.entries(TABS)) {
    assert.deepEqual(csvHeader(`sheets/${tab}.csv`), headers, tab);
  }
  assert.deepEqual(csvHeader('sheets/test-fixtures/Import-test-rows.csv'), TABS.Import);
  assert.deepEqual(csvHeader('sheets/test-fixtures/Suppression-test-rows.csv'), TABS.Suppression);
});

test('Settings template starts with sending disabled and test mode on', () => {
  const settings = Object.fromEntries(SETTINGS_ROWS.map(([k, v]) => [k, v]));
  assert.equal(settings.SENDING_ENABLED, 'FALSE');
  assert.equal(settings.TEST_MODE, 'TRUE');
});

test('test fixtures only use the reserved .example TLD', () => {
  for (const file of ['Import-test-rows.csv', 'Suppression-test-rows.csv']) {
    const body = read(`sheets/test-fixtures/${file}`);
    const hosts = [...body.matchAll(/(?:@|\/\/)([a-z0-9.-]+\.[a-z]+)/gi)].map((m) => m[1].toLowerCase());
    assert.ok(hosts.length > 0);
    for (const h of hosts) assert.ok(h.endsWith('.example') || h === 'fixture-four', `${file}: ${h}`);
  }
});

// ---------- workflow JSON ----------

// Every workflow file in workflows/ is covered, including ones added later.
const workflows = Object.fromEntries(
  fs.readdirSync(path.join(ROOT, 'workflows')).filter((f) => f.endsWith('.json')).sort().map((f) => [f, JSON.parse(read(`workflows/${f}`))]),
);

test('all eight expected workflow files exist', () => {
  assert.deepEqual(Object.keys(workflows), [
    'WF00-error-handler.json', 'WF00-selftest-trigger.json', 'WF01-import-dedupe.json', 'WF02-research-qualify.json',
    'WF03-draft-generation.json', 'WF04-approved-sender.json', 'WF05-replies-bounces.json', 'WF06-daily-metrics.json',
  ]);
});

test('workflow connections only reference existing nodes, and node names are unique', () => {
  for (const [file, wf] of Object.entries(workflows)) {
    const names = wf.nodes.map((n) => n.name);
    assert.equal(new Set(names).size, names.length, file);
    for (const [from, value] of Object.entries(wf.connections)) {
      assert.ok(names.includes(from), `${file}: ${from}`);
      for (const branch of value.main) for (const c of branch) assert.ok(names.includes(c.node), `${file}: ${c.node}`);
    }
  }
});

test('workflows contain no credentials, real sheet IDs, or activation', () => {
  for (const [file, wf] of Object.entries(workflows)) {
    assert.equal(wf.active, false, file);
    for (const n of wf.nodes) assert.equal(n.credentials, undefined, `${file}: ${n.name}`);
    const text = JSON.stringify(wf);
    assert.ok(!/docs\.google\.com\/spreadsheets\/d\//.test(text), file);
  }
  assert.ok(JSON.stringify(workflows['WF01-import-dedupe.json']).includes(SHEET_ID_PLACEHOLDER));
  assert.ok(JSON.stringify(workflows['WF00-error-handler.json']).includes(ALERT_EMAIL_PLACEHOLDER));
});

test('every Google Sheets node targets a known tab via the Config sheet_id', () => {
  for (const [file, wf] of Object.entries(workflows)) {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.googleSheets')) {
      assert.ok(Object.keys(TABS).includes(n.parameters.sheetName.value), `${file}: ${n.name}`);
      assert.equal(n.parameters.sheetName.mode, 'name');
      assert.equal(n.parameters.documentId.value, "={{ $('Config').first().json.sheet_id }}");
    }
  }
});

test('WF01 read nodes run once and tolerate empty tabs', () => {
  const wf = workflows['WF01-import-dedupe.json'];
  const reads = wf.nodes.filter((n) => n.name.startsWith('Read '));
  assert.deepEqual(reads.map((n) => n.parameters.sheetName.value), ['Settings', 'Niches', 'Leads', 'Suppression', 'Import']);
  for (const n of reads) {
    assert.equal(n.executeOnce, true, n.name);
    assert.equal(n.alwaysOutputData, true, n.name);
  }
});

test('WF01 writes are strict: RAW values, no silent new columns, update by row_number', () => {
  const wf = workflows['WF01-import-dedupe.json'];
  const append = wf.nodes.find((n) => n.name === 'Append to Leads');
  assert.equal(append.parameters.operation, 'append');
  assert.equal(append.parameters.sheetName.value, 'Leads');
  assert.deepEqual(append.parameters.options, { cellFormat: 'RAW', handlingExtraData: 'error' });

  const update = wf.nodes.find((n) => n.name === 'Update Import Rows');
  assert.equal(update.parameters.operation, 'update');
  assert.equal(update.parameters.sheetName.value, 'Import');
  assert.deepEqual(update.parameters.columns.matchingColumns, ['row_number']);
  const mapped = Object.keys(update.parameters.columns.value);
  assert.deepEqual(mapped, ['row_number', 'import_status', 'import_message', 'lead_id', 'processed_at']);
  for (const c of mapped.slice(1)) assert.ok(TABS.Import.includes(c));
});

test('WF00 alert path survives a failing Sheets write, and a failed alert is logged', () => {
  const wf = workflows['WF00-error-handler.json'];
  assert.equal(wf.nodes.find((n) => n.name === 'Append to Errors').onError, 'continueRegularOutput');
  // The email branch hangs off Format Error directly, not off the Sheets write.
  assert.ok(wf.connections['Format Error'].main[0].some((c) => c.node === 'Email Alert'));
  // A failed alert goes to the error output and becomes its own Errors row.
  assert.equal(wf.nodes.find((n) => n.name === 'Email Alert').onError, 'continueErrorOutput');
  assert.deepEqual(wf.connections['Email Alert'].main[1].map((c) => c.node), ['Alert Failure Row']);
  assert.deepEqual(wf.connections['Alert Failure Row'].main[0].map((c) => c.node), ['Append Alert Failure']);
});
