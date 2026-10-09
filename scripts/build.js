#!/usr/bin/env node
'use strict';

// Generates every committed artifact from src/:
//   sheets/*.csv                     tab templates (exact headers, seed rows)
//   sheets/test-fixtures/*.csv       fictional rows for the Phase 2 manual test
//   workflows/*.json                 n8n workflows with the tested logic embedded
//
//   node scripts/build.js           write files
//   node scripts/build.js --check   exit 1 if any committed file is out of date

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TABS, SETTINGS_ROWS, NICHE_ROWS } = require('../src/schema');
const { processImport } = require('../src/wf01-import-logic');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_MARKER = '// ---- EXPORT (stripped when embedded in n8n) ----';
const SHEET_ID_PLACEHOLDER = 'PASTE_YOUR_GOOGLE_SHEET_ID_HERE';
const ALERT_EMAIL_PLACEHOLDER = 'PASTE_FLOWHQ_ALERT_EMAIL_HERE';

// ---------- CSV ----------

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(Array.isArray(row) ? row[headers.indexOf(h)] : row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Fictional fixtures. Every domain uses the reserved .example TLD (RFC 2606),
// so these can never match a real business or mailbox.
const FIXTURE_IMPORT_ROWS = [
  { company_name: 'Fixture One Lettings Ltd', website: 'https://www.fixture-one.example', city: 'Reading', region: 'Berkshire', contact_email: 'info@fixture-one.example', email_source_url: 'https://www.fixture-one.example/contact', discovery_source: 'manual-test', discovery_source_url: 'https://www.fixture-one.example/', discovered_at: '2026-10-09' },
  { company_name: 'Fixture Two Estates Ltd', website: 'fixture-two.example', city: '', region: '', contact_email: 'office@fixture-two-mail.example', email_source_url: 'https://directory.example/agents/fixture-two', discovery_source: 'manual-test', discovery_source_url: '', discovered_at: '' },
  { company_name: 'Fixture Three Homes Ltd', website: 'https://fixture-three.example', city: 'Leicester', contact_email: 'info@fixture-three.example', email_source_url: '', discovery_source: 'manual-test' },
  { company_name: 'Fixture Four Property Ltd', website: 'https://fixture-four.example', city: 'Norwich', contact_email: 'info@fixture-four', email_source_url: 'https://fixture-four.example/contact', discovery_source: 'manual-test' },
  { company_name: 'Fixture One Lettings (Branch)', website: 'https://branch.fixture-one.example', city: 'Reading', contact_email: 'branch@fixture-one.example', email_source_url: 'https://branch.fixture-one.example/contact', discovery_source: 'manual-test' },
  { company_name: 'Fixture Six Lettings Ltd', website: 'https://fixture-six.example', city: 'Reading', contact_email: 'info@fixture-six.example', email_source_url: 'https://fixture-six.example/contact', discovery_source: 'manual-test' },
  { company_name: 'Fixture Seven Estates Ltd', website: 'https://www.fixture-seven.example', city: 'Leicester', contact_email: 'sales@fixture-seven.example', email_source_url: 'https://www.fixture-seven.example/contact', discovery_source: 'manual-test' },
  { company_name: 'Fixture Eight Lettings Ltd', website: 'https://fixture-eight.example', city: 'Norwich', contact_email: 'a@fixture-eight.example; b@fixture-eight.example', email_source_url: 'https://fixture-eight.example/contact', discovery_source: 'manual-test' },
  { company_name: 'Fixture Nine Property Ltd', website: 'https://fixture-nine.example/', city: 'Norwich', contact_email: 'MAILTO:Hello@Fixture-Nine.example', email_source_url: 'https://fixture-nine.example/about-us', discovery_source: 'manual-test', notes: 'TEST FIXTURE: delete after Phase 2 validation' },
];

const FIXTURE_SUPPRESSION_ROWS = [
  { email: 'info@fixture-six.example', domain: '', reason: 'manual', source: 'phase-2-test', added_at: '2026-10-09' },
  { email: '', domain: 'fixture-seven.example', reason: 'manual', source: 'phase-2-test', added_at: '2026-10-09' },
];

function fixtureExpectations() {
  const importRows = FIXTURE_IMPORT_ROWS.map((r, i) => ({ row_number: i + 2, ...r }));
  const result = processImport({
    settingsRows: SETTINGS_ROWS.map(([key, value]) => ({ key, value })),
    nichesRows: NICHE_ROWS,
    leadsRows: [],
    suppressionRows: FIXTURE_SUPPRESSION_ROWS,
    importRows,
    now: 'RUN_TIME',
  });
  return importRows.map((r) => {
    const u = result.importUpdates.find((x) => x.row_number === r.row_number);
    return { sheet_row: r.row_number, company_name: r.company_name, expected_import_status: u.import_status, expected_lead_id: u.lead_id, expected_import_message: u.import_message };
  });
}

// ---------- n8n workflow helpers ----------

function nodeId(workflow, name) {
  const h = crypto.createHash('sha256').update(`${workflow}/${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function embeddedSource(file) {
  const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const cut = src.indexOf(EXPORT_MARKER);
  if (cut === -1) throw new Error(`${file} is missing the EXPORT marker`);
  return src.slice(0, cut).replace(/^'use strict';\n/, '').trimEnd();
}

function sheetRef(sheetName) {
  return {
    documentId: { __rl: true, value: "={{ $('Config').first().json.sheet_id }}", mode: 'id' },
    sheetName: { __rl: true, value: sheetName, mode: 'name' },
  };
}

function readNode(wf, name, sheetName, position) {
  return {
    parameters: { ...sheetRef(sheetName), options: {} },
    id: nodeId(wf, name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    // Run once even though the previous node emits many rows, and keep going
    // when a tab has headers but no data (e.g. an empty Suppression list).
    executeOnce: true,
    alwaysOutputData: true,
  };
}

function configNode(wf, assignments, position) {
  return {
    parameters: {
      assignments: {
        assignments: assignments.map(([name, value]) => ({ id: nodeId(wf, `config-${name}`), name, value, type: 'string' })),
      },
      options: {},
    },
    id: nodeId(wf, 'Config'),
    name: 'Config',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position,
  };
}

function codeNode(wf, name, jsCode, position) {
  return {
    parameters: { jsCode },
    id: nodeId(wf, name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function stickyNote(wf, name, content, position, width = 480, height = 300) {
  return {
    parameters: { content, height, width },
    id: nodeId(wf, name),
    name,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position,
  };
}

function chain(...names) {
  const connections = {};
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = connections[names[i]] || { main: [[]] };
    connections[names[i]].main[0].push({ node: names[i + 1], type: 'main', index: 0 });
  }
  return connections;
}

function mergeConnections(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [from, value] of Object.entries(part)) {
      out[from] = out[from] || { main: [[]] };
      out[from].main[0].push(...value.main[0]);
    }
  }
  return out;
}

function workflow(name, nodes, connections) {
  return {
    name,
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

// ---------- WF01 Import & Dedupe ----------

function buildWf01() {
  const wf = 'WF01';
  const validateCode = [
    '// Generated from src/wf01-import-logic.js by scripts/build.js. Do not edit here;',
    '// edit the source file, run `npm run build`, and re-import the workflow.',
    embeddedSource('wf01-import-logic.js'),
    '',
    '// ---- n8n glue ----',
    'const rowsFrom = (nodeName) =>',
    '  $(nodeName).all().map((item) => item.json).filter((row) => row && Object.keys(row).length > 0);',
    '',
    'const result = processImport({',
    "  settingsRows: rowsFrom('Read Settings'),",
    "  nichesRows: rowsFrom('Read Niches'),",
    "  leadsRows: rowsFrom('Read Leads'),",
    "  suppressionRows: rowsFrom('Read Suppression'),",
    "  importRows: rowsFrom('Read Import'),",
    '  now: new Date().toISOString(),',
    '});',
    '',
    'return [{ json: result }];',
  ].join('\n');

  const importStatusColumns = ['row_number', 'import_status', 'import_message', 'lead_id', 'processed_at'];

  const nodes = [
    stickyNote(
      wf,
      'About WF01',
      [
        '## WF01 Import & Dedupe',
        'Reads new rows from the **Import** tab, validates and normalises them, rejects duplicates and suppressed contacts, appends good rows to **Leads** as `New Lead`, and writes a status back to each Import row.',
        '',
        '**Setup:** set `sheet_id` in **Config** and pick your Google Sheets credential in every Sheets node.',
        '',
        'Logic lives in `src/wf01-import-logic.js` (unit-tested). Rows that already have an `import_status` are skipped, so re-running is safe.',
      ].join('\n'),
      [-60, -360],
      620,
      260,
    ),
    { parameters: {}, id: nodeId(wf, 'Run Import'), name: 'Run Import', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER]], [220, 0]),
    readNode(wf, 'Read Settings', 'Settings', [440, 0]),
    readNode(wf, 'Read Niches', 'Niches', [660, 0]),
    readNode(wf, 'Read Leads', 'Leads', [880, 0]),
    readNode(wf, 'Read Suppression', 'Suppression', [1100, 0]),
    readNode(wf, 'Read Import', 'Import', [1320, 0]),
    codeNode(wf, 'Validate & Dedupe', validateCode, [1540, 0]),
    codeNode(wf, 'Leads To Append', "return $input.first().json.leadsToAppend.map((lead) => ({ json: lead }));", [1760, -120]),
    {
      parameters: {
        operation: 'append',
        ...sheetRef('Leads'),
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
        // RAW keeps phone numbers and dates exactly as typed; 'error' refuses to
        // silently add a new column if a field name ever drifts from the schema.
        options: { cellFormat: 'RAW', handlingExtraData: 'error' },
      },
      id: nodeId(wf, 'Append to Leads'),
      name: 'Append to Leads',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [1980, -120],
    },
    codeNode(wf, 'Import Status Updates', "return $('Validate & Dedupe').first().json.importUpdates.map((update) => ({ json: update }));", [1760, 120]),
    {
      parameters: {
        operation: 'update',
        ...sheetRef('Import'),
        columns: {
          mappingMode: 'defineBelow',
          value: Object.fromEntries(importStatusColumns.map((c) => [c, `={{ $json.${c} }}`])),
          matchingColumns: ['row_number'],
          schema: importStatusColumns.map((c) => ({
            id: c,
            displayName: c,
            required: false,
            defaultMatch: false,
            display: true,
            type: c === 'row_number' ? 'number' : 'string',
            canBeUsedToMatch: true,
            ...(c === 'row_number' ? { readOnly: true, removed: false } : {}),
          })),
        },
        options: { cellFormat: 'RAW' },
      },
      id: nodeId(wf, 'Update Import Rows'),
      name: 'Update Import Rows',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [1980, 120],
    },
  ];

  // The Leads branch is placed above the status branch, so with v1 execution
  // order the leads are appended first. If that append fails, no Import row is
  // marked IMPORTED and a re-run is still safe (dedupe catches partial appends).
  const connections = mergeConnections(
    chain('Run Import', 'Config', 'Read Settings', 'Read Niches', 'Read Leads', 'Read Suppression', 'Read Import', 'Validate & Dedupe'),
    chain('Validate & Dedupe', 'Leads To Append', 'Append to Leads'),
    chain('Validate & Dedupe', 'Import Status Updates', 'Update Import Rows'),
  );
  return workflow('WF01 Import & Dedupe', nodes, connections);
}

// ---------- WF00 Error Handler ----------

function buildWf00() {
  const wf = 'WF00';
  const formatCode = [
    '// Generated from src/wf00-format-error.js by scripts/build.js. Do not edit here;',
    '// edit the source file, run `npm run build`, and re-import the workflow.',
    embeddedSource('wf00-format-error.js'),
    '',
    '// ---- n8n glue ----',
    "const { row, emailSubject, emailBody } = formatError($('On Workflow Error').first().json, new Date().toISOString());",
    "return [{ json: { ...row, email_subject: emailSubject, email_body: emailBody, alert_email: $('Config').first().json.alert_email } }];",
  ].join('\n');

  const nodes = [
    stickyNote(
      wf,
      'About WF00',
      [
        '## WF00 Error Handler',
        'Runs when any workflow that names it as its **Error workflow** fails in a production (trigger/scheduled) run. Writes a row to the **Errors** tab and emails FlowHQ.',
        '',
        '**Setup:** set `sheet_id` and `alert_email` in **Config**; pick credentials in **Append to Errors** and **Email Alert**. If Gmail is not connected yet, disable **Email Alert** (right-click → Deactivate) until Phase 5.',
        '',
        'n8n does **not** call error workflows for manual "Execute workflow" runs; those errors show in the editor.',
      ].join('\n'),
      [-60, -380],
      660,
      280,
    ),
    { parameters: {}, id: nodeId(wf, 'On Workflow Error'), name: 'On Workflow Error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0] },
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER], ['alert_email', ALERT_EMAIL_PLACEHOLDER]], [220, 0]),
    codeNode(wf, 'Format Error', formatCode, [440, 0]),
    codeNode(
      wf,
      'Errors Row',
      'const { timestamp, workflow, node, lead_id, message } = $input.first().json;\nreturn [{ json: { timestamp, workflow, node, lead_id, message } }];',
      [660, -120],
    ),
    {
      parameters: {
        operation: 'append',
        ...sheetRef('Errors'),
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
        options: { cellFormat: 'RAW', handlingExtraData: 'error' },
      },
      id: nodeId(wf, 'Append to Errors'),
      name: 'Append to Errors',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [880, -120],
      // A failing Sheets write must not stop the email alert.
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        sendTo: '={{ $json.alert_email }}',
        subject: '={{ $json.email_subject }}',
        emailType: 'text',
        message: '={{ $json.email_body }}',
        options: { appendAttribution: false },
      },
      id: nodeId(wf, 'Email Alert'),
      name: 'Email Alert',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [660, 120],
      onError: 'continueRegularOutput',
    },
  ];

  const connections = mergeConnections(
    chain('On Workflow Error', 'Config', 'Format Error'),
    chain('Format Error', 'Errors Row', 'Append to Errors'),
    chain('Format Error', 'Email Alert'),
  );
  return workflow('WF00 Error Handler', nodes, connections);
}

// ---------- WF00 self-test helper ----------

function buildWf00SelfTest() {
  const wf = 'WF00-selftest';
  const nodes = [
    stickyNote(
      wf,
      'About self-test',
      [
        '## WF00 self-test (temporary)',
        '1. In this workflow\'s **Settings**, set **Error workflow** to *WF00 Error Handler*.',
        '2. **Activate** this workflow, wait up to 2 minutes, then **deactivate** it.',
        '3. Check the Errors tab and your inbox for "FlowHQ WF00 self-test".',
        '',
        'Deactivate it straight away: while active it fails once a minute by design.',
      ].join('\n'),
      [-60, -320],
      560,
      240,
    ),
    {
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
      id: nodeId(wf, 'Every Minute'),
      name: 'Every Minute',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    {
      parameters: { errorMessage: 'FlowHQ WF00 self-test: this failure is intentional. lead_id=selftest.example' },
      id: nodeId(wf, 'Fail On Purpose'),
      name: 'Fail On Purpose',
      type: 'n8n-nodes-base.stopAndError',
      typeVersion: 1,
      position: [220, 0],
    },
  ];
  return workflow('WF00 Self-Test (temporary)', nodes, chain('Every Minute', 'Fail On Purpose'));
}

// ---------- outputs ----------

function outputs() {
  const files = {};
  for (const [tab, headers] of Object.entries(TABS)) {
    let rows = [];
    if (tab === 'Settings') rows = SETTINGS_ROWS;
    if (tab === 'Niches') rows = NICHE_ROWS;
    files[`sheets/${tab}.csv`] = toCsv(headers, rows);
  }
  files['sheets/test-fixtures/Import-test-rows.csv'] = toCsv(TABS.Import, FIXTURE_IMPORT_ROWS);
  files['sheets/test-fixtures/Suppression-test-rows.csv'] = toCsv(TABS.Suppression, FIXTURE_SUPPRESSION_ROWS);
  files['sheets/test-fixtures/Import-expected-results.csv'] = toCsv(
    ['sheet_row', 'company_name', 'expected_import_status', 'expected_lead_id', 'expected_import_message'],
    fixtureExpectations(),
  );
  files['workflows/WF00-error-handler.json'] = `${JSON.stringify(buildWf00(), null, 2)}\n`;
  files['workflows/WF00-selftest-trigger.json'] = `${JSON.stringify(buildWf00SelfTest(), null, 2)}\n`;
  files['workflows/WF01-import-dedupe.json'] = `${JSON.stringify(buildWf01(), null, 2)}\n`;
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [rel, content] of Object.entries(outputs())) {
    const abs = path.join(ROOT, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      stale.push(rel);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      console.log(`wrote ${rel}`);
    }
  }
  if (check && stale.length) {
    console.error(`Out of date (run npm run build): ${stale.join(', ')}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { outputs, FIXTURE_IMPORT_ROWS, FIXTURE_SUPPRESSION_ROWS, SHEET_ID_PLACEHOLDER, ALERT_EMAIL_PLACEHOLDER };
