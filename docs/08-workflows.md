# Workflow inventory and reference

Every workflow below is **generated** by `npm run build` from the tested source in `src/`. Don't edit the JSON by hand; `npm test` fails if a workflow file drifts from its source.

## 1. Inventory

| ID | File | Trigger | Phase | Responsibility |
|---|---|---|---|---|
| WF00 | `workflows/WF00-error-handler.json` | Error Trigger | 2 | Turns any production failure into an `Errors` row and an alert email. |
| — | `workflows/WF00-selftest-trigger.json` | Schedule (1 min) | 2 | Temporary helper that fails on purpose to test WF00. Delete it after the test. |
| WF01 | `workflows/WF01-import-dedupe.json` | Manual | 2 | Validates and normalises `Import` rows, dedupes them, enforces suppression, and appends `New Lead` rows. |
| WF02 | `workflows/WF02-research-qualify.json` | Manual | 3 | Researches each lead's website, checks Companies House, asks Gemini for a score, verifies its quotes, applies the gates, and sets Qualified, Disqualified or Researched. |
| WF03 | `workflows/WF03-draft-generation.json` | Manual | 4 | Builds a template draft with one AI sentence, checks it, and moves the lead to `Draft Ready` / `Pending`. Also re-checks drafts you've edited. |
| WF04 | `workflows/WF04-approved-sender.json` | Schedule (10 min) | 5 | Sends at most one approved email per run, behind every safety gate. |
| WF05 | `workflows/WF05-replies-bounces.json` | Schedule (15 min) | 6 | Detects replies, opt-outs, bounces and auto-replies; adds Suppression rows; updates reply fields. |
| WF06 | `workflows/WF06-daily-metrics.json` | Schedule (daily 21:05) | 6 | Writes the daily `Metrics` snapshot. |

Approval (Phase 5) is **done by a human** in the Sheet, not by a workflow. Automated follow-ups are **not implemented**, deliberately: the architecture (§12) allows them only after the initial flow has been reliable for at least 2 weeks.

## 2. Architecture and dependency map

```
                    ┌────────────── Google Sheet "FlowHQ Outreach" (source of truth) ──────────────┐
                    │ Settings  Niches  Import  Leads  Suppression  Send_Log  Errors  Metrics       │
                    └──▲──────────▲───────▲───────▲──────────▲───────────▲────────▲────────▲───────┘
 human research ──► Import        │       │       │          │           │        │        │
                    │  WF01 ──────┴───────┴──► Leads (New Lead)          │        │        │
                    │  WF02 ──► website (HTTP) ─► Companies House API ─► Gemini API ─► Leads (scores)
                    │  WF03 ──► Gemini API ─► Leads (draft, Draft Ready/Pending)          │
 human approval ──► Leads (stage Approved, approval_status Approved)                      │
                    │  WF04 ──► lock Leads ─► re-read ─► Gmail send ─► Leads + Send_Log    │
                    │  WF05 ◄── Gmail inbox ─► Suppression + Leads (reply fields)          │
                    │  WF06 ──► Metrics                                                    │
                    │  WF00 ◄── failures of WF04/05/06 (and WF01-03 when scheduled) ─► Errors + alert email
```

| Dependency | Used by | Credential type in n8n | Verified against the real service? |
|---|---|---|---|
| Google Sheets API | all | Google Sheets OAuth2 API | **No.** Stubbed in tests. |
| Gmail API (send) | WF00, WF04 | Gmail OAuth2 API | **No.** Your Gmail OAuth is currently broken, and Gmail was stubbed. |
| Gmail API (read) | WF05 | Gmail OAuth2 API | **No.** Stubbed. |
| Companies House public data API (free) | WF02 | Basic Auth (API key as user, blank password) | **No.** Stubbed (and the host is blocked in the build environment). |
| Google Gemini API (free tier) | WF02, WF03 | Header Auth, `x-goog-api-key` | **No.** Stubbed. |
| Prospect websites | WF02 | none | **No.** Stubbed. |

## 3. Shared code

| Module | Contents | Used by |
|---|---|---|
| `src/lib/common.js` | Domain and email parsing, suppression index, settings, active-niche resolution (fails closed), time-zone helpers, evidence format, item pairing | all |
| `src/lib/gemini.js` | Request URL and body; tolerant JSON parsing (never throws) | WF02, WF03 |
| `src/lib/drafting.js` | Versioned template `uk-estate-letting-v1`, legal footer, draft checks | WF03, WF04 |
| `src/schema.js` | Every tab's exact columns, plus the Settings and Niches seed rows | build, tests |

## 4. Per-workflow reference

### WF00 Error Handler
- **Inputs:** Error Trigger payload. **Outputs:** an `Errors` row (`timestamp, workflow, node, lead_id, message`) and an email to Config `alert_email`.
- **Dependencies:** Sheets, Gmail (optional until Gmail works; deactivate **Email Alert** until then).
- **Failure handling:** the Sheets append and the email both continue on error, so one can't block the other. n8n doesn't run error workflows for **manual** executions.
- **Idempotency:** one row per failure. **Tests:** `tests/wf00-format-error.test.js`, engine "WF00".

### WF01 Import & Dedupe
- **Inputs:** `Settings`, `Niches`, `Leads`, `Suppression`, `Import`. **Outputs:** new `Leads` rows, plus `import_status/import_message/lead_id/processed_at` written back on each Import row (matched by `row_number`).
- **Rules:** requires `company_name, website, contact_email, email_source_url`; one valid email per row; normalises the domain into `lead_id`; dedupes against Leads and within the batch; enforces suppression; skips rows that already have a status.
- **Failure handling:** a missing or inactive niche aborts the run with no writes. Leads are appended **before** statuses are written, so a failed append leaves the rows to retry.
- **Tests:** `tests/wf01-import-logic.test.js`, engine "WF01 …".

### WF02 Research & Qualify
- **Inputs:** `Settings` (`RESEARCH_BATCH_SIZE`, `MIN_QUALIFY_SCORE`, `ACTIVE_NICHE`), `Niches`, `Leads` (stage `New Lead`), `Suppression`; the website; Companies House; Gemini.
- **Outputs (Leads, matched on `lead_id`):** `company_number, company_status, legal_entity_type, stage, fit/problem/contact/channel/total_score, qualification_reasoning, evidence, opportunity_hypothesis, disqualify_reason, contact_name, contact_role, last_updated, last_error`. Every update writes all of these, keeping unchanged values.
- **Rules:**
  - Fetches at most 3 pages per lead, one request per second, with an identifying User-Agent.
  - The Companies House company number comes from `company_number` if you've entered it, otherwise from the website footer, otherwise from an exact name search.
  - The company must be active and limited (ltd/llp/plc/guarantee variants), or the lead is Disqualified.
  - A Gemini quote counts only if it appears **verbatim** on the page it cites. `problem_score` is capped at 1 without a verified quote and at 2 with one.
  - `channel_score` is computed by code (role vs personal address). `contact_score` is capped by what is verified.
  - A no-solicitation notice, a verified exclusion, or no published email is a hard gate.
  - `score_override` replaces the computed total when it's filled in.
- **Outcomes:**
  - `Qualified`.
  - `Disqualified`, with the reason.
  - `Researched`, when Companies House can't be matched automatically. Enter `company_number`, set the stage back to `New Lead`, and re-run.
  - Stage unchanged with `last_error`, on a website or AI failure. These leads are retried, after fresh leads.
- **Idempotency:** only `New Lead` rows are processed.
- **Tests:** `tests/wf02-research-logic.test.js`, engine E2E steps 2–3.

### WF03 Draft Generation
- **Inputs:** `Settings` (sender identity), `Niches` (`template_id`, `cta`), `Leads`, `Suppression`; Gemini.
- **Outputs:**
  - New drafts: `template_id, email_subject, email_body, draft_generated_at, draft_check_result, stage, approval_status, last_updated, last_error`.
  - Re-checks: `draft_check_result, last_updated, last_error`.
- **Rules:**
  - Gemini writes only the subject and one sentence. That sentence is rejected for links, banned claims, unsupported numbers or quotes, more than 45 words, or not naming the agency, and replaced by a sentence quoting the stored evidence.
  - The full draft must pass the checks: legal footer intact; no placeholders or banned claims; at most 120 words in the body; only the website and privacy links; numbers and quotes only from the evidence; at least one evidence item; agency named; sensible subject.
  - Passing drafts move to `Draft Ready` with `approval_status = Pending`.
  - Drafts that fail stay `Qualified` with `FAIL: …`.
- **Fails closed** if any of `SENDER_NAME, BUSINESS_LEGAL_NAME, BUSINESS_POSTAL_ADDRESS, WEBSITE_URL, PRIVACY_URL` is blank.
- **Idempotency:** only `Qualified` rows get drafted. `Draft Ready` + `Needs Edit` rows are re-checked, never regenerated.
- **Tests:** `tests/wf03-drafting.test.js`, engine E2E step 4.

### Approval (human, Phase 5)
In `Leads`, after reading the draft: set `approval_status = Approved`, `approved_by`, `approved_at` and **`stage = Approved`**. All four are needed, because WF04 picks only rows with stage and status both `Approved`. To change a draft, set `approval_status = Needs Edit`, edit `email_subject`/`email_body`, and re-run WF03 to re-check it. To refuse it, set `approval_status = Rejected`.

### WF04 Approved Sender
- **Inputs:** `Settings`, `Niches` (time zone), `Leads`, `Suppression`, `Send_Log`. **Outputs:**
  - Leads: lock `send_status=Sending`, then a result (`send_status, sent_at, gmail_message_id, gmail_thread_id, stage, last_updated, last_error`); notes (`last_error`) on blocked leads.
  - One `Send_Log` row per attempt.
- **Gates, in order:**
  1. `SENDING_ENABLED` exactly `TRUE`.
  2. Valid configuration (anything invalid throws, which triggers a WF00 alert).
  3. `SEND_DAYS`, and the window in the niche time zone.
  4. Daily cap (counting Send_Log **and** Leads).
  5. Failure breaker: 2 failed attempts per day.
  6. `MIN_MINUTES_BETWEEN_SENDS`.
  7. No lead stuck in `Sending`.
  8. Then, per candidate (oldest approval first): valid email; `draft_check_result` PASS; not suppressed; no previous real send to that email or domain; the draft re-check passes (in case of human edits); and, in live mode, `LIVE_RECIPIENT_ALLOWLIST` if it's set.
- **Test mode** (on unless exactly `FALSE`): the email goes to `TEST_RECIPIENT` with a `[TEST]` subject and banner. The lead becomes `send_status = TestSent` and keeps stage `Approved`, and the log status is `test_sent`. Test sends never count as contact.
- **Duplicate protection:**
  - The lock is written before Gmail, and re-read to confirm this run owns it.
  - Picking requires an empty `send_status`.
  - The Send_Log email and domain history is checked.
  - A lead left in `Sending` blocks all sending until you resolve it.
- **Failure:** Gmail errors go to the error branch. The lead becomes `Failed` (never retried automatically), a Send_Log `failed` row is written, and Stop and Error raises a WF00 alert that includes the `lead_id`.
- **Tests:** `tests/wf04-send-logic.test.js`, engine E2E steps 5–8, and the final suppression check.

### WF05 Replies & Bounces
- **Inputs:** `Leads`, `Send_Log` (only `status = sent`), `Suppression`; Gmail messages from the last 7 days, read and unread.
- **Outputs:** `Suppression` rows (written first), and Leads `stage, reply_status, reply_received_at, reply_category, next_action, last_updated`.
- **Rules:**
  - Messages are matched to leads by Gmail thread, and bounces also by failed recipient.
  - Quoted history is removed before any keyword check, because the original email's footer contains "unsubscribe".
  - Bounces are recognised by sender or subject, using the `X-Failed-Recipients` header or a sent address.
  - Auto-replies are recognised by the `Auto-Submitted` header or the subject, and never override a real reply.
  - An opt-out suppresses the address and the company domain, and sets stage `Unsubscribed`. The exception is a lead in a human sales stage (Meeting, Proposal, Won, Lost): its stage is kept and `next_action` flags it.
  - Other replies give `Replied` with `reply_category = needs_review`.
- **No AI reads replies.**
- **Values written:** `reply_status` is one of `replied / unsubscribed / bounced / auto_reply`. `reply_category` is one of `needs_review / unsubscribe / bounce / auto_reply`, and you set `positive / neutral / negative` yourself.
- **Idempotency:** the `reply_received_at` watermark per lead, plus suppression dedupe.
- **Tests:** `tests/wf05-wf06.test.js`, engine E2E step 9.

### WF06 Daily Metrics
- **Output:** one `Metrics` row per date (in the Config `metrics_timezone`, default `Asia/Kolkata`) holding **cumulative totals**. The difference between two rows is the activity in between. Re-running replaces that day's row.
- **Definitions:**
  - `new_leads` = all leads.
  - `qualified` = Qualified or any later stage.
  - `qualification_rate` = qualified ÷ researched.
  - `emails_sent` = live sends only.
  - `bounces` / `unsubscribes` = unique suppressed addresses with that reason.
  - `replies` = `reply_status` replied or unsubscribed.
  - `positive_replies` = `reply_category = positive`.
  - `meetings_booked` = Meeting / Proposal / Won.
  - `proposals_sent` = Proposal / Won.
  - `clients_won` = Won.
  - `won_value` is blank because Leads has no deal-value column (decision D6).
- **Tests:** `tests/wf05-wf06.test.js`, engine E2E step 9.

## 5. Values used in Leads

| Column | Values | Set by |
|---|---|---|
| `stage` | New Lead, Researched, Qualified, Disqualified, Draft Ready, Approved, Contacted, Replied, Meeting Opportunity, Proposal Sent, Won, Lost, Unsubscribed | workflows and you |
| `approval_status` | Pending (WF03), Approved / Rejected / Needs Edit (you) | |
| `send_status` | Sending, Sent, Failed (architecture §3.3), **TestSent** (added: a test-mode send, never picked again) | WF04 |
| `draft_check_result` | `PASS` or `FAIL: reasons` | WF03, WF04 notes |
| `reply_status` / `reply_category` | see WF05 | WF05 and you |
