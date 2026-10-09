#!/usr/bin/env node
'use strict';

// Fails if any file that is (or is about to be) committed contains something that
// looks like a credential, a real Google Sheet ID, a .env file, or a real email
// address. Run: npm run scan   (also part of npm test)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Google OAuth client secret', /GOCSPX-[0-9A-Za-z_-]{20,}/],
  ['Google OAuth refresh token', /\b1\/\/0[0-9A-Za-z_-]{20,}/],
  ['Google access token', /\bya29\.[0-9A-Za-z_-]{20,}/],
  ['OAuth client ID', /\b\d{8,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{30,}/],
  ['Anthropic/OpenAI style key', /\bsk-(?:ant-)?[0-9A-Za-z_-]{20,}/],
  ['n8n encryption key assignment', /N8N_ENCRYPTION_KEY\s*=\s*\S{8,}/],
  ['real Google Sheet URL', /docs\.google\.com\/spreadsheets\/d\/[0-9A-Za-z_-]{25,}/],
  ['hard-coded secret assignment', /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];

// Email addresses allowed in the repository: reserved example domains,
// placeholders, and generic role addresses used in prose.
const ALLOWED_EMAIL = /(@[a-z0-9.-]*\.example$)|(@example\.(com|org|net)$)|(@anthropic\.com$)|(^noreply@)|(@googlemail\.com$)|(@gmail\.com$)/i;
const ALLOWED_GMAIL_LOCAL = /^(someone|janesmith|smithlettings|mailer-daemon)$/i;

function files() {
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return tracked.split('\0').filter(Boolean).filter((f) => !f.startsWith('node_modules/') && fs.existsSync(path.join(ROOT, f)));
}

function scan() {
  const problems = [];
  for (const f of files()) {
    const base = path.basename(f);
    if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') problems.push(`${f}: .env files must not be committed`);
    if (/credentials.*\.json$/i.test(base)) problems.push(`${f}: looks like a credentials export`);
    const abs = path.join(ROOT, f);
    if (fs.statSync(abs).size > 2_000_000) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const [label, re] of PATTERNS) {
      if (f === 'scripts/secret-scan.js') continue;
      const m = re.exec(text);
      if (m) problems.push(`${f}: ${label} (${m[0].slice(0, 12)}…)`);
    }
    for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      const email = m[0].replace(/\.$/, '');
      if (!ALLOWED_EMAIL.test(email)) problems.push(`${f}: email address ${email} (use a .example address in committed files)`);
      else if (/@g(oogle)?mail\.com$/i.test(email) && !ALLOWED_GMAIL_LOCAL.test(email.split('@')[0])) problems.push(`${f}: personal-looking Gmail address ${email}`);
    }
  }
  return [...new Set(problems)];
}

if (require.main === module) {
  const problems = scan();
  if (problems.length) {
    console.error(`Secret scan failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Secret scan passed (${files().length} files).`);
}

module.exports = { scan, PATTERNS };
