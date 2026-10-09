'use strict';

// Minimal robots.txt support for WF02 website research (RFC 9309 subset):
// the group for our user-agent token, or `*`; Allow/Disallow with `*` and `$`;
// the longest matching rule wins, Allow wins ties. A missing or unreadable
// robots.txt allows crawling, as the standard specifies for "unavailable".

// ---- IMPORTS (stripped when embedded in n8n) ----
const { text } = require('./common');
// ---- END IMPORTS ----

const ROBOTS_AGENT = 'flowhq-research';

function parseRobots(body, agent = ROBOTS_AGENT) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') current.rules.push({ allow: field === 'allow', path: value });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  // An empty Allow/Disallow value places no restriction.
  return chosen.flatMap((g) => g.rules).filter((r) => r.path !== '');
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
}

function isAllowed(rules, urlOrPath) {
  const path = (/^https?:\/\/[^/?#]+(\/[^#]*)?/i.exec(text(urlOrPath)) || [])[1] || (text(urlOrPath).startsWith('/') ? text(urlOrPath) : '/');
  let best = null;
  for (const r of rules || []) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

function robotsUrl(siteUrl) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(text(siteUrl));
  return m ? `${m[1]}/robots.txt` : '';
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { ROBOTS_AGENT, parseRobots, isAllowed, robotsUrl };
