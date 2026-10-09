# FlowHQ Lead Generation & Outreach Engine (internal)

FlowHQ's internal business-development system. It finds relevant businesses, explains why each one is a good prospect, prepares honest personalised outreach for human approval, and tracks the pipeline through to paying clients.

**Success metric:** qualified conversations and paying clients, **not** email volume.

## Current status

| Phase | Scope | Status |
|---|---|---|
| 1 | Target niche, ICP, offer, MVP architecture | **Proposed, awaiting FlowHQ sign-off** |
| 2 | Google Sheets database + manual lead import (WF00, WF01) | Not started |
| 3 | Research & qualification (WF02) | Not started |
| 4 | Personalised draft generation (WF03) | Not started |
| 5 | Manual approval + Gmail sending (WF04) | Not started |
| 6 | Reply/bounce tracking, suppression, reporting (WF05, WF06) | Not started |
| 7 | End-to-end test with controlled records and recipients | Not started |

Nothing in this repository has been tested against real prospects yet. A phase is marked done only after its validation steps pass.

## Documents

- [`docs/01-strategy-icp-offer.md`](docs/01-strategy-icp-offer.md): assumptions, niche choice, ICP, positioning, offer, smoke test, and decisions needed
- [`docs/02-mvp-architecture.md`](docs/02-mvp-architecture.md): data flow, Sheet schema, stages, scoring, workflows, safety controls, and laptop limits
- [`docs/03-compliance-guardrails.md`](docs/03-compliance-guardrails.md): country rules summary and the rules the system enforces

## Pipeline

Discover → Research → Qualify → Personalise → **Approve (human)** → Send → Track Replies → Manage Opportunities

## Stack (₹0)

- n8n Community Edition (local, Docker on Windows/WSL2)
- Google Sheets (source of truth)
- Gmail via OAuth2 (sending and reply tracking)
- Companies House API (free; UK company verification)
- A free-tier LLM (Gemini free tier by default; local Ollama as an alternative)

## Important limitation

**Workflows only run while the laptop is on, awake, and the n8n container is running.** Missed schedules are not caught up. This is acceptable for internal outreach. It's **not** acceptable for client production automations, which must run on client-owned hosting.

## Repository layout (planned)

```
docs/        Strategy, architecture, compliance
sheets/      Header templates for each Google Sheet tab (Phase 2)
workflows/   Exported n8n workflow JSON (no secrets)
prompts/     AI prompts for research and drafting (Phases 3–4)
```
