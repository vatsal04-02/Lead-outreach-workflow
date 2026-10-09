'use strict';

// WF00 Error Handler: turns n8n Error Trigger output into an `Errors` row and an
// alert email. Embedded verbatim into the "Format Error" Code node by
// `npm run build` (everything after the EXPORT marker is stripped).

const MAX_MESSAGE_LENGTH = 1000;

function errText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// Spreadsheets treat a leading = + - @ as a formula; prefix with ' so the text
// is stored literally even if the sheet is later switched to USER_ENTERED.
function sheetSafe(value) {
  const s = errText(value);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

// Later workflows can include "lead_id=<id>" in an error message (for example
// from a Stop and Error node) so the Errors row links back to the lead.
function extractLeadId(message) {
  const match = /lead_id\s*[=:]\s*([^\s;,]+)/i.exec(message);
  return match ? match[1] : '';
}

// Accepts both shapes the Error Trigger emits: execution errors
// ({ execution, workflow }) and trigger/activation errors ({ trigger, workflow }).
function formatError(data, now) {
  const d = data || {};
  const execution = d.execution || {};
  const trigger = d.trigger || {};
  const error = execution.error || trigger.error || {};
  const workflowName = errText(d.workflow && d.workflow.name) || '(unknown workflow)';
  const node = errText(execution.lastNodeExecuted) || errText(error.node && error.node.name) || (d.trigger ? '(trigger)' : '');
  const rawMessage = errText(error.message) || errText(error.description) || 'No error message provided';
  const description = errText(error.description);
  const fullMessage = description && description !== rawMessage ? `${rawMessage}: ${description}` : rawMessage;
  const executionRef = execution.id ? `[execution ${execution.id}] ` : '';
  const message = (executionRef + fullMessage).slice(0, MAX_MESSAGE_LENGTH);
  const timestamp = errText(now) || new Date().toISOString();

  const row = {
    timestamp,
    workflow: sheetSafe(workflowName),
    node: sheetSafe(node),
    lead_id: sheetSafe(extractLeadId(fullMessage)),
    message: sheetSafe(message),
  };

  const emailSubject = `[FlowHQ n8n] ${workflowName} failed${node ? ` at "${node}"` : ''}`;
  const emailBody = [
    `Workflow: ${workflowName}`,
    `Node: ${node || '(unknown)'}`,
    `Time (UTC): ${timestamp}`,
    `Mode: ${errText(execution.mode || trigger.mode) || '(unknown)'}`,
    `Execution: ${errText(execution.url) || errText(execution.id) || '(none)'}`,
    '',
    `Error: ${fullMessage.slice(0, 4000)}`,
    '',
    'This alert was also written to the Errors tab (unless the Sheets write itself failed).',
  ].join('\n');

  return { row, emailSubject, emailBody };
}

// A failed alert email is itself recorded, so an alert is never assumed sent.
function formatAlertFailure(original, alertError, now) {
  const o = original || {};
  const e = alertError || {};
  const reason = typeof e === 'string' ? e : errText(e.message) || errText(e.description) || JSON.stringify(e);
  return {
    timestamp: errText(now) || new Date().toISOString(),
    workflow: 'WF00 Error Handler',
    node: 'Email Alert',
    lead_id: sheetSafe(o.lead_id),
    message: sheetSafe(`Alert email NOT sent (${reason.slice(0, 300)}). Original failure: ${errText(o.workflow)} at "${errText(o.node)}".`).slice(0, MAX_MESSAGE_LENGTH),
  };
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { formatError, formatAlertFailure, extractLeadId, sheetSafe, MAX_MESSAGE_LENGTH };
