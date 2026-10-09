# Implementation checklist and status (updated 2026-10-09)

**Status legend:**
- **Implemented**: code and workflow exist.
- **Automated-test verified**: passes `npm test` and the n8n engine harness, with Google services stubbed.
- **Real-service verified**: run successfully against FlowHQ's real Google Sheet, Gmail, Companies House or Gemini.
- **Not verified**: none of the above.

**Nothing in this repository is real-service verified yet.** Neither the build environment nor I have access to FlowHQ's Google account, and outbound access to Companies House, Gemini and websites is blocked here. The system is **not production-ready** until the go-live checklist in `09-setup-and-go-live.md` §8 is complete.

## 1. Audit at the start of this round

| Item | Finding |
|---|---|
| Branch / remote | `claude/kind-johnson-ik3vzk` tracking `origin` (github.com/vatsal04-02/Lead-outreach-workflow); clean tree; 2 commits (Phase 1 docs, Phase 2). |
| Baseline tests | `npm test`: **52/52 passing**. Engine harness: 11/11 on n8n 2.42.6. No pre-existing failures. |
| Implemented before this round | Phase 2: Sheet templates, WF00, WF01, tests, engine harness. |
| Documented but missing | WF02, WF03, WF04, WF05, WF06 (architecture §6), the Phase 7 E2E procedure, a secret scan (the brief asked for one; none existed), CI. |
| External dependencies | Google Sheets API, Gmail API (OAuth currently failing on FlowHQ's side), Companies House API key, Gemini API key, a sending domain. |
| Pre-existing deviation found | The WF01 unit tests used `.co.uk` addresses that could belong to real businesses, which breaks the synthetic-only rule. They were switched to `.example`, with the assertions unchanged. The new secret scan now prevents this. |
| Defect found and fixed | A lead with **no stored evidence** could produce a passing, generic draft. The draft check now requires at least one evidence item (`tests/wf03-drafting.test.js`). |

## 2. Phases

| Phase | Completion criteria | Implemented | Automated-test verified | Real-service verified |
|---|---|---|---|---|
| 1 Strategy | Niche, ICP, offer, architecture documented; decisions D1–D7 made by FlowHQ | Docs only | n/a | **No.** Decisions are open. |
| 1b Smoke test | ≥12/20 with email + limited company, ≥8/20 with a citable signal, all verified | Template + 22 candidates + procedure | n/a | **No. 0/20 verified** (page fetching blocked here) |
| 2 Sheet + import | Tabs match schema; WF01 validates, dedupes, suppresses and is idempotent; WF00 logs and alerts | Yes | Yes (unit + engine on 2.41.6 and 2.42.6) | **No** (`07` T1–T7 pending) |
| 3 Research & qualify | WF02 qualifies only on verified quotes and Companies House; failures don't lose data or block the queue | Yes | Yes | **No** (needs CH + Gemini keys; `09` §5) |
| 4 Drafts | WF03 drafts pass the honesty and compliance checks; human edits are re-checked | Yes | Yes | **No** |
| 5 Approval + sending | Human approval; WF04 enforces every gate; test-mode redirect; no duplicates; failures logged and alerted | Yes | Yes | **No** (Gmail OAuth broken) |
| 6 Replies, suppression, reporting | WF05 opt-outs/bounces → Suppression first, idempotent; WF06 daily snapshot | Yes | Yes | **No** |
| 7 Controlled E2E | Full chain with synthetic and FlowHQ-owned recipients only | Yes: engine chain + `09` §6 procedure | Yes (stubbed chain WF01→WF06) | **No** (live procedure pending) |
| Follow-ups | Not before 2 weeks of reliable initial sending (architecture §12) | **Not implemented, by design** | — | — |

## 3. Per-phase validation tasks for FlowHQ

- [ ] Phase 2: `07-phase-2-setup.md` T1–T7.
- [ ] Phase 3: `09` §5 Phase 3 (one real, hand-researched lead).
- [ ] Phase 4: `09` §5 Phase 4.
- [ ] Phase 5: `09` §5 Phase 5 (test mode only).
- [ ] Phase 6: `09` §5 Phase 6.
- [ ] Phase 7: `09` §6 (FlowHQ-owned mailboxes, allowlist on).
- [ ] Go-live: `09` §8, signed.

## 4. Decisions only FlowHQ can make

| # | Decision | Current interpretation in the code (change on request) |
|---|---|---|
| D1 | Approve the Test 1 niche (UK independent estate and letting agencies) | Configured as `uk-estate-letting`. |
| D2 | Sending domain and mailbox | None assumed; `SENDER_EMAIL` is blank. |
| D3 | Legal name, postal address, privacy URL | `BUSINESS_LEGAL_NAME` row added (compliance rule 4 needed it); WF03 and WF04 refuse to work while these are blank. |
| D4 | 15- or 20-minute call | The email uses `Niches.cta` ("Free 15-minute enquiry workflow review"); edit that cell to change it. |
| D5 | Agencies without a published email stay out of Leads | Implemented that way (WF01 requires `contact_email` + `email_source_url`). |
| D6 | Deal-value column for `won_value` | Left blank; adding a column needs a schema migration. |
| D7 | Pilot price | Not set (see `06-offer-review.md` §4). |
| D8 | Gemini free tier: model and data terms | `gemini-2.5-flash` in each Config node; only public website text and our prompts are sent; no replies. |
| D9 | Test-mode behaviour | `send_status = TestSent` (a new value), stage stays `Approved`, never re-picked, never counted as contact; WF05 ignores test sends. |
| D10 | "Instant" wording | The template says "within minutes" (the triggers poll); "instant" is a banned phrase in FlowHQ's own wording. |
| D11 | `Disqualified` stage (from Phase 1) | Used by WF02. |

## 5. Interpretations made where the architecture was silent

1. **Daily cap:** counts today's live **and test** sends, from Send_Log **and** Leads, so a failed log write can't let the cap be exceeded.
2. **Additional safety gates beyond architecture §7:**
   - a failure breaker (2 failed sends per day pauses sending);
   - a stuck-`Sending` lead stops all sending;
   - the draft is re-checked at send time;
   - the optional `LIVE_RECIPIENT_ALLOWLIST`.
3. **Approval** needs both `approval_status = Approved` and `stage = Approved`, as architecture §4 and §7 specify. You set both.
4. **Metrics** are cumulative daily snapshots; architecture §8 updated.
5. **WF02 `Researched`** means "analysed, but Companies House needs a manual check". Fetch and AI failures leave the stage unchanged, with `last_error`.
6. **Domain-level suppression** is derived automatically from every suppressed address except shared mail providers. A bounce therefore suppresses the whole agency domain (the conservative choice).
