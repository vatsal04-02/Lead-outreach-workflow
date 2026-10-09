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

const IMPORTS_START = '// ---- IMPORTS (stripped when embedded in n8n) ----';
const IMPORTS_END = '// ---- END IMPORTS ----';

// A src/ module as it runs inside an n8n Code node: no 'use strict' line, no
// require() block, no module.exports tail.
function embeddedSource(file) {
  let src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const cut = src.indexOf(EXPORT_MARKER);
  if (cut === -1) throw new Error(`${file} is missing the EXPORT marker`);
  src = src.slice(0, cut);
  const a = src.indexOf(IMPORTS_START);
  if (a !== -1) {
    const b = src.indexOf(IMPORTS_END, a);
    if (b === -1) throw new Error(`${file} has an unterminated IMPORTS block`);
    src = src.slice(0, a) + src.slice(b + IMPORTS_END.length);
  }
  if (/\brequire\(/.test(src)) throw new Error(`${file} uses require() outside its IMPORTS block`);
  return src.replace(/^'use strict';\n/, '').trimEnd();
}

// Shared modules first, workflow module last; all share one Code-node scope.
function embedModules(files, glue) {
  return [
    `// Generated from ${files.map((f) => `src/${f}`).join(' + ')} by scripts/build.js.`,
    '// Do not edit here: edit the source, run `npm run build`, and re-import the workflow.',
    ...files.map((f) => `\n// ===== src/${f} =====\n${embeddedSource(f)}`),
    '',
    '// ---- n8n glue ----',
    ...glue,
  ].join('\n');
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

// Reads the tab with the header row as the first data row (header row 1, first
// data row 1), so the header names come back as an item whose values are the
// column names. Used to fail closed when a tab lacks columns a workflow writes.
function headerReadNode(wf, name, sheetName, position) {
  return {
    ...readNode(wf, name, sheetName, position),
    parameters: {
      ...sheetRef(sheetName),
      options: { dataLocationOnSheet: { values: { rangeDefinition: 'specifyRange', headerRow: 1, firstDataRow: 1 } } },
    },
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
  const validateCode = embedModules(['lib/common.js', 'wf01-import-logic.js'], [
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
  ]);

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
  const formatCode = embedModules(['wf00-format-error.js'], [
    "const { row, emailSubject, emailBody } = formatError($('On Workflow Error').first().json, new Date().toISOString());",
    "return [{ json: { ...row, email_subject: emailSubject, email_body: emailBody, alert_email: $('Config').first().json.alert_email } }];",
  ]);

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
      // A failed alert goes down the error branch and is logged, never assumed sent.
      onError: 'continueErrorOutput',
    },
    codeNode(wf, 'Alert Failure Row', embedModules(['wf00-format-error.js'], [
      "const original = $('Format Error').first().json;",
      'return [{ json: formatAlertFailure(original, $input.first().json.error, new Date().toISOString()) }];',
    ]), [880, 220]),
    { ...appendNode(wf, 'Append Alert Failure', 'Errors', [1100, 220]), onError: 'continueRegularOutput' },
  ];

  const connections = edges([
    ...chainEdges('On Workflow Error', 'Config', 'Format Error'),
    ...chainEdges('Format Error', 'Errors Row', 'Append to Errors'),
    connect('Format Error', 'Email Alert'),
    connect('Email Alert', 'Alert Failure Row', 1),
    connect('Alert Failure Row', 'Append Alert Failure'),
  ]);
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

// ---------- shared node builders for WF02–WF06 ----------

const USER_AGENT = 'FlowHQ-Research/1.0 (business research; low volume)';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_AI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const GLUE_ROWS_FROM = [
  'const rowsFrom = (nodeName) =>',
  '  $(nodeName).all().map((item) => item.json).filter((row) => row && Object.keys(row).length > 0);',
];

function columnSchema(columns) {
  return columns.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }));
}

// Updates only the listed columns of the row whose `matchOn` value matches.
// Every listed column is written, so the logic always supplies all of them.
function updateNode(wf, name, sheetName, columns, matchOn, position) {
  return {
    parameters: {
      operation: 'update',
      ...sheetRef(sheetName),
      columns: {
        mappingMode: 'defineBelow',
        value: Object.fromEntries(columns.map((c) => [c, `={{ $json.${c} }}`])),
        matchingColumns: [matchOn],
        schema: columnSchema(columns),
      },
      options: { cellFormat: 'RAW' },
    },
    id: nodeId(wf, name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
  };
}

function appendNode(wf, name, sheetName, position, extra = {}) {
  return {
    parameters: {
      operation: 'append',
      ...sheetRef(sheetName),
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: { cellFormat: 'RAW', handlingExtraData: 'error' },
    },
    id: nodeId(wf, name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position,
    ...extra,
  };
}

// HTTP Request with "empty URL = skip" semantics: items whose URL expression is
// empty fail immediately (no network call) and continue as error items, which the
// next Code node ignores because it knows the item was not meant to be fetched.
function httpNode(wf, name, { method = 'GET', urlField, auth, jsonBodyField, responseFormat, batchSize = 1, batchInterval = 1000, timeout = 20000 }, position) {
  const parameters = { method, url: `={{ $json.${urlField} }}` };
  if (auth) {
    parameters.authentication = 'genericCredentialType';
    parameters.genericAuthType = auth;
  }
  parameters.sendHeaders = true;
  parameters.headerParameters = { parameters: [{ name: 'User-Agent', value: USER_AGENT }] };
  if (jsonBodyField) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = `={{ JSON.stringify($json.${jsonBodyField}) }}`;
  }
  parameters.options = {
    batching: { batch: { batchSize, batchInterval } },
    response: { response: { responseFormat } },
    timeout,
  };
  return {
    parameters,
    id: nodeId(wf, name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    onError: 'continueRegularOutput',
  };
}

function manualTrigger(wf, name, position) {
  return { parameters: {}, id: nodeId(wf, name), name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position };
}

function scheduleTrigger(wf, name, interval, position) {
  return { parameters: { rule: { interval: [interval] } }, id: nodeId(wf, name), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position };
}

function splitCode(wf, name, expression, position) {
  return codeNode(wf, name, `return ${expression}.map((json) => ({ json }));`, position);
}

function connect(from, to, output = 0) {
  return { from, to, output };
}

// Builds n8n connections from a list of edges (supports error outputs).
function edges(list) {
  const out = {};
  for (const e of list) {
    out[e.from] = out[e.from] || { main: [] };
    while (out[e.from].main.length <= e.output) out[e.from].main.push([]);
    out[e.from].main[e.output].push({ node: e.to, type: 'main', index: 0 });
  }
  return out;
}

function chainEdges(...names) {
  return names.slice(0, -1).map((n, i) => connect(n, names[i + 1]));
}

// ---------- WF02 Research & Qualify ----------

function buildWf02() {
  const wf = 'WF02';
  const mods = ['lib/common.js', 'lib/gemini.js', 'lib/robots.js', 'lib/categories.js', 'lib/discovery.js', 'wf02-research-logic.js'];
  const { WF02_COLUMNS } = require('../src/wf02-research-logic');
  const nodes = [
    stickyNote(wf, 'About WF02', [
      '## WF02 Discovery, Research & Qualify (manual; never sends email)',
      '**Discovery** (only when Settings `DISCOVERY_ENABLED` is TRUE): searches OpenStreetMap through the Overpass API for businesses with a website, by the active campaign\'s regions × industries, rotating searches via the **Discovery_Log** tab. New businesses are added to Leads as `New Lead` (no contact details taken from OSM).',
      '',
      '**Research**: up to `RESEARCH_BATCH_SIZE` `New Lead` rows: robots.txt → homepage → ≤2 pages → Gemini proposes opportunities that must cite verbatim excerpts → deterministic contact extraction, caps and gates. Outcome: **Qualified**, **Needs Review**, **Disqualified**, or unchanged with `research_status = RETRY`.',
      '',
      'No company-registry lookups. Website text is untrusted: suspected prompt injection forces **Needs Review**. Refuses to run if the Leads header lacks a column it writes.',
      '',
      '**Setup:** `sheet_id`, `gemini_model`, `ai_endpoint`, `overpass_url` in **Config**; Sheets credential on Sheets nodes; *Header Auth* (`x-goog-api-key`) on **Gemini**. Overpass, robots.txt and websites need no credential.',
    ].join('\n'), [-60, -620], 860, 340),
    manualTrigger(wf, 'Run Research', [0, 0]),
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER], ['gemini_model', DEFAULT_GEMINI_MODEL], ['ai_endpoint', DEFAULT_AI_ENDPOINT], ['overpass_url', DEFAULT_OVERPASS_URL]], [220, 0]),
    readNode(wf, 'Read Settings', 'Settings', [440, 0]),
    readNode(wf, 'Read Niches', 'Niches', [660, 0]),
    readNode(wf, 'Read Leads', 'Leads', [880, 0]),
    readNode(wf, 'Read Suppression', 'Suppression', [1100, 0]),
    readNode(wf, 'Read Discovery_Log', 'Discovery_Log', [1320, 0]),
    headerReadNode(wf, 'Read Leads Header', 'Leads', [1540, 0]),
    codeNode(wf, 'Select Batch', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      'const now = new Date().toISOString();',
      'const research = selectResearchBatch({',
      "  settingsRows: rowsFrom('Read Settings'),",
      "  nichesRows: rowsFrom('Read Niches'),",
      "  leadsRows: rowsFrom('Read Leads'),",
      "  suppressionRows: rowsFrom('Read Suppression'),",
      "  leadsHeaderRows: rowsFrom('Read Leads Header'),",
      '  now,',
      '});',
      'const discovery = planDiscoveryFromRows({',
      "  settingsRows: rowsFrom('Read Settings'),",
      "  nichesRows: rowsFrom('Read Niches'),",
      "  discoveryLogRows: rowsFrom('Read Discovery_Log'),",
      "  overpassUrl: $('Config').first().json.overpass_url,",
      '  now,',
      '});',
      'return [{ json: { ...research, discovery } }];',
    ]), [1760, 0]),
    // Branch 1 (top): discovery.
    splitCode(wf, 'Discovery Queries', '$input.first().json.discovery.queries', [1980, -420]),
    httpNode(wf, 'Overpass', { urlField: 'request_url', responseFormat: 'json', batchInterval: 5000, timeout: 90000 }, [2200, -420]),
    codeNode(wf, 'Normalise Discoveries', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      "const queries = $('Discovery Queries').all().map((i) => i.json);",
      'const responses = [];',
      '$input.all().forEach((item, i) => { responses[pairedIndex(item, i)] = item.json; });',
      "const plan = $('Select Batch').first().json.discovery;",
      'return [{ json: normaliseDiscoveries({',
      '  queries,',
      '  responses,',
      "  leadsRows: rowsFrom('Read Leads'),",
      "  suppressionRows: rowsFrom('Read Suppression'),",
      '  niche: plan.niche,',
      '  maxNew: plan.maxNew,',
      '  now: new Date().toISOString(),',
      '}) }];',
    ]), [2420, -420]),
    splitCode(wf, 'New Discovered Leads', '$input.first().json.newLeads', [2640, -500]),
    appendNode(wf, 'Append Discovered Leads', 'Leads', [2860, -500]),
    splitCode(wf, 'Discovery Log Rows', "$('Normalise Discoveries').first().json.logRows", [2640, -340]),
    appendNode(wf, 'Append Discovery_Log', 'Discovery_Log', [2860, -340]),
    // Branch 2: suppressed leads.
    splitCode(wf, 'Suppressed Leads', "$('Select Batch').first().json.immediateUpdates", [1980, -180]),
    updateNode(wf, 'Update Leads (Suppressed)', 'Leads', WF02_COLUMNS, 'lead_id', [2200, -180]),
    // Branch 3 (bottom): research.
    splitCode(wf, 'Research Items', "$('Select Batch').first().json.researchItems", [1980, 100]),
    httpNode(wf, 'Fetch Robots', { urlField: 'robots_url', responseFormat: 'text', timeout: 10000 }, [2200, 100]),
    codeNode(wf, 'Robots Gate', embedModules(mods, [
      "const research = $('Research Items').all().map((i) => i.json);",
      'return $input.all().map((item, i) => {',
      '  const r = research[pairedIndex(item, i)];',
      '  return { json: robotsGate(r, r.robots_url ? item.json : {}) };',
      '});',
    ]), [2420, 100]),
    httpNode(wf, 'Fetch Homepage', { urlField: 'request_url', responseFormat: 'text' }, [2640, 100]),
    { ...codeNode(wf, 'Plan Pages', embedModules(mods, [
      "const gated = $('Robots Gate').all().map((i) => i.json);",
      'const out = [];',
      '$input.all().forEach((item, i) => {',
      '  const src = gated[pairedIndex(item, i)];',
      "  const html = src && src.request_url && !item.json.error && typeof item.json.data === 'string' ? item.json.data : '';",
      '  if (src && html) planPagesForLead(src, html).forEach((p) => out.push({ json: p }));',
      '});',
      'return out;',
    ]), [2860, 100]), alwaysOutputData: true },
    httpNode(wf, 'Fetch Pages', { urlField: 'request_url', responseFormat: 'text' }, [3080, 100]),
    codeNode(wf, 'Assemble Research', embedModules(mods, [
      "const gated = $('Robots Gate').all().map((i) => i.json);",
      "const plans = $('Plan Pages').all().map((i) => i.json);",
      'const homeByLead = new Map();',
      "$('Fetch Homepage').all().forEach((item, i) => { const r = gated[pairedIndex(item, i)]; if (r && r.request_url) homeByLead.set(r.lead_id, item.json); });",
      'const pagesByLead = new Map();',
      '$input.all().forEach((item, i) => {',
      '  const plan = plans[pairedIndex(item, i)];',
      '  if (!plan || !plan.lead_id) return;',
      '  if (!pagesByLead.has(plan.lead_id)) pagesByLead.set(plan.lead_id, []);',
      '  pagesByLead.get(plan.lead_id).push({ url: plan.request_url, response: item.json });',
      '});',
      "return gated.map((r) => ({ json: assembleResearch(r, homeByLead.get(r.lead_id) || { error: 'homepage not fetched' }, pagesByLead.get(r.lead_id) || []) }));",
    ]), [3300, 100]),
    codeNode(wf, 'Build AI Requests', embedModules(mods, [
      "const cfg = $('Config').first().json;",
      'return $input.all().map((item) => ({ json: { ...item.json, ...buildAiRequest(item.json, cfg.gemini_model, cfg.ai_endpoint) } }));',
    ]), [3520, 100]),
    httpNode(wf, 'Gemini', { method: 'POST', urlField: 'request_url', auth: 'httpHeaderAuth', jsonBodyField: 'ai_body', responseFormat: 'json', batchInterval: 4500, timeout: 60000 }, [3740, 100]),
    codeNode(wf, 'Score & Gate', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      "const built = $('Build AI Requests').all().map((i) => i.json);",
      "const suppressionRows = rowsFrom('Read Suppression');",
      'const now = new Date().toISOString();',
      'return $input.all().map((item, i) => {',
      '  const b = built[pairedIndex(item, i)];',
      '  return { json: scoreAndGate({ assembled: b, aiResponse: b.request_url ? item.json : {}, suppressionRows, now }) };',
      '});',
    ]), [3960, 100]),
    updateNode(wf, 'Update Leads (Research)', 'Leads', WF02_COLUMNS, 'lead_id', [4180, 100]),
  ];
  const connections = edges([
    ...chainEdges('Run Research', 'Config', 'Read Settings', 'Read Niches', 'Read Leads', 'Read Suppression', 'Read Discovery_Log', 'Read Leads Header', 'Select Batch'),
    ...chainEdges('Select Batch', 'Discovery Queries', 'Overpass', 'Normalise Discoveries'),
    ...chainEdges('Normalise Discoveries', 'New Discovered Leads', 'Append Discovered Leads'),
    ...chainEdges('Normalise Discoveries', 'Discovery Log Rows', 'Append Discovery_Log'),
    ...chainEdges('Select Batch', 'Suppressed Leads', 'Update Leads (Suppressed)'),
    ...chainEdges('Select Batch', 'Research Items', 'Fetch Robots', 'Robots Gate', 'Fetch Homepage', 'Plan Pages', 'Fetch Pages', 'Assemble Research', 'Build AI Requests', 'Gemini', 'Score & Gate', 'Update Leads (Research)'),
  ]);
  return workflow('WF02 Discovery, Research & Qualify', nodes, connections);
}

// ---------- WF03 Draft Generation ----------

function buildWf03() {
  const wf = 'WF03';
  const mods = ['lib/common.js', 'lib/gemini.js', 'lib/drafting.js', 'wf03-draft-logic.js'];
  const { WF03_DRAFT_COLUMNS, WF03_RECHECK_COLUMNS } = require('../src/wf03-draft-logic');
  const nodes = [
    stickyNote(wf, 'About WF03', [
      '## WF03 Draft Generation (manual)',
      '**Qualified** leads get a draft from the niche template. Gemini writes only the subject and one observation sentence; if that fails the checks, a sentence quoting the stored evidence is used. Passing drafts move to **Draft Ready** with `approval_status = Pending`.',
      '',
      'Drafts you set to **Needs Edit** and then edit by hand are re-checked on the next run.',
      '',
      '**Setup:** `sheet_id`, `gemini_model`, `ai_endpoint` in **Config**; Sheets credential; *Header Auth* credential on **Gemini**. Settings `SENDER_NAME`, `BUSINESS_LEGAL_NAME`, `BUSINESS_POSTAL_ADDRESS`, `WEBSITE_URL`, `PRIVACY_URL` must be filled. The campaign\'s `outreach_language` must match the template language.',
    ].join('\n'), [-60, -440], 760, 280),
    manualTrigger(wf, 'Run Drafting', [0, 0]),
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER], ['gemini_model', DEFAULT_GEMINI_MODEL], ['ai_endpoint', DEFAULT_AI_ENDPOINT]], [220, 0]),
    readNode(wf, 'Read Settings', 'Settings', [440, 0]),
    readNode(wf, 'Read Niches', 'Niches', [660, 0]),
    readNode(wf, 'Read Leads', 'Leads', [880, 0]),
    readNode(wf, 'Read Suppression', 'Suppression', [1100, 0]),
    codeNode(wf, 'Select Drafts', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      'const result = selectDrafts({',
      "  settingsRows: rowsFrom('Read Settings'),",
      "  nichesRows: rowsFrom('Read Niches'),",
      "  leadsRows: rowsFrom('Read Leads'),",
      "  suppressionRows: rowsFrom('Read Suppression'),",
      "  model: $('Config').first().json.gemini_model,",
      "  endpoint: $('Config').first().json.ai_endpoint,",
      '  now: new Date().toISOString(),',
      '});',
      'return [{ json: result }];',
    ]), [1320, 0]),
    splitCode(wf, 'Recheck Items', '$input.first().json.recheck', [1540, -200]),
    updateNode(wf, 'Update Leads (Recheck)', 'Leads', WF03_RECHECK_COLUMNS, 'lead_id', [1760, -200]),
    splitCode(wf, 'Draft Items', "$('Select Drafts').first().json.generate", [1540, 100]),
    httpNode(wf, 'Gemini', { method: 'POST', urlField: 'request_url', auth: 'httpHeaderAuth', jsonBodyField: 'ai_body', responseFormat: 'json', batchInterval: 4500, timeout: 60000 }, [1760, 100]),
    codeNode(wf, 'Assemble Drafts', embedModules(mods, [
      "const items = $('Draft Items').all().map((i) => i.json);",
      'const now = new Date().toISOString();',
      'return $input.all().map((item, i) => ({ json: assembleDraft({ item: items[pairedIndex(item, i)], aiResponse: item.json, now }) }));',
    ]), [1980, 100]),
    updateNode(wf, 'Update Leads (Drafts)', 'Leads', WF03_DRAFT_COLUMNS, 'lead_id', [2200, 100]),
  ];
  const connections = edges([
    ...chainEdges('Run Drafting', 'Config', 'Read Settings', 'Read Niches', 'Read Leads', 'Read Suppression', 'Select Drafts'),
    ...chainEdges('Select Drafts', 'Recheck Items', 'Update Leads (Recheck)'),
    ...chainEdges('Select Drafts', 'Draft Items', 'Gemini', 'Assemble Drafts', 'Update Leads (Drafts)'),
  ]);
  return workflow('WF03 Draft Generation', nodes, connections);
}

// ---------- WF04 Approved Sender ----------

function buildWf04() {
  const wf = 'WF04';
  const mods = ['lib/common.js', 'lib/drafting.js', 'wf04-send-logic.js'];
  const { WF04_LOCK_COLUMNS, WF04_RESULT_COLUMNS, WF04_NOTE_COLUMNS } = require('../src/wf04-send-logic');
  const nodes = [
    stickyNote(wf, 'About WF04', [
      '## WF04 Approved Sender (scheduled, every 10 minutes)',
      'Sends **at most one** approved email per run, only if: `SENDING_ENABLED` is exactly TRUE, it is a `SEND_DAYS` day inside the window (niche time zone), the daily limit, spacing and failure breaker allow it, and the lead passes suppression, duplicate and draft re-checks. `TEST_MODE` (on unless exactly FALSE) redirects to `TEST_RECIPIENT`.',
      '',
      'The lead is locked (`Sending`) before Gmail is called and the lock is re-read; a failed send is logged, marked `Failed`, never retried automatically, and raises an alert via WF00.',
      '',
      '**Do not activate until the go-live checklist (docs/09) is complete.**',
    ].join('\n'), [-60, -480], 820, 300),
    scheduleTrigger(wf, 'Every 10 Minutes', { field: 'minutes', minutesInterval: 10 }, [0, 0]),
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER]], [220, 0]),
    readNode(wf, 'Read Settings', 'Settings', [440, 0]),
    readNode(wf, 'Read Niches', 'Niches', [660, 0]),
    readNode(wf, 'Read Leads', 'Leads', [880, 0]),
    readNode(wf, 'Read Suppression', 'Suppression', [1100, 0]),
    readNode(wf, 'Read Send_Log', 'Send_Log', [1320, 0]),
    codeNode(wf, 'Gate & Pick', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      'const result = gateAndPick({',
      "  settingsRows: rowsFrom('Read Settings'),",
      "  nichesRows: rowsFrom('Read Niches'),",
      "  leadsRows: rowsFrom('Read Leads'),",
      "  suppressionRows: rowsFrom('Read Suppression'),",
      "  sendLogRows: rowsFrom('Read Send_Log'),",
      '  now: new Date().toISOString(),',
      '});',
      'return [{ json: result }];',
    ]), [1540, 0]),
    splitCode(wf, 'Blocked Notes', '$input.first().json.notes', [1760, -220]),
    updateNode(wf, 'Update Leads (Notes)', 'Leads', WF04_NOTE_COLUMNS, 'lead_id', [1980, -220]),
    codeNode(wf, 'Send Item', embedModules(mods, [
      "const r = $('Gate & Pick').first().json;",
      "return r.action === 'send' ? [{ json: { ...r.send, ...lockUpdate(r.send) } }] : [];",
    ]), [1760, 60]),
    updateNode(wf, 'Lock Lead', 'Leads', WF04_LOCK_COLUMNS, 'lead_id', [1980, 60]),
    readNode(wf, 'Re-read Leads', 'Leads', [2200, 60]),
    codeNode(wf, 'Verify Lock', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      "const send = $('Send Item').first().json;",
      "const lock = verifyLock(rowsFrom('Re-read Leads'), send);",
      "if (!lock.ok) throw new Error(`Send aborted, nothing sent: ${lock.reason}. lead_id=${send.lead_id}`);",
      'return [{ json: send }];',
    ]), [2420, 60]),
    {
      parameters: {
        sendTo: '={{ $json.to }}',
        subject: '={{ $json.subject }}',
        emailType: 'text',
        message: '={{ $json.body }}',
        options: { appendAttribution: false, senderName: '={{ $json.sender_name }}' },
      },
      id: nodeId(wf, 'Send Email'),
      name: 'Send Email',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [2640, 60],
      onError: 'continueErrorOutput',
    },
    codeNode(wf, 'Record Success', embedModules(mods, [
      "const send = $('Verify Lock').first().json;",
      'return [{ json: recordSuccess(send, $input.first().json, new Date().toISOString()) }];',
    ]), [2860, -40]),
    codeNode(wf, 'Sent Lead Row', 'return [{ json: $input.first().json.leadUpdate }];', [3080, -120]),
    updateNode(wf, 'Update Leads (Sent)', 'Leads', WF04_RESULT_COLUMNS, 'lead_id', [3300, -120]),
    codeNode(wf, 'Sent Log Row', "return [{ json: $('Record Success').first().json.logRow }];", [3080, 40]),
    appendNode(wf, 'Append Send_Log (Sent)', 'Send_Log', [3300, 40]),
    codeNode(wf, 'Record Failure', embedModules(mods, [
      "const send = $('Verify Lock').first().json;",
      'return [{ json: recordFailure(send, $input.first().json.error, new Date().toISOString()) }];',
    ]), [2860, 260]),
    codeNode(wf, 'Failed Lead Row', 'return [{ json: $input.first().json.leadUpdate }];', [3080, 200]),
    updateNode(wf, 'Update Leads (Failed)', 'Leads', WF04_RESULT_COLUMNS, 'lead_id', [3300, 200]),
    codeNode(wf, 'Failed Log Row', "return [{ json: $('Record Failure').first().json.logRow }];", [3080, 360]),
    appendNode(wf, 'Append Send_Log (Failed)', 'Send_Log', [3300, 360]),
    {
      parameters: { errorMessage: "={{ $('Record Failure').first().json.alert }}" },
      id: nodeId(wf, 'Alert Failure'),
      name: 'Alert Failure',
      type: 'n8n-nodes-base.stopAndError',
      typeVersion: 1,
      position: [3520, 360],
    },
  ];
  const connections = edges([
    ...chainEdges('Every 10 Minutes', 'Config', 'Read Settings', 'Read Niches', 'Read Leads', 'Read Suppression', 'Read Send_Log', 'Gate & Pick'),
    ...chainEdges('Gate & Pick', 'Blocked Notes', 'Update Leads (Notes)'),
    ...chainEdges('Gate & Pick', 'Send Item', 'Lock Lead', 'Re-read Leads', 'Verify Lock', 'Send Email'),
    connect('Send Email', 'Record Success', 0),
    connect('Send Email', 'Record Failure', 1),
    ...chainEdges('Record Success', 'Sent Lead Row', 'Update Leads (Sent)'),
    ...chainEdges('Record Success', 'Sent Log Row', 'Append Send_Log (Sent)'),
    ...chainEdges('Record Failure', 'Failed Lead Row', 'Update Leads (Failed)'),
    ...chainEdges('Record Failure', 'Failed Log Row', 'Append Send_Log (Failed)', 'Alert Failure'),
  ]);
  return workflow('WF04 Approved Sender', nodes, connections);
}

// ---------- WF05 Replies & Bounces ----------

const WF05_GMAIL_QUERY = 'in:inbox newer_than:7d -from:me';

function buildWf05() {
  const wf = 'WF05';
  const mods = ['lib/common.js', 'wf05-replies-logic.js'];
  const { WF05_COLUMNS } = require('../src/wf05-replies-logic');
  const nodes = [
    stickyNote(wf, 'About WF05', [
      '## WF05 Replies & Bounces (scheduled, every 15 minutes)',
      `Reads the last 7 days of inbox mail (\`${WF05_GMAIL_QUERY}\`, read and unread), matches it to **real** sends by Gmail thread (bounces also by failed address), and:`,
      '- opt-outs (keyword rules, never AI) → **Suppression** + stage **Unsubscribed**',
      '- bounces → **Suppression** (reason bounce)',
      '- other replies → **Replied**, `reply_category = needs_review` for you to read',
      '',
      'Suppressions are written before lead updates. Re-runs are idempotent (`reply_received_at` watermark, suppression dedupe).',
    ].join('\n'), [-60, -440], 760, 280),
    scheduleTrigger(wf, 'Every 15 Minutes', { field: 'minutes', minutesInterval: 15 }, [0, 0]),
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER]], [220, 0]),
    readNode(wf, 'Read Leads', 'Leads', [440, 0]),
    readNode(wf, 'Read Send_Log', 'Send_Log', [660, 0]),
    readNode(wf, 'Read Suppression', 'Suppression', [880, 0]),
    {
      parameters: {
        operation: 'getAll',
        returnAll: false,
        limit: 100,
        simple: false,
        filters: { q: WF05_GMAIL_QUERY, readStatus: 'both' },
        options: {},
      },
      id: nodeId(wf, 'Get Recent Messages'),
      name: 'Get Recent Messages',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [1100, 0],
      executeOnce: true,
      alwaysOutputData: true,
    },
    codeNode(wf, 'Classify Messages', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      'const result = processMessages({',
      "  leadsRows: rowsFrom('Read Leads'),",
      "  sendLogRows: rowsFrom('Read Send_Log'),",
      "  suppressionRows: rowsFrom('Read Suppression'),",
      "  messages: rowsFrom('Get Recent Messages'),",
      '  now: new Date().toISOString(),',
      '});',
      'return [{ json: result }];',
    ]), [1320, 0]),
    splitCode(wf, 'New Suppressions', '$input.first().json.suppressions', [1540, -120]),
    appendNode(wf, 'Append Suppression', 'Suppression', [1760, -120]),
    splitCode(wf, 'Reply Updates', "$('Classify Messages').first().json.leadUpdates", [1540, 120]),
    updateNode(wf, 'Update Leads (Replies)', 'Leads', WF05_COLUMNS, 'lead_id', [1760, 120]),
  ];
  const connections = edges([
    ...chainEdges('Every 15 Minutes', 'Config', 'Read Leads', 'Read Send_Log', 'Read Suppression', 'Get Recent Messages', 'Classify Messages'),
    ...chainEdges('Classify Messages', 'New Suppressions', 'Append Suppression'),
    ...chainEdges('Classify Messages', 'Reply Updates', 'Update Leads (Replies)'),
  ]);
  return workflow('WF05 Replies & Bounces', nodes, connections);
}

// ---------- WF06 Daily Metrics ----------

function buildWf06() {
  const wf = 'WF06';
  const mods = ['lib/common.js', 'wf06-metrics-logic.js'];
  const nodes = [
    stickyNote(wf, 'About WF06', [
      '## WF06 Daily Metrics (scheduled, daily 21:05 in the n8n time zone)',
      'Writes one **Metrics** row per day: cumulative totals as of that day (the difference between two rows is that period\'s activity). Re-running on the same day replaces that day\'s row.',
      '',
      '**Setup:** `sheet_id` and `metrics_timezone` in **Config**.',
    ].join('\n'), [-60, -340], 700, 200),
    scheduleTrigger(wf, 'Daily 21:05', { field: 'days', daysInterval: 1, triggerAtHour: 21, triggerAtMinute: 5 }, [0, 0]),
    configNode(wf, [['sheet_id', SHEET_ID_PLACEHOLDER], ['metrics_timezone', 'Asia/Kolkata']], [220, 0]),
    readNode(wf, 'Read Leads', 'Leads', [440, 0]),
    readNode(wf, 'Read Send_Log', 'Send_Log', [660, 0]),
    readNode(wf, 'Read Suppression', 'Suppression', [880, 0]),
    codeNode(wf, 'Compute Metrics', embedModules(mods, [
      ...GLUE_ROWS_FROM,
      'return [{ json: computeMetrics({',
      "  leadsRows: rowsFrom('Read Leads'),",
      "  sendLogRows: rowsFrom('Read Send_Log'),",
      "  suppressionRows: rowsFrom('Read Suppression'),",
      '  now: new Date().toISOString(),',
      "  timeZone: $('Config').first().json.metrics_timezone,",
      '}) }];',
    ]), [1100, 0]),
    {
      parameters: {
        operation: 'appendOrUpdate',
        ...sheetRef('Metrics'),
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['date'], schema: [] },
        options: { cellFormat: 'RAW', handlingExtraData: 'error' },
      },
      id: nodeId(wf, 'Write Metrics'),
      name: 'Write Metrics',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [1320, 0],
    },
  ];
  const connections = edges(chainEdges('Daily 21:05', 'Config', 'Read Leads', 'Read Send_Log', 'Read Suppression', 'Compute Metrics', 'Write Metrics'));
  return workflow('WF06 Daily Metrics', nodes, connections);
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
  files['workflows/WF02-research-qualify.json'] = `${JSON.stringify(buildWf02(), null, 2)}\n`;
  files['workflows/WF03-draft-generation.json'] = `${JSON.stringify(buildWf03(), null, 2)}\n`;
  files['workflows/WF04-approved-sender.json'] = `${JSON.stringify(buildWf04(), null, 2)}\n`;
  files['workflows/WF05-replies-bounces.json'] = `${JSON.stringify(buildWf05(), null, 2)}\n`;
  files['workflows/WF06-daily-metrics.json'] = `${JSON.stringify(buildWf06(), null, 2)}\n`;
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

module.exports = { outputs, embedModules, FIXTURE_IMPORT_ROWS, FIXTURE_SUPPRESSION_ROWS, SHEET_ID_PLACEHOLDER, ALERT_EMAIL_PLACEHOLDER, DEFAULT_GEMINI_MODEL, WF05_GMAIL_QUERY };
