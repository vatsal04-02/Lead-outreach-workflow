'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatError, MAX_MESSAGE_LENGTH } = require('../src/wf00-format-error');
const { TABS } = require('../src/schema');

const NOW = '2026-10-09T10:00:00.000Z';

test('execution error becomes an Errors row with exactly the Errors columns', () => {
  const { row, emailSubject, emailBody } = formatError(
    {
      execution: {
        id: '231',
        url: 'http://localhost:5678/workflow/1/executions/231',
        mode: 'trigger',
        lastNodeExecuted: 'Read Leads',
        error: { message: 'The caller does not have permission', description: 'Check the sheet is shared' },
      },
      workflow: { id: '1', name: 'WF01 Import & Dedupe' },
    },
    NOW,
  );
  assert.deepEqual(Object.keys(row), TABS.Errors);
  assert.equal(row.timestamp, NOW);
  assert.equal(row.workflow, 'WF01 Import & Dedupe');
  assert.equal(row.node, 'Read Leads');
  assert.equal(row.message, '[execution 231] The caller does not have permission: Check the sheet is shared');
  assert.match(emailSubject, /WF01 Import & Dedupe failed at "Read Leads"/);
  assert.match(emailBody, /executions\/231/);
});

test('trigger-level errors are handled', () => {
  const { row } = formatError({ trigger: { mode: 'trigger', error: { message: 'Credentials expired' } }, workflow: { name: 'WF04' } }, NOW);
  assert.equal(row.node, '(trigger)');
  assert.equal(row.message, 'Credentials expired');
});

test('missing data never throws', () => {
  const { row } = formatError(undefined, NOW);
  assert.equal(row.workflow, '(unknown workflow)');
  assert.equal(row.message, 'No error message provided');
});

test('lead_id is extracted when a message names one', () => {
  const { row } = formatError({ execution: { error: { message: 'Draft check failed lead_id=example-lettings.co.uk; too long' } }, workflow: { name: 'WF03' } }, NOW);
  assert.equal(row.lead_id, 'example-lettings.co.uk');
});

test('long messages are truncated and formula-like text is neutralised', () => {
  const { row } = formatError({ execution: { error: { message: `=HYPERLINK("x")${'a'.repeat(5000)}` } }, workflow: { name: '+evil' } }, NOW);
  assert.ok(row.message.length <= MAX_MESSAGE_LENGTH + 1);
  assert.ok(row.message.startsWith("'="));
  assert.equal(row.workflow, "'+evil");
});
