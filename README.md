# FlowHQ Lead Generation & Outreach Engine (internal)

FlowHQ's internal business-development system. It finds relevant businesses, explains why each one is a good prospect, prepares honest personalised outreach for human approval, and tracks the pipeline through to paying clients.

**Success metric:** qualified conversations and paying clients, **not** email volume.

## Current status

| Phase | Scope | Status |
|---|---|---|
| 1 | Target niche, ICP, offer, MVP architecture | Proposed. **FlowHQ sign-off still pending** (`docs/01` §9). |
| 1b | Niche smoke test (20 verified agencies) | **Not run.** Template and 22 unverified candidate names ready (`docs/05`). |
| 2 | Google Sheets database + manual lead import (WF00, WF01) | **Built and tested offline. Not yet run against FlowHQ's Google Sheet** (`docs/07` §7). |
| 3 | Research & qualification (WF02) | Not started |
| 4 | Personalised draft generation (WF03) | Not started |
| 5 | Manual approval + Gmail sending (WF04) | Not started |
| 6 | Reply/bounce tracking, suppression, reporting (WF05, WF06) | Not started |
| 7 | End-to-end test with controlled records and recipients | Not started |

"Tested offline" means:
- 52 unit and schema tests pass (`npm test`).
- The workflows import into n8n 2.42.6 and run correctly in its engine with Google Sheets and Gmail stubbed (`scripts/n8n-engine-test.js`).

A phase is marked done only after its validation steps pass on FlowHQ's own n8n and Google account.

## Documents

- [`docs/01-strategy-icp-offer.md`](docs/01-strategy-icp-offer.md): assumptions, niche, ICP, offer, decisions needed
- [`docs/02-mvp-architecture.md`](docs/02-mvp-architecture.md): data flow, Sheet schema, stages, scoring, workflows, safety
- [`docs/03-compliance-guardrails.md`](docs/03-compliance-guardrails.md): country rules and enforced rules
- [`docs/04-repo-review.md`](docs/04-repo-review.md): what's implemented vs documented, and inconsistencies found
- [`docs/05-niche-smoke-test.md`](docs/05-niche-smoke-test.md): smoke-test status and manual research process
- [`docs/06-offer-review.md`](docs/06-offer-review.md): pilot feasibility, risks, claims needing evidence, pricing validation
- [`docs/07-phase-2-setup.md`](docs/07-phase-2-setup.md): **step-by-step setup and validation tests for Phase 2**

## Repository layout

```
docs/        Strategy, architecture, compliance, reviews, setup guides
research/    Smoke-test template and unverified candidate list
src/         Sheet schema and workflow logic (single source of truth)
sheets/      Generated tab templates (CSV) and Phase 2 test fixtures
workflows/   Generated n8n workflow JSON (no credentials, no sheet IDs)
scripts/     build.js (generates sheets/ and workflows/), n8n-engine-test.js
tests/       Unit, schema and workflow-structure tests (node --test)
```

Edit `src/`, then run `npm run build` and `npm test`. Never hand-edit `sheets/` or `workflows/`; `npm test` fails if they drift from `src/`.

## Stack (₹0)

- n8n Community Edition (local, Docker on Windows/WSL2)
- Google Sheets (source of truth)
- Gmail via OAuth2 (alerts now; sending and reply tracking later)
- Companies House API (free; UK company verification, Phase 3)
- A free-tier LLM (Phase 3+)

## Important limitation

**Workflows only run while the laptop is on, awake, and the n8n container is running.** Missed schedules are not caught up. This is acceptable for internal outreach. It's **not** acceptable for client production automations, which must run on client-owned hosting.
