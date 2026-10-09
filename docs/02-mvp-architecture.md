# MVP architecture

**Status:** Design only. Nothing below has been built or tested. Each workflow gets built and validated in its own phase.

---

## 1. Design principles

1. **Google Sheets is the single source of truth.** You can read and fix everything by hand.
2. **Every risky step has a human in the loop.** Each initial email needs explicit approval.
3. **Fail closed.** If a check can't be completed (a missing setting, an unreadable suppression list, an AI error), nothing is sent.
4. **One email per workflow run.** Sending is slow and deliberate, so a bug can't trigger a burst of mail.
5. **No inbound internet exposure.** The local n8n instance is never published through a tunnel. Every workflow polls; there are no public webhooks.
6. **₹0 tooling.** We use n8n Community Edition (already installed), Google Sheets, Gmail OAuth2, OpenStreetMap data through the free Overpass API, and a free-tier LLM. No company registry.

---

## 2. Data flow

```
 Manual research / CSV ──► [WF01 Import & Dedupe] ──► Leads (New Lead)
 OpenStreetMap (Overpass) ─► [WF02 discovery] ───────► Leads (New Lead, DISCOVERED) + Discovery_Log
                                                         │
 robots.txt + prospect website (≤3 public pages) + Gemini ► [WF02 research & qualify] ──► Qualified / Needs Review / Disqualified
                                                         │
                         Niche template + research ─────►[WF03 Draft]──► Draft Ready
                                                         │
                                  HUMAN edits + approves in the Sheet ──► Approved
                                                         │
   Settings (kill switch, caps, window) + Suppression ──►[WF04 Send, 1 per run]──► Gmail ──► Contacted
                                                         │
                                       Gmail inbox ─────►[WF05 Replies & Bounces]──► Replied / Unsubscribed / Suppression
                                                         │
                                  HUMAN updates sales stages ──► Meeting Opportunity → Proposal Sent → Won / Lost
                                                         │
                                                  [WF06 Daily Metrics] ──► Metrics tab (+ optional digest email to FlowHQ)

 [WF00 Error Handler] catches failures from every workflow ──► Errors tab + alert email to FlowHQ
```

---

## 3. Google Sheet: `FlowHQ Outreach`

### 3.1 `Settings` tab (key / value / notes)

| Key | Start value | Purpose |
|---|---|---|
| `SENDING_ENABLED` | `FALSE` | **Global kill switch.** WF04 reads it on every run. Any value other than exactly `TRUE` means no sending. |
| `TEST_MODE` | `TRUE` | While `TRUE`, every send is redirected to `TEST_RECIPIENT` and the subject gets a `[TEST]` prefix. |
| `TEST_RECIPIENT` | *(a FlowHQ inbox)* | Destination for test sends. |
| `DAILY_SEND_LIMIT` | `10` | Maximum initial emails per day. Raise it slowly and only after you've seen replies and bounce rates. |
| `MIN_MINUTES_BETWEEN_SENDS` | `8` | Spaces sends out. |
| `SEND_DAYS` | `Mon,Tue,Wed,Thu` | Days on which sending is allowed. |
| `SEND_WINDOW_START` / `SEND_WINDOW_END` | `09:30` / `16:00` | In the recipient's time zone (taken from the niche). |
| `ACTIVE_NICHE` | `uk-estate-letting` | The only niche that gets processed. |
| `MIN_QUALIFY_SCORE` | `60` | Starting threshold. Tune it once you've seen real score distributions. |
| `RESEARCH_BATCH_SIZE` | `5` | Leads researched per run. This keeps you inside free-tier AI limits. |
| `SENDER_NAME`, `SENDER_EMAIL` | — | Shown in the email. |
| `BUSINESS_POSTAL_ADDRESS` | — | Required in the email footer. |
| `PRIVACY_URL`, `WEBSITE_URL` | — | Shown in the email footer. |
| `BUSINESS_LEGAL_NAME` | — | *(Added in Phase 4.)* FlowHQ's registered legal name. Required in every email footer by compliance rule 4. WF03 and WF04 refuse to work while it is blank. |
| `LIVE_RECIPIENT_ALLOWLIST` | *(blank)* | *(Added in Phase 7.)* Optional. When it isn't blank, **live** sends go only to these comma-separated addresses, so the end-to-end test can use real FlowHQ-owned mailboxes without any risk of reaching a prospect. Clear it as part of go-live. |
| `DISCOVERY_ENABLED` | `FALSE` | *(Added with discovery.)* WF02 discovers new businesses only when exactly `TRUE`. |
| `DISCOVERY_QUERIES_PER_RUN` | `2` | Searches (region × industry) per WF02 run, 1–10. |
| `DISCOVERY_REFRESH_DAYS` | `30` | A completed search is repeated only after this many days; failed searches are retried on the next run. |

### 3.2 `Niches` tab (campaign targeting)
One row per **campaign**. The fields are listed in `01-strategy-icp-offer.md` §8. Targeting (country, regions, industries or `all`, size criteria, minimum score, required evidence, outreach language, discovery volume) lives here, not in workflow code. Only the campaign named in `Settings.ACTIVE_NICHE` is processed; run one campaign per country and time zone, and switch `ACTIVE_NICHE` to change campaigns.

### 3.3 `Leads` tab (one row per business)

| Column | Filled by | Notes |
|---|---|---|
| `lead_id` | WF01 | The normalised registrable domain, e.g. `smithlettings.co.uk`. **This is the dedupe key.** |
| `niche_id`, `country` | WF01 | |
| `company_name`, `website`, `city`, `region` | Import | |
| `contact_name`, `contact_role` | Import / WF02 | Only if publicly stated by the business on its own website (or in the imported source). |
| `contact_email` | Import | Must be copied from a public page. **Never guessed or pattern-generated.** |
| `email_source_url` | Import | The exact page where the email address was found. Required. |
| `phone` | Import | Optional. |
| `discovery_source`, `discovery_source_url`, `discovered_at` | Import / WF01 | |
| `company_number`, `legal_entity_type` | WF02 / import | As **stated on the business's own website** (e.g. a footer "Company No." or "Ltd"), observed and **unverified**. No registry is queried. `legal_entity_type` is used for the UK PECR review rule (§5). |
| `stage` | Workflows / human | See §4. |
| `fit_score`, `problem_score`, `contact_score`, `channel_score` | WF02 | Each 0–3 (see §5). |
| `total_score`, `score_override` | WF02 / human | The override wins if it's filled in. |
| `qualification_reasoning` | WF02 | 2–4 sentences. |
| `evidence` | WF02 | Exact quotes, each with its URL. |
| `opportunity_hypothesis` | WF02 | One sentence: the automation that might help them. |
| `disqualify_reason` | WF02 / human | |
| `template_id`, `email_subject`, `email_body`, `draft_generated_at`, `draft_check_result` | WF03 | |
| `approval_status` | **Human** | Dropdown: `Pending` / `Approved` / `Rejected` / `Needs Edit`. |
| `approved_by`, `approved_at` | Human | |
| `send_status` | WF04 | `Sending` / `Sent` / `Failed`. `Sending` is written **before** the Gmail call, acting as an idempotency lock. |
| `sent_at`, `gmail_message_id`, `gmail_thread_id` | WF04 | |
| `reply_status`, `reply_received_at`, `reply_category` | WF05 / human | |
| `next_action`, `next_action_due`, `notes` | Human | |
| `last_updated`, `last_error` | All | |
| `business_category` | WF02 discovery / AI | From the OpenStreetMap category tag (observed) or the AI's reading of the pages (inferred). |
| `services_summary` | WF02 (AI) | One sentence, prefixed `(inferred)`. |
| `discovery_status` | WF01 / WF02 | `IMPORTED` or `DISCOVERED`. |
| `research_status` | WF02 | `PENDING`, `RESEARCHED`, `NEEDS_REVIEW`, `RETRY` (website or AI failure; retried later, after fresh leads), `SKIPPED` (suppressed). |
| `researched_at` | WF02 | When research last ran. |
| `evidence_quality` | WF02 | `NONE`, `WEAK`, `MODERATE`, `STRONG` (computed by code from verified excerpts and page credibility). |
| `opportunities` | WF02 | JSON list of verified opportunities: `opportunity_type`, `observed_excerpt` (verbatim), `source_url`, `observed_fact`, `inferred_opportunity`, `why_relevant`, `confidence`, `uncertainty`. |
| `contact_readiness` | WF02 | `READY` (business email published on its own site), `READY_SHARED_MAILBOX`, `NO_PUBLISHED_EMAIL`. |

**Observed facts vs inferences.** `evidence` and each opportunity's `observed_excerpt` are verbatim text found on the cited page (checked by code). `observed_fact`, `inferred_opportunity`, `why_relevant`, `services_summary`, `opportunity_hypothesis` and the AI part of `qualification_reasoning` are model inferences and are labelled as such. Contact emails are never taken from the AI or from OpenStreetMap; only from the business's own pages, on its own domain (or a shared mailbox it publishes there).

**No company-registry checks.** Earlier versions verified UK companies on Companies House and designed US/India registry adapters. These were removed: qualification uses public business evidence only, and no registry API key is needed.

### 3.4 `Suppression` tab
`email`, `domain`, `reason` (`unsubscribe` / `bounce` / `complaint` / `manual` / `no_solicitation_notice`), `source`, `added_at`.
Suppression applies at **both email and domain level** for initial outreach. Entries are never deleted.
**Exception:** shared mailbox providers (gmail.com, btinternet.com, outlook.com and similar) are never suppressed at domain level, because that would block every agency using that provider. Only the individual address is suppressed. WF01 implements this list in `src/wf01-import-logic.js`.

### 3.5 Other tabs
- `Send_Log`: an append-only record of every send attempt (`lead_id`, `to_email`, `subject`, `attempted_at`, `status`, `gmail_message_id`, `gmail_thread_id`, `test_mode`, `error`).
- `Errors`: `timestamp`, `workflow`, `node`, `lead_id`, `message`.
- `Metrics`: one row per day (see §8).
- `Discovery_Log`: one row per discovery search (`query_key, niche_id, provider, country, region, category, run_at, status, results, new_leads, duplicates, skipped, error`); WF02 uses it to rotate searches.

### 3.6 `Import` tab (input for WF01)
The human-filled Leads columns, in this order: `company_name`, `website`, `city`, `region`, `contact_name`, `contact_role`, `contact_email`, `email_source_url`, `phone`, `discovery_source`, `discovery_source_url`, `discovered_at`, `notes`. These are followed by four status columns that WF01 writes back: `import_status` (`IMPORTED` / `REJECTED_INVALID` / `REJECTED_DUPLICATE` / `REJECTED_SUPPRESSED`), `import_message`, `lead_id`, `processed_at`.
- Required: `company_name`, `website`, `contact_email`, `email_source_url`. A lead without a published email can't be contacted, so it stays in the research sheet rather than entering Leads.
- WF01 skips rows that already have an `import_status`, so re-running it never re-imports a row. To retry a rejected row, fix it and clear its `import_status`.

The canonical column lists for every tab live in `src/schema.js`. `npm test` fails if they drift from this document.

---

## 4. Stages

The brief's stage list, plus two additions: `Disqualified` and `Needs Review`. The requested statuses map onto them: NEW → New Lead, RESEARCHED/QUALIFIED/DISQUALIFIED → the same names, NEEDS_REVIEW → Needs Review, SUPPRESSED → Disqualified with `disqualify_reason = Suppressed: …` (and Unsubscribed for opt-outs). `research_status` tracks the research step separately.

| Stage | Set by | Rule |
|---|---|---|
| New Lead | WF01 / WF02 discovery | Imported or discovered, deduplicated, not suppressed |
| Researched | human | Optional manual marker; WF02 no longer sets it. (Fetch and AI failures leave the stage unchanged with `research_status = RETRY`.) |
| **Needs Review** *(new)* | WF02 | Evidence is missing or weak, no published email, possible prompt injection, a profile page instead of a website, robots.txt disallows, or the UK legal-form rule. A human decides. |
| Qualified | WF02 | `total_score ≥` the campaign minimum, required evidence present, evidence quality at least MODERATE, and all hard gates pass |
| **Disqualified** *(new)* | WF02 / human | A hard gate failed or the score is below the threshold. Reason recorded. |
| Draft Ready | WF03 | Draft generated **and** passed automated checks |
| Approved | Human | `approval_status = Approved` |
| Contacted | WF04 | Gmail returned a message ID |
| Replied | WF05 | A reply was found in the sent thread |
| Meeting Opportunity | Human | |
| Proposal Sent | Human | |
| Won / Lost | Human | |
| Unsubscribed | WF05 / human | Opt-out detected. The address and domain are also added to Suppression. |

---

## 5. Qualification scoring (WF02)

Industry- and country-independent. The model proposes values; code verifies and caps them, and computes the total, so the AI never does the arithmetic.

| Dimension | Weight | How it is set |
|---|---|---|
| **Fit** (`fit_score`) | 30 | Model's relevance to the campaign target (0–3), capped at 1 when the lead's known city/region is outside the campaign regions. |
| **Opportunity evidence** (`problem_score`) | 30 | Code: 0 with no verified opportunity; 1 = one low-confidence; 2 = one medium/high, or two; 3 = two or more with at least one medium/high. An opportunity counts only if its excerpt appears **verbatim** on the cited page. |
| **Contact relevance** (`contact_score`) | 20 | Model 0–3, capped by code: 1 without a verified named person; 2 when the address is a role mailbox. |
| **Channel** (`channel_score`) | 20 | Code: 0 no published email; 2 role or shared mailbox; 3 a personal address on the business's own domain. |

`total_score = Σ (score / 3 × weight)` → 0–100. `score_override` replaces it when filled in. The minimum is the campaign's `min_qualify_score`, or `Settings.MIN_QUALIFY_SCORE`.

**Hard gates → Disqualified:** a no-solicitation notice (deterministic or verified quote); a verified campaign exclusion; the email or domain is suppressed.

**→ Needs Review (never a fabricated score):**
- a required evidence item is missing (`required_evidence`: `website`, `published_email`, `verified_opportunity`, `two_facts`);
- evidence quality is `NONE` or `WEAK`;
- suspected prompt injection on a page;
- a profile/directory page instead of a website;
- robots.txt disallows the site;
- **UK campaigns:** the website doesn't state a Ltd/LLP/plc legal form. Under PECR, sole traders and partnerships need prior consent, so a human checks.

A high score is not evidence of buying intent, and nothing in the system records buying intent.

---

## 6. Workflows (built one phase at a time)

| ID | Workflow | Phase | Trigger | Key safety behaviour |
|---|---|---|---|---|
| WF00 | Error Handler | 2 | Error Trigger | Writes to `Errors` and emails FlowHQ. Every other workflow points to it. The alert address lives in WF00's own Config node, so alerts still work when Sheets is what failed. n8n only calls error workflows for production (scheduled or triggered) runs. Failures in manual runs show in the editor instead. |
| WF01 | Import & Dedupe | 2 | Manual (reads an `Import` tab) | Normalises the domain and email. Rejects duplicates, suppressed entries, and rows without `email_source_url`. |
| WF02 | Discovery, Research & Qualify | 3 | Manual | Optional OpenStreetMap discovery (rotating, logged searches). Research respects robots.txt and fetches the homepage plus at most 2 pages, with a low, identifiable request rate. JSON output is schema-validated; invalid output changes no AI-derived data. Never sends email. |
| WF03 | Draft Generation | 4 | Manual | Per-campaign template (`general-automation-v1` is industry-independent and built around the lead's verified opportunity). Checks reject drafts with unresolved `{placeholders}`, numbers or percentages not present in the evidence, banned phrases ("case study", "our clients", "guarantee", …), more than ~120 words, or a missing footer. |
| WF04 | Approved Sender | 5 | Schedule, every 10 minutes | See §7. |
| WF05 | Replies & Bounces | 6 | Schedule, every 15 minutes | Matches Gmail `threadId` against `Send_Log`. **Opt-out detection is keyword-based (no AI)** and suppresses immediately. Bounces from `mailer-daemon` are suppressed. Other replies are marked `Replied` for a human to read. |
| WF06 | Daily Metrics | 6 | Schedule, daily | Counts by stage and writes a row to `Metrics`. |

Exported workflow JSON goes in `workflows/` in this repo. The exports contain credential **types** only, never secrets. **All six workflows are implemented.** Their inputs, outputs, failure handling, idempotency and tests are documented in `08-workflows.md`.

---

## 7. Sending safety (WF04), in execution order

1. Read `Settings`. If it can't be read, or `SENDING_ENABLED ≠ TRUE`, **stop**. In live mode, also stop unless the campaign's `outreach_basis_reviewed` is exactly `TRUE`.
2. Check that now is inside `SEND_DAYS` and `SEND_WINDOW_*` in the niche's time zone (using Luxon, which is built into n8n).
3. Count today's `Sent` rows in `Send_Log`. If the count is `≥ DAILY_SEND_LIMIT`, stop. If the last send was less than `MIN_MINUTES_BETWEEN_SENDS` ago, stop.
4. Pick **one** lead where `stage = Approved`, `approval_status = Approved`, and `send_status` is empty.
5. Re-check, right now: the email and domain are not in Suppression, there's no prior `Sent` to this email or domain in `Send_Log`, and `draft_check_result = PASS`.
6. Write `send_status = Sending`. This is the lock that stops a retry or overlapping run from sending twice.
7. If `TEST_MODE = TRUE`, replace the recipient with `TEST_RECIPIENT`.
8. Send through the Gmail node (OAuth2).
9. On success: write `Sent`, the message and thread IDs, `sent_at`, and `stage = Contacted`, then append to `Send_Log`. On failure: write `Failed` and the error, and **don't auto-retry**. A human decides.

**Implemented additions to this sequence** (see `00-implementation-checklist.md` §5):
- The daily cap also counts test sends and Leads rows, not only Send_Log.
- Two failed sends in a day pause sending until the next day.
- A lead left in `Sending` stops all sending until a human resolves it.
- The draft is re-checked at send time, in case it was edited after approval.
- After locking, the row is re-read to confirm this run holds the lock.
- In test mode the lead gets `send_status = TestSent` (never picked again) and keeps stage `Approved`.
- An optional `LIVE_RECIPIENT_ALLOWLIST` restricts live sends during the Phase 7 test.

**Stop methods, from fastest to strongest:**
1. Set `SENDING_ENABLED` to `FALSE` in the Sheet.
2. Deactivate WF04 in n8n.
3. Stop the n8n container.
4. Revoke the Gmail credential in your Google Account.

---

## 8. Metrics (focused on outcomes, not volume)

New leads, discovered, researched, needs review, qualified, qualification rate, drafts approved / rejected, **emails sent**, bounces (with rate), unsubscribes, send failures, **replies**, **positive replies**, **meetings booked**, **proposals sent**, **clients won**, and won value. The headline numbers are **positive replies, meetings, and clients**.

As implemented, WF06 writes one row per day of **cumulative totals**; the daily change is the difference between two rows. Exact definitions are in `08-workflows.md` (WF06). `won_value` stays blank until Leads has a deal-value column.

---

## 9. AI model usage

- **Default: Google Gemini API free tier** through n8n's built-in Gemini nodes, or an HTTP Request. Free-tier limits and terms change, so **check the current limits and data-use terms when we reach Phase 3.** Free tiers may use inputs to improve the provider's products.
- **Only public website text and our own prompts are sent to the AI**, with email addresses and phone numbers redacted first. Reply emails (private correspondence) are **not** sent to any AI; replies are handled with keyword rules plus a human.
- The model, endpoint (`gemini_model`, `ai_endpoint`) and key (n8n credential) are configurable. A failed call or invalid JSON keeps the lead and its evidence, sets `research_status = RETRY` with `last_error`, and is retried on a later run.
- **Prompt injection:** page text is fenced and labelled as untrusted data; the model can't fetch URLs, choose contacts, or bypass gates; quotes that look like instructions are rejected; and a page containing injection-like text forces `Needs Review`.
- **Alternative:** Ollama running locally (free, and no data leaves the laptop). It needs enough RAM, and drafts from small models are usually weaker. This is an option if the free tiers become unsuitable.
- AI output is always: structured JSON, schema-validated, and reviewed by a human before anything is sent.

---

## 10. Gmail OAuth2 setup notes (for Phase 5)

- Create a Google Cloud project and enable the Gmail API and the Google Sheets API.
- Set the OAuth redirect URI to `http://localhost:5678/rest/oauth2-credential/callback` (adjust it if your n8n URL differs).
- **Known gotcha:** if the OAuth consent screen is "External" and still in **Testing** status, Google refresh tokens **expire after 7 days**, and sending will silently stop working. With Google Workspace, use the **Internal** user type. With a personal Gmail account, plan for this (publish the app for your own use, or re-authorise weekly), and WF00 will alert you on auth errors.
- Set up SPF, DKIM, and DMARC on the sending domain.
- Volume: start at 10 per day. Gmail's hard limits are far above this, but **deliverability and domain reputation, not Gmail's limits, are the real constraint.**

---

## 11. Running on a laptop (explicit limitation)

- **Workflows run only while the laptop is on, awake, and Docker Desktop and the n8n container are running.** Sleep, shutdown, or a closed lid stops everything.
- **Missed schedules are not caught up.** If the laptop was off during the UK sending window, those sends simply don't happen that day. That's acceptable for outreach. It's **not** acceptable for client production workflows, which is why those run on client-owned hosting.
- The UK sending window of 09:30–16:00 London time is about **14:00–20:30 IST** in UK summer and **15:00–21:30 IST** in UK winter. Keep the laptop awake then: set Windows power settings to "never sleep when plugged in".
- Recommended container settings: `restart: unless-stopped`, `GENERIC_TIMEZONE=Asia/Kolkata`. The send window is calculated in the recipient's time zone inside the workflow.
- **Back up `N8N_ENCRYPTION_KEY` and the n8n data volume.** Without the key, saved credentials can't be decrypted.

---

## 12. Deliberately out of scope for the MVP

- Scraping Google Maps, portals, LinkedIn or other sites whose terms forbid it. Discovery uses OpenStreetMap open data only; manual import stays available.
- **Automated follow-ups.** These come only after the initial flow has been reliable for at least 2 weeks.
- Open and click tracking (pixels or link rewriting). It has privacy, deliverability, and complexity costs.
- Multiple sending mailboxes, a CRM, and paid tools.
- Any AI that reads or replies to prospect emails on its own.
