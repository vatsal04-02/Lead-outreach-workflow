# FlowHQ Lead Generation & Outreach Engine (internal)

FlowHQ's internal business-development system. It finds relevant businesses, explains why each one is a good prospect, prepares honest personalised outreach for human approval, and tracks the pipeline through to paying clients.

**Success metric:** qualified conversations and paying clients, **not** email volume.

## Status

**All planned workflows are implemented and pass automated tests, with Google services stubbed. None has been verified against FlowHQ's real Google Sheet, Gmail, Gemini, the OpenStreetMap Overpass API or real websites.** The system is **not production-ready**: complete `docs/09-setup-and-go-live.md` first. Sending stays off (`SENDING_ENABLED = FALSE`, `TEST_MODE = TRUE`) until you sign the go-live checklist.

| Phase | Scope | Implemented | Automated tests | Real services |
|---|---|---|---|---|
| 1 | Niche, ICP, offer, architecture | Docs | n/a | Decisions open |
| 1b | Niche smoke test (20 agencies) | Template + procedure | n/a | **0/20 verified** |
| 2 | Sheet, WF00, WF01 | ✅ | ✅ | ❌ |
| 3 | WF02 discovery, research and qualification | ✅ | ✅ | ❌ |
| 4 | WF03 drafts | ✅ | ✅ | ❌ |
| 5 | Human approval + WF04 sending | ✅ | ✅ | ❌ (Gmail OAuth broken) |
| 6 | WF05 replies/opt-outs/bounces, WF06 metrics | ✅ | ✅ | ❌ |
| 7 | Controlled end-to-end test | ✅ stubbed chain + live procedure | ✅ | ❌ |

Automated results:
- `npm test`: **161/161**.
- n8n engine harness: **25/25 on n8n 2.41.6 and 2.42.6** (imports every workflow into a throwaway n8n and chains discovery → research → drafts → sending → replies → metrics, with Google services, Overpass and websites stubbed; also a multi-country campaign, prompt injection, website failures and the refusal to run on an un-migrated Leads tab).

Details are in [`docs/00-implementation-checklist.md`](docs/00-implementation-checklist.md).

## Workflows

| File | Trigger | What it does |
|---|---|---|
| `workflows/WF00-error-handler.json` | Error | Errors tab + alert email (a failed alert is logged separately) |
| `workflows/WF01-import-dedupe.json` | Manual | Import → validated, deduplicated `New Lead` rows |
| `workflows/WF02-research-qualify.json` | Manual | Optional discovery (OpenStreetMap) + robots-aware website research + Gemini → Qualified / Needs Review / Disqualified, with evidence and opportunities. Never sends email. |
| `workflows/WF03-draft-generation.json` | Manual | Template draft + one checked AI sentence → `Draft Ready` |
| *(human)* | — | Approve in the Sheet |
| `workflows/WF04-approved-sender.json` | Every 10 min | At most one approved email per run, behind every safety gate |
| `workflows/WF05-replies-bounces.json` | Every 15 min | Opt-outs and bounces → Suppression; replies → Replied |
| `workflows/WF06-daily-metrics.json` | Daily | Metrics snapshot |
| `workflows/WF00-selftest-trigger.json` | Every minute | Temporary WF00 test (delete after use) |

The full reference (inputs, outputs, failure handling, idempotency, tests) is in [`docs/08-workflows.md`](docs/08-workflows.md).

## Documents

- [`00-implementation-checklist.md`](docs/00-implementation-checklist.md): status, audit, decisions D1–D16, interpretations
- [`01-strategy-icp-offer.md`](docs/01-strategy-icp-offer.md), [`02-mvp-architecture.md`](docs/02-mvp-architecture.md), [`03-compliance-guardrails.md`](docs/03-compliance-guardrails.md): strategy, architecture, compliance
- [`05-niche-smoke-test.md`](docs/05-niche-smoke-test.md), [`06-offer-review.md`](docs/06-offer-review.md): research procedure and offer review
- [`07-phase-2-setup.md`](docs/07-phase-2-setup.md): Phase 2 tests T1–T7
- [`08-workflows.md`](docs/08-workflows.md): workflow inventory and dependency map
- [`09-setup-and-go-live.md`](docs/09-setup-and-go-live.md): **live setup for n8n 2.41.6, validation, Phase 7 E2E, go-live checklist, rollback, limitations**
- [`10-gmail-oauth-troubleshooting.md`](docs/10-gmail-oauth-troubleshooting.md): Gmail OAuth fixes
- [`11-discovery-provider.md`](docs/11-discovery-provider.md): the discovery provider (OpenStreetMap / Overpass): data, limits, terms, configuration, testing, replacement

## Repository layout

```
docs/        Strategy, architecture, compliance, setup, go-live
research/    Smoke-test template and UNVERIFIED candidate list
src/         Schema + workflow logic (single source of truth); src/lib = shared modules
sheets/      Generated tab templates (CSV) and synthetic test fixtures
workflows/   Generated n8n workflows (no credentials, no sheet IDs)
scripts/     build.js, n8n-engine-test.js, secret-scan.js
tests/       Unit, schema, workflow-structure, E2E-logic and secret-scan tests
```

Edit `src/`, then run `npm run build` and `npm test`. Never hand-edit `sheets/` or `workflows/`: `npm test` fails if they drift from `src/`.

## Stack (₹0 apart from a possible sending domain)

n8n Community Edition (local, Docker on WSL2), Google Sheets, Gmail OAuth2, the Gemini API free tier, and OpenStreetMap data through the public Overpass API (no key). No company registries, paid tools, scraping services or lead databases.

## Important limitation

**Workflows only run while the laptop is on, awake, and the n8n container is running.** Missed schedules aren't caught up, and opt-outs are only processed while WF05 runs. Client production automations must never run on this laptop.
