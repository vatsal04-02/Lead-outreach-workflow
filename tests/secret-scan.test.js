'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scan, PATTERNS } = require('../scripts/secret-scan');

test('the repository contains no secrets, real sheet IDs or real email addresses', () => {
  assert.deepEqual(scan(), []);
});

test('the scanner recognises common credential formats', () => {
  // Built at runtime so this file never contains a literal secret.
  const samples = [
    'AIza' + 'A'.repeat(35),
    'GOCSPX-' + 'b'.repeat(28),
    'ya29.' + 'c'.repeat(30),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'docs.google.com/spreadsheets/d/' + '1'.repeat(44),
    'api_key = "' + 'z'.repeat(20) + '"',
  ];
  for (const s of samples) assert.ok(PATTERNS.some(([, re]) => re.test(s)), s.slice(0, 10));
});
