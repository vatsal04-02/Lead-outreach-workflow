'use strict';

// Google Gemini REST helpers (free tier via Google AI Studio API key).
// The HTTP Request node posts `ai_body` to `request_url`; the API key is sent by
// an n8n "Header Auth" credential (header `x-goog-api-key`), never stored here.

// ---- IMPORTS (stripped when embedded in n8n) ----
const { text } = require('./common');
// ---- END IMPORTS ----

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiUrl(model) {
  const m = text(model);
  if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(m)) throw new Error(`Invalid Gemini model name "${m}" in the Config node.`);
  return `${GEMINI_ENDPOINT}/${m}:generateContent`;
}

function geminiBody(prompt, { temperature = 0.2, maxOutputTokens = 2048 } = {}) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
  };
}

// Returns { ok: true, value } or { ok: false, error } and never throws.
function parseGeminiJson(response) {
  const r = response || {};
  if (r.error) {
    const msg = typeof r.error === 'string' ? r.error : text(r.error.message) || JSON.stringify(r.error);
    return { ok: false, error: `AI request failed: ${msg.slice(0, 300)}` };
  }
  const candidate = Array.isArray(r.candidates) ? r.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const raw = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
  if (!raw) {
    const reason = candidate ? text(candidate.finishReason) : text(r.promptFeedback && r.promptFeedback.blockReason);
    return { ok: false, error: `AI returned no content${reason ? ` (${reason})` : ''}` };
  }
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(unfenced);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'AI JSON is not an object' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `AI returned invalid JSON: ${e.message.slice(0, 120)}` };
  }
}

// ---- EXPORT (stripped when embedded in n8n) ----
module.exports = { GEMINI_ENDPOINT, geminiUrl, geminiBody, parseGeminiJson };
