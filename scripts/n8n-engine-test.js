#!/usr/bin/env node
'use strict';

// Runs the generated workflows inside a real n8n engine with Google Sheets and
// Gmail replaced by stub Code nodes (same names, same settings), so the embedded
// Code-node logic, node wiring, executeOnce/alwaysOutputData behaviour, and
// branch order are exercised exactly as n8n runs them. No Google access needed.
//
//   N8N_BIN=/path/to/n8n N8N_USER_FOLDER=/tmp/n8n-test node scripts/n8n-engine-test.js
//
// Use a throwaway N8N_USER_FOLDER: workflows are imported into that instance.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { FIXTURE_IMPORT_ROWS, FIXTURE_SUPPRESSION_ROWS } = require('./build');
const { SETTINGS_ROWS, NICHE_ROWS } = require('../src/schema');

const ROOT = path.resolve(__dirname, '..');
const N8N_BIN = process.env.N8N_BIN;
if (!N8N_BIN) {
  console.error('Set N8N_BIN to the n8n executable.');
  process.exit(2);
}
if (!process.env.N8N_USER_FOLDER) {
  console.error('Set N8N_USER_FOLDER to a throwaway directory.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhq-n8n-'));
const load = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
const withRowNumbers = (rows) => rows.map((r, i) => ({ row_number: i + 2, ...r }));

function stub(node, jsCode) {
  return {
    ...node,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { jsCode },
    credentials: undefined,
  };
}

const emitRows = (rows) => `return ${JSON.stringify(rows.map((r) => ({ json: r })))};`;

function wf01Variant(id, sheetData) {
  const wf = load('WF01-import-dedupe.json');
  const reads = { 'Read Settings': 'Settings', 'Read Niches': 'Niches', 'Read Leads': 'Leads', 'Read Suppression': 'Suppression', 'Read Import': 'Import' };
  wf.nodes = wf.nodes.map((n) => {
    if (reads[n.name]) return stub(n, emitRows(sheetData[reads[n.name]] || []));
    if (n.name === 'Append to Leads' || n.name === 'Update Import Rows') return stub(n, 'return $input.all();');
    return n;
  });
  return { ...wf, id, name: `${wf.name} [engine test ${id}]` };
}

function wf00Variant(id, { failSheets }) {
  const wf = load('WF00-error-handler.json');
  const sample = {
    execution: { id: '987', url: 'http://localhost:5678/workflow/x/executions/987', mode: 'trigger', lastNodeExecuted: 'Read Leads', error: { message: 'Engine test failure lead_id=engine.example' } },
    workflow: { id: 'x', name: 'WF01 Import & Dedupe' },
  };
  wf.nodes = wf.nodes.map((n) => {
    if (n.name === 'On Workflow Error') return stub({ ...n, position: [0, 200] }, emitRows([sample]));
    if (n.name === 'Append to Errors') return stub(n, failSheets ? "throw new Error('simulated Sheets outage');" : 'return $input.all();');
    if (n.name === 'Email Alert') return stub(n, 'return $input.all();');
    return n;
  });
  wf.nodes.push({ parameters: {}, id: 'engine-test-start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [-220, 200] });
  wf.connections.Start = { main: [[{ node: 'On Workflow Error', type: 'main', index: 0 }]] };
  return { ...wf, id, name: `${wf.name} [engine test ${id}]` };
}

function n8n(args) {
  try {
    return { ok: true, out: execFileSync(N8N_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}` };
  }
}

function importAndRun(workflow) {
  const file = path.join(tmp, `${workflow.id}.json`);
  fs.writeFileSync(file, JSON.stringify(workflow));
  const imported = n8n(['import:workflow', `--input=${file}`]);
  assert.ok(imported.ok, `import failed:\n${imported.out}`);
  return n8n(['execute', `--id=${workflow.id}`, '--rawOutput']);
}

function parseRun(out) {
  // n8n prints task-runner log lines before the JSON; the run object starts on a line of its own.
  const lines = out.split('\n');
  const start = lines.indexOf('{');
  const end = lines.lastIndexOf('}');
  assert.ok(start !== -1 && end > start, `no JSON in output:\n${out}`);
  return JSON.parse(lines.slice(start, end + 1).join('\n'));
}

function nodeOutput(run, name) {
  const runs = run.data.resultData.runData[name];
  if (!runs) return null;
  return (runs[0].data?.main?.[0] || []).map((i) => i.json);
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

// The three generated workflows must import cleanly as-is.
for (const file of ['WF00-error-handler.json', 'WF00-selftest-trigger.json', 'WF01-import-dedupe.json']) {
  check(`imports unchanged: ${file}`, () => {
    const wf = { ...load(file), id: `imp${file.slice(0, 4).replace(/\W/g, '')}${file.length}` };
    const target = path.join(tmp, `import-${file}`);
    fs.writeFileSync(target, JSON.stringify(wf));
    const r = n8n(['import:workflow', `--input=${target}`]);
    assert.ok(r.ok, r.out);
  });
}

const settings = withRowNumbers(SETTINGS_ROWS.map(([key, value, notes]) => ({ key, value, notes })));
const niches = withRowNumbers(NICHE_ROWS);
const importRows = withRowNumbers(FIXTURE_IMPORT_ROWS);
const expected = fs
  .readFileSync(path.join(ROOT, 'sheets/test-fixtures/Import-expected-results.csv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.split(',').slice(0, 3));

let firstRun;
check('WF01 run 1: fixture import matches Import-expected-results.csv', () => {
  const r = importAndRun(wf01Variant('wf01run1', { Settings: settings, Niches: niches, Leads: [], Suppression: withRowNumbers(FIXTURE_SUPPRESSION_ROWS), Import: importRows }));
  assert.ok(r.ok, r.out);
  firstRun = parseRun(r.out);
  const updates = nodeOutput(firstRun, 'Update Import Rows');
  assert.equal(updates.length, expected.length);
  for (const [row, , status] of expected) {
    const u = updates.find((x) => String(x.row_number) === row);
    assert.equal(u.import_status, status, `sheet row ${row}`);
  }
  const leads = nodeOutput(firstRun, 'Append to Leads');
  assert.deepEqual(leads.map((l) => l.lead_id), ['fixture-one.example', 'fixture-two.example', 'fixture-nine.example']);
  assert.ok(leads.every((l) => l.stage === 'New Lead' && l.niche_id === 'uk-estate-letting'));
});

check('WF01 run 1: Leads are appended before Import statuses are written', () => {
  const rd = firstRun.data.resultData.runData;
  const order = (name) => rd[name][0].executionIndex;
  assert.ok(order('Append to Leads') < order('Import Status Updates'));
});

// Stubs always run once, so executeOnce on the real Sheets nodes is checked
// statically in tests/workflows.test.js instead.
check('WF01 run 1: Validate & Dedupe ran exactly once', () => {
  assert.equal(firstRun.data.resultData.runData['Validate & Dedupe'].length, 1);
});

check('WF01 run 2: repeat import with updated sheet writes nothing', () => {
  const leads = withRowNumbers(nodeOutput(firstRun, 'Append to Leads'));
  const updates = nodeOutput(firstRun, 'Update Import Rows');
  const importAfter = importRows.map((r) => ({ ...r, ...updates.find((u) => u.row_number === r.row_number) }));
  const r = importAndRun(wf01Variant('wf01run2', { Settings: settings, Niches: niches, Leads: leads, Suppression: withRowNumbers(FIXTURE_SUPPRESSION_ROWS), Import: importAfter }));
  assert.ok(r.ok, r.out);
  const run = parseRun(r.out);
  assert.equal((nodeOutput(run, 'Append to Leads') || []).length, 0);
  assert.equal((nodeOutput(run, 'Update Import Rows') || []).length, 0);
  assert.equal(nodeOutput(run, 'Validate & Dedupe')[0].summary.skippedAlreadyProcessed, importRows.length);
});

check('WF01: empty Leads and Suppression tabs still reach validation (alwaysOutputData)', () => {
  const r = importAndRun(wf01Variant('wf01empty', { Settings: settings, Niches: niches, Leads: [], Suppression: [], Import: importRows.slice(0, 1) }));
  assert.ok(r.ok, r.out);
  assert.equal(nodeOutput(parseRun(r.out), 'Append to Leads').length, 1);
});

check('WF01: inactive niche fails the run and writes nothing', () => {
  const r = importAndRun(wf01Variant('wf01inactive', { Settings: settings, Niches: withRowNumbers([{ ...NICHE_ROWS[0], active: 'FALSE' }]), Leads: [], Suppression: [], Import: importRows }));
  const text = r.out;
  assert.match(text, /is not active/);
  if (r.ok) {
    const run = parseRun(text);
    assert.equal(nodeOutput(run, 'Append to Leads'), null);
    assert.equal(nodeOutput(run, 'Update Import Rows'), null);
  }
});

check('WF00: error becomes an Errors row and an alert email', () => {
  const r = importAndRun(wf00Variant('wf00ok', { failSheets: false }));
  assert.ok(r.ok, r.out);
  const run = parseRun(r.out);
  const row = nodeOutput(run, 'Append to Errors')[0];
  assert.deepEqual(Object.keys(row), ['timestamp', 'workflow', 'node', 'lead_id', 'message']);
  assert.equal(row.lead_id, 'engine.example');
  assert.equal(row.node, 'Read Leads');
  const mail = nodeOutput(run, 'Email Alert')[0];
  assert.equal(mail.alert_email, 'PASTE_FLOWHQ_ALERT_EMAIL_HERE');
  assert.match(mail.email_subject, /WF01 Import & Dedupe failed/);
});

check('WF00: a failing Sheets write does not block the email alert', () => {
  const r = importAndRun(wf00Variant('wf00sheetsdown', { failSheets: true }));
  assert.ok(r.ok, r.out);
  const run = parseRun(r.out);
  assert.equal(nodeOutput(run, 'Email Alert').length, 1);
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
