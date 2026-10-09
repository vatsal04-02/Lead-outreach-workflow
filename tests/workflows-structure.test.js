'use strict';

// Structural and safety checks on every generated workflow (WF02–WF06 in detail).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TABS } = require('../src/schema');
const { outputs } = require('../scripts/build');

const ROOT = path.resolve(__dirname, '..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'));
const ALL = fs.readdirSync(path.join(ROOT, 'workflows')).filter((f) => f.endsWith('.json'));
const node = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, `missing node ${name} in ${wf.name}`);
  return n;
};
const targets = (wf, from, output = 0) => ((wf.connections[from] || { main: [] }).main[output] || []).map((c) => c.node);

// Node types and versions verified against n8n 2.41.6 and 2.42.6 sources.
const KNOWN_TYPES = {
  'n8n-nodes-base.manualTrigger': [1],
  'n8n-nodes-base.scheduleTrigger': [1.2],
  'n8n-nodes-base.errorTrigger': [1],
  'n8n-nodes-base.set': [3.4],
  'n8n-nodes-base.code': [2],
  'n8n-nodes-base.googleSheets': [4.5],
  'n8n-nodes-base.httpRequest': [4.2],
  'n8n-nodes-base.gmail': [2.1],
  'n8n-nodes-base.stopAndError': [1],
  'n8n-nodes-base.stickyNote': [1],
};

test('only known node types and versions are used', () => {
  for (const f of ALL) {
    for (const n of load(f).nodes) {
      assert.ok(KNOWN_TYPES[n.type], `${f}: unknown type ${n.type}`);
      assert.ok(KNOWN_TYPES[n.type].includes(n.typeVersion), `${f}: ${n.type} v${n.typeVersion}`);
    }
  }
});

test('every node is reachable from the trigger and every workflow has exactly one trigger', () => {
  for (const f of ALL) {
    const wf = load(f);
    const triggers = wf.nodes.filter((n) => /Trigger$/.test(n.type));
    assert.equal(triggers.length, 1, f);
    const seen = new Set([triggers[0].name]);
    const queue = [triggers[0].name];
    while (queue.length) {
      const from = queue.shift();
      for (const branch of (wf.connections[from] || { main: [] }).main) for (const c of branch) if (!seen.has(c.node)) { seen.add(c.node); queue.push(c.node); }
    }
    for (const n of wf.nodes) if (n.type !== 'n8n-nodes-base.stickyNote') assert.ok(seen.has(n.name), `${f}: ${n.name} is unreachable`);
  }
});

test('expressions only reference nodes that exist', () => {
  for (const f of ALL) {
    const wf = load(f);
    const names = new Set(wf.nodes.map((n) => n.name));
    const text = JSON.stringify(wf.nodes.map((n) => n.parameters));
    for (const m of text.matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) assert.ok(names.has(m[1]), `${f}: $('${m[1]}') has no node`);
  }
});

test('Sheets updates map only real columns and match on lead_id (row_number only for Import)', () => {
  for (const f of ALL) {
    for (const n of load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.googleSheets' && x.parameters.operation === 'update')) {
      const tab = n.parameters.sheetName.value;
      const cols = Object.keys(n.parameters.columns.value);
      for (const c of cols) assert.ok(c === 'row_number' || TABS[tab].includes(c), `${f}/${n.name}: ${c}`);
      assert.deepEqual(n.parameters.columns.matchingColumns, [tab === 'Import' ? 'row_number' : 'lead_id'], `${f}/${n.name}`);
      assert.equal(n.parameters.options.cellFormat, 'RAW');
      assert.deepEqual(n.parameters.columns.schema.map((s) => s.id), cols);
    }
  }
});

test('Sheets appends are strict (RAW, error on unknown fields)', () => {
  for (const f of ALL) {
    for (const n of load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.googleSheets' && ['append', 'appendOrUpdate'].includes(x.parameters.operation))) {
      assert.deepEqual(n.parameters.options, { cellFormat: 'RAW', handlingExtraData: 'error' }, `${f}/${n.name}`);
    }
  }
});

test('every Sheets read runs once and survives empty tabs', () => {
  for (const f of ALL) {
    for (const n of load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.googleSheets' && !x.parameters.operation)) {
      assert.equal(n.executeOnce, true, `${f}/${n.name}`);
      assert.equal(n.alwaysOutputData, true, `${f}/${n.name}`);
    }
  }
});

test('HTTP nodes use credentials by type only, continue on error, and throttle', () => {
  for (const f of ALL) {
    for (const n of load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
      assert.equal(n.onError, 'continueRegularOutput', `${f}/${n.name}`);
      assert.equal(n.credentials, undefined);
      assert.equal(n.parameters.options.batching.batch.batchSize, 1);
      assert.ok(n.parameters.options.batching.batch.batchInterval >= 600);
      assert.ok(!/key=|api[_-]?key|Bearer /i.test(JSON.stringify(n.parameters)), `${f}/${n.name} must not embed keys`);
    }
  }
  const wf2 = load('WF02-research-qualify.json');
  assert.equal(node(wf2, 'Gemini').parameters.genericAuthType, 'httpHeaderAuth');
  // Discovery, robots.txt and websites need no credential at all.
  for (const name of ['Overpass', 'Fetch Robots', 'Fetch Homepage', 'Fetch Pages']) assert.equal(node(wf2, name).parameters.authentication, undefined, name);
  // The only credentialed HTTP node in the whole system is Gemini (no registry APIs).
  const authed = ALL.flatMap((f) => load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && x.parameters.authentication).map((x) => `${f}/${x.name}`));
  assert.deepEqual(authed.sort(), ['WF02-research-qualify.json/Gemini', 'WF03-draft-generation.json/Gemini']);
});

test('WF02: discovery appends leads before its log, and never touches Gmail', () => {
  const wf = load('WF02-research-qualify.json');
  assert.ok(node(wf, 'New Discovered Leads').position[1] < node(wf, 'Discovery Log Rows').position[1]);
  assert.equal(node(wf, 'Append Discovered Leads').parameters.sheetName.value, 'Leads');
  assert.equal(node(wf, 'Append Discovery_Log').parameters.sheetName.value, 'Discovery_Log');
  assert.ok(!wf.nodes.some((n) => n.type === 'n8n-nodes-base.gmail'), 'WF02 must not send email');
  assert.deepEqual(targets(wf, 'Research Items'), ['Fetch Robots']);
  assert.deepEqual(targets(wf, 'Fetch Robots'), ['Robots Gate']);
  assert.deepEqual(targets(wf, 'Robots Gate'), ['Fetch Homepage']);
  assert.equal(node(wf, 'Overpass').parameters.options.batching.batch.batchInterval, 5000);
});

test('only WF04 sends prospecting email; WF00 only alerts FlowHQ', () => {
  for (const f of ALL) {
    const senders = load(f).nodes.filter((n) => n.type === 'n8n-nodes-base.gmail' && n.parameters.operation !== 'getAll');
    if (f.startsWith('WF04')) assert.equal(senders.length, 1);
    else if (f.startsWith('WF00-error')) assert.deepEqual(senders.map((n) => n.parameters.sendTo), ['={{ $json.alert_email }}']);
    else assert.equal(senders.length, 0, f);
  }
});

test('WF04: Gmail is only reachable through the lock and lock check', () => {
  const wf = load('WF04-approved-sender.json');
  assert.equal(node(wf, 'Every 10 Minutes').type, 'n8n-nodes-base.scheduleTrigger');
  assert.deepEqual(targets(wf, 'Send Item'), ['Lock Lead']);
  assert.deepEqual(targets(wf, 'Lock Lead'), ['Re-read Leads']);
  assert.deepEqual(targets(wf, 'Re-read Leads'), ['Verify Lock']);
  assert.deepEqual(targets(wf, 'Verify Lock'), ['Send Email']);
  const incoming = Object.entries(wf.connections).filter(([, v]) => v.main.some((b) => b.some((c) => c.node === 'Send Email'))).map(([k]) => k);
  assert.deepEqual(incoming, ['Verify Lock']);
  const gmail = node(wf, 'Send Email');
  assert.equal(gmail.onError, 'continueErrorOutput');
  assert.deepEqual(targets(wf, 'Send Email', 0), ['Record Success']);
  assert.deepEqual(targets(wf, 'Send Email', 1), ['Record Failure']);
  assert.equal(gmail.parameters.sendTo, '={{ $json.to }}');
  assert.equal(gmail.parameters.options.appendAttribution, false);
  assert.deepEqual(targets(wf, 'Append Send_Log (Failed)'), ['Alert Failure']);
  assert.equal(node(wf, 'Alert Failure').type, 'n8n-nodes-base.stopAndError');
  // Leads are updated before the Send_Log append (v1 order runs the upper branch first).
  assert.ok(node(wf, 'Sent Lead Row').position[1] < node(wf, 'Sent Log Row').position[1]);
});

test('WF05 reads read and unread mail and writes suppressions before lead updates', () => {
  const wf = load('WF05-replies-bounces.json');
  const g = node(wf, 'Get Recent Messages');
  assert.equal(g.parameters.operation, 'getAll');
  assert.equal(g.parameters.filters.readStatus, 'both');
  assert.equal(g.parameters.simple, false);
  assert.equal(g.executeOnce, true);
  assert.equal(g.alwaysOutputData, true);
  assert.ok(node(wf, 'New Suppressions').position[1] < node(wf, 'Reply Updates').position[1]);
});

test('WF06 replaces the day\'s Metrics row instead of appending duplicates', () => {
  const n = node(load('WF06-daily-metrics.json'), 'Write Metrics');
  assert.equal(n.parameters.operation, 'appendOrUpdate');
  assert.deepEqual(n.parameters.columns.matchingColumns, ['date']);
});

test('only WF04, WF05, WF06 and the self-test are scheduled; all ship inactive', () => {
  for (const f of ALL) {
    const wf = load(f);
    assert.equal(wf.active, false, f);
    const scheduled = wf.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    assert.equal(scheduled, /^WF0(4|5|6)|selftest/.test(f), f);
  }
});

test('build is reproducible: a second build produces identical output', () => {
  const a = outputs();
  const b = outputs();
  assert.deepEqual(a, b);
  for (const [rel, content] of Object.entries(a)) assert.equal(fs.readFileSync(path.join(ROOT, rel), 'utf8'), content, rel);
});

test('embedded Code-node source never contains require() or module.exports', () => {
  for (const f of ALL) {
    for (const n of load(f).nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.ok(!/\brequire\(|module\.exports/.test(n.parameters.jsCode), `${f}/${n.name}`);
    }
  }
});
