# Implementation checklist and status (updated 2026-10-09)

**Status legend:**
- **Implemented**: code and workflow exist.
- **Automated-test verified**: passes `npm test` and the n8n engine harness, with Google services stubbed.
- **Real-service verified**: run successfully against FlowHQ's real Google Sheet, Gmail, Gemini, the Overpass API or real websites.
- **Not verified**: none of the above.

**Nothing in this repository is real-service verified yet.** Neither the build environment nor I have access to FlowHQ's Google account, and outbound access to Gemini, the Overpass API and websites is blocked here. The system is **not production-ready** until the go-live checklist in `09-setup-and-go-live.md` §8 is complete.

## 1. Audit at the start of this round

| Item | Finding |
|---|---|
| Branch / remote | `claude/kind-johnson-ik3vzk` tracking `origin` (github.com/vatsal04-02/Lead-outreach-workflow); clean tree; 2 commits (Phase 1 docs, Phase 2). |
| Baseline tests | `npm test`: **52/52 passing**. Engine harness: 11/11 on n8n 2.42.6. No pre-existing failures. |
| Implemented before this round | Phase 2: Sheet templates, WF00, WF01, tests, engine harness. |
| Documented but missing | WF02, WF03, WF04, WF05, WF06 (architecture §6), the Phase 7 E2E procedure, a secret scan (the brief asked for one; none existed), CI. |
| External dependencies | Google Sheets API, Gmail API (OAuth currently failing on FlowHQ's side), Gemini API key, a sending domain. Optional: the public OpenStreetMap Overpass API (no key) for discovery. No company registry. |
| Pre-existing deviation found | The WF01 unit tests used `.co.uk` addresses that could belong to real businesses, which breaks the synthetic-only rule. They were switched to `.example`, with the assertions unchanged. The new secret scan now prevents this. |
| Defect found and fixed | A lead with **no stored evidence** could produce a passing, generic draft. The draft check now requires at least one evidence item (`tests/wf03-drafting.test.js`). |

## 2. Phases

| Phase | Completion criteria | Implemented | Automated-test verified | Real-service verified |
|---|---|---|---|---|
| 1 Strategy | Niche, ICP, offer, architecture documented; decisions D1–D7 made by FlowHQ | Docs only | n/a | **No.** Decisions are open. |
| 1b Smoke test | ≥12/20 with email + limited company, ≥8/20 with a citable signal, all verified | Template + 22 candidates + procedure | n/a | **No. 0/20 verified** (page fetching blocked here) |
| 2 Sheet + import | Tabs match schema; WF01 validates, dedupes, suppresses and is idempotent; WF00 logs and alerts | Yes | Yes (unit + engine on 2.41.6 and 2.42.6) | **No** (`07` T1–T7 pending) |
| 3 Discover, research & qualify | WF02 discovers businesses (OpenStreetMap, optional), honours robots.txt, qualifies only on verified quotes and the campaign's required evidence, sends weak or uncertain cases to `Needs Review`; failures don't lose data or block the queue; no registry | Yes | Yes (stubbed Overpass, websites and Gemini) | **No** (needs the Gemini key and outbound access; `09` §5) |
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
| D5 | Businesses without a published email are never emailed | WF01 still requires `contact_email` + `email_source_url`. Discovered leads get an email only from their own website; without one they go to `Needs Review` (`contact_readiness = NO_PUBLISHED_EMAIL`), never to drafting. |
| D6 | Deal-value column for `won_value` | Left blank; adding a column needs a schema migration. |
| D7 | Pilot price | Not set (see `06-offer-review.md` §4). |
| D8 | Gemini free tier: model and data terms | `gemini-2.5-flash` in each Config node; only public website text and our prompts are sent; no replies. |
| D9 | Test-mode behaviour | `send_status = TestSent` (a new value), stage stays `Approved`, never re-picked, never counted as contact; WF05 ignores test sends. |
| D10 | "Instant" wording | The template says "within minutes" (the triggers poll); "instant" is a banned phrase in FlowHQ's own wording. |
| D11 | `Disqualified` stage (from Phase 1) | Used by WF02. |
| D12 | Company registries | **Removed** (Companies House, the US/India adapters, their columns, tests and credential). UK legal form now comes from what the website states; a UK lead without a stated Ltd/LLP/plc goes to `Needs Review`. |
| D13 | Sheet migration | Additive only: new Settings rows, 10 Niches columns, 8 Leads columns, 4 Metrics columns, a new Discovery_Log tab (`09` §2.3). WF02 refuses to run until Leads has its columns. Nothing is deleted automatically. |
| D14 | Legal basis per campaign | New `Niches.outreach_basis_reviewed` (default `FALSE`). WF04 refuses **live** sending for a campaign until it is exactly `TRUE`; test mode still works. Set it only after the review in `03` §3. |
| D15 | Discovery provider | OpenStreetMap via the public Overpass API: keyless, ODbL attribution, uneven coverage (`11-discovery-provider.md`). Off by default (`DISCOVERY_ENABLED = FALSE`). Google Places and keyed search APIs were not added. |
| D16 | Example campaigns | India healthcare (Pune) and US home services (Austin) rows are included **inactive**, with `outreach_basis_reviewed = FALSE`. They are examples, not decisions. |

## 5. Interpretations made where the architecture was silent

1. **Daily cap:** counts today's live **and test** sends, from Send_Log **and** Leads, so a failed log write can't let the cap be exceeded.
2. **Additional safety gates beyond architecture §7:**
   - a failure breaker (2 failed sends per day pauses sending);
   - a stuck-`Sending` lead stops all sending;
   - the draft is re-checked at send time;
   - the optional `LIVE_RECIPIENT_ALLOWLIST`.
3. **Approval** needs both `approval_status = Approved` and `stage = Approved`, as architecture §4 and §7 specify. You set both.
4. **Metrics** are cumulative daily snapshots; architecture §8 updated.
5. **WF02 outcomes** map the requested statuses onto the existing stages: NEW = `New Lead`, RESEARCHED = `research_status = RESEARCHED`, QUALIFIED = `Qualified`, NEEDS_REVIEW = `Needs Review` (new stage), DISQUALIFIED = `Disqualified`, SUPPRESSED = `Disqualified` with `Suppressed: …` and `research_status = SKIPPED`. WF02 no longer sets `Researched`; the stage stays valid for hand use. Fetch and AI failures leave the stage unchanged, with `research_status = RETRY` and `last_error`.
6. **Domain-level suppression** is derived automatically from every suppressed address except shared mail providers. A bounce therefore suppresses the whole agency domain (the conservative choice).
