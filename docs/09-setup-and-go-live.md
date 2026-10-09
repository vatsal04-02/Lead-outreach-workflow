# Live setup, validation and go-live (n8n 2.41.6)

This is the step-by-step sequence for your local n8n **2.41.6** (Docker on Windows/WSL2). Every workflow file was import- and engine-tested on 2.41.6 and 2.42.6 with Google services **stubbed**. Nothing has been run against your Google account, Gmail, Gemini, the OpenStreetMap Overpass API or any real website, so each phase below has a real-service check you must do yourself. No company registry (Companies House or any other) is used.

**Safety defaults stay on throughout:** `SENDING_ENABLED = FALSE`, `TEST_MODE = TRUE`. Don't activate WF04 or WF05 until §8.

---

## 1. What you need

| Item | Needed for | Cost | Where |
|---|---|---|---|
| Google account that owns the Sheet | everything | free | — |
| Google Cloud project with **Sheets API**, **Drive API**, **Gmail API** enabled | Sheets + Gmail credentials | free | console.cloud.google.com |
| OAuth client (type *Web application*) | Sheets + Gmail credentials | free | Google Cloud → Credentials |
| Gemini API key | WF02, WF03 | free tier; check the current limits and data terms | aistudio.google.com |
| OpenStreetMap Overpass API | WF02 discovery (optional) | free, **no key**; fair use, ODbL attribution (`11-discovery-provider.md`) | overpass-api.de |
| FlowHQ legal name, postal address, website URL, privacy notice URL | WF03, WF04 | — | Settings tab |
| A sending mailbox on your own domain, with SPF/DKIM/DMARC | WF04 (live) | may cost money (decision D2) | — |

**Environment variables:** the workflows need **none**. Recommended container settings (don't recreate your container just for these; apply them next time you change it):
- `GENERIC_TIMEZONE=Asia/Kolkata` (schedule times), `N8N_ENCRYPTION_KEY` (**back it up**).
- If OAuth redirects fail, `N8N_HOST=localhost`, `N8N_PROTOCOL=http`, `N8N_PORT=5678`, `WEBHOOK_URL=http://localhost:5678/` (see `10-gmail-oauth-troubleshooting.md`).

## 2. Google Sheet

If you already created the Sheet in Phase 2, do **step 3 only** (the migration).

1. **New Sheet:** follow `07-phase-2-setup.md` §2 to import all nine CSVs from `sheets/` with conversion **off**, using exact tab names (`Discovery_Log` is the ninth).
2. Format the **Import** and **Leads** tabs and **column B (`value`) of Settings** as Plain text (**Format → Number → Plain text**). Otherwise Sheets can turn `09:30` into a time value, and WF04 then refuses to send ("SEND_WINDOW_START/SEND_WINDOW_END must be HH:MM"). `TRUE`/`FALSE` work either way.
3. **Migration (existing "FlowHQ Outreach" Sheet).** Nothing here deletes data. Workflows find columns by header name, so new columns go **at the end of row 1** and no existing column moves. Take a copy first (**File → Make a copy**), then:

   a. **Settings:** add any of these rows that are missing, at the bottom. Don't change or reorder existing rows.

   | key | value | notes |
   |---|---|---|
   | `BUSINESS_LEGAL_NAME` | *(your legal name)* | Required in every email footer. |
   | `LIVE_RECIPIENT_ALLOWLIST` | *(blank)* | Optional; used only in the Phase 7 live test. |
   | `DISCOVERY_ENABLED` | `FALSE` | WF02 discovers businesses only when exactly `TRUE`. |
   | `DISCOVERY_QUERIES_PER_RUN` | `2` | Searches per WF02 run, 1–10. |
   | `DISCOVERY_REFRESH_DAYS` | `30` | A completed search is repeated only after this many days. |

   b. **Niches:** add ten headers after the last column (`template_id`), in this order: `industries`, `regions`, `discovery_provider`, `osm_tag_filters`, `outreach_language`, `max_discovered_per_run`, `min_qualify_score`, `required_evidence`, `size_criteria`, `outreach_basis_reviewed`. Fill the `uk-estate-letting` row from `sheets/Niches.csv`: `estate_agent; property_management` · `Reading; Leicester; Norwich` · `osm_overpass` · *(blank)* · `en` · `20` · *(blank)* · `website; published_email; verified_opportunity` · `1-3 branches` · `FALSE`. Keep `outreach_basis_reviewed = FALSE` until the legal review in `03` §3 is done; WF04 blocks live sending until it is `TRUE`. The old `legal_entity_required` column is no longer read: leave it, or delete it by hand. Optionally add the two inactive example campaigns (India, US) from `sheets/Niches.csv`.

   c. **Leads:** add eight headers at the end of row 1, in this order: `business_category`, `services_summary`, `discovery_status`, `research_status`, `researched_at`, `evidence_quality`, `opportunities`, `contact_readiness`. Format them as Plain text. WF02 refuses to run until they exist, and WF01 and WF02 appends fail loudly without them. Columns that are no longer used, and what to do with them:
      - `company_status`: no longer written. Leave it or delete it by hand; either is safe.
      - `registry_country`, `registry_provider`, `registry_status`, `registry_source_url`, `registry_checked_at`, `registry_match_rationale` (only if you added them for the previous version): no longer written or read. Check whether they hold anything first (**Data → Create a filter**, filter each for non-blank). If they do, copy those cells to another tab or file. Then you may delete the six columns, or leave them; nothing reads them.
      - `company_number` and `legal_entity_type` stay. They now mean "as stated on the business's own website, unverified".

   d. **Discovery_Log:** add a new tab named exactly `Discovery_Log` and paste row 1 from `sheets/Discovery_Log.csv`: `query_key, niche_id, provider, country, region, category, run_at, status, results, new_leads, duplicates, skipped, error`.

   e. **Metrics:** add four headers after `won_value`: `discovered`, `researched`, `needs_review`, `send_failures`. Existing rows keep their values; the new cells fill from the next WF06 run.

   f. **Workflows:** re-import WF00–WF06 from `workflows/` as **new** workflows (§4), re-select credentials, and set the Error workflow. Keep the old copies deactivated until the new ones pass §5, then delete the old copies by hand. Every workflow file changed, because the shared code embedded in each Code node changed. Activate nothing yet.

   g. Check: run WF02 by hand with `DISCOVERY_ENABLED = FALSE`. If any header is missing it stops with "The Leads tab is missing columns: …" and changes nothing.

4. Fill in `SENDER_NAME`, `SENDER_EMAIL`, `BUSINESS_POSTAL_ADDRESS`, `WEBSITE_URL`, `PRIVACY_URL` (full `https://` URLs), and `TEST_RECIPIENT` (your own inbox).
5. Optional but helpful: add data validation (**Data → Data validation**, dropdown) on Leads `approval_status` (`Pending, Approved, Rejected, Needs Edit`) and `stage` (the 14 stages in `08-workflows.md` §5, including `Needs Review`).
6. Leave `SENDING_ENABLED = FALSE` and `TEST_MODE = TRUE`.

## 3. Credentials in n8n (Credentials → Add credential)

| Name (suggested) | Type | Values |
|---|---|---|
| FlowHQ Sheets | Google Sheets OAuth2 API | OAuth client ID/secret, then **Sign in with Google** |
| FlowHQ Gmail | Gmail OAuth2 API | same OAuth client, then sign in with the **sending** mailbox. Currently failing for you, so see `10-gmail-oauth-troubleshooting.md`. |
| Gemini | Header Auth | Name = `x-goog-api-key`, Value = your Gemini API key |

No credential, key or token is stored in this repository. The workflow files reference credential types only, and you pick the credential in each node after import.

## 4. Import order and configuration

Import each file with **Create workflow → ⋯ → Import from File → Save**, in this order:

| # | File | Configure after import |
|---|---|---|
| 1 | `WF00-error-handler.json` | **Config:** `sheet_id`, `alert_email`. Sheets credential on *Append to Errors* and *Append Alert Failure*. Gmail credential on *Email Alert*. While Gmail is broken, a failed alert is logged as its own Errors row (`node = Email Alert`), so leave the node active. |
| 2 | `WF01-import-dedupe.json` | **Config:** `sheet_id`. Sheets credential on all 7 Sheets nodes. |
| 3 | `WF02-research-qualify.json` | **Config:** `sheet_id`; `gemini_model` (default `gemini-2.5-flash`; check that this model exists on your free tier in AI Studio); `ai_endpoint` (default Google's Gemini API, must be `https://`); `overpass_url` (default the public Overpass instance). Sheets credential on all 10 Sheets nodes; *Gemini* → Header Auth. *Overpass*, *Fetch Robots*, *Fetch Homepage* and *Fetch Pages* need no credential. |
| 4 | `WF03-draft-generation.json` | **Config:** `sheet_id`, `gemini_model`, `ai_endpoint`. Sheets credential on 6 nodes; *Gemini* → Header Auth. |
| 5 | `WF04-approved-sender.json` | **Config:** `sheet_id`. Sheets credential on 12 nodes; Gmail credential on *Send Email*. **Don't activate.** |
| 6 | `WF05-replies-bounces.json` | **Config:** `sheet_id`. Sheets credential on 5 nodes; Gmail credential on *Get Recent Messages*. **Don't activate.** |
| 7 | `WF06-daily-metrics.json` | **Config:** `sheet_id`, `metrics_timezone`. Sheets credential on 4 nodes. |
| — | `WF00-selftest-trigger.json` | Only for the WF00 test (`07` T6); delete it afterwards. |

Then, in **every** workflow from WF01 to WF06: **⋯ → Settings → Error workflow → WF00 Error Handler**, and save.

> **Activation in n8n 2.x:** a scheduled workflow only runs once it is activated (published). Saving isn't enough. Keep WF04, WF05 and WF06 **inactive** until §8. You can still click **Execute workflow** to run any of them once by hand. That's how all the checks below work.

## 5. Phase-by-phase validation (safe, synthetic data)

Record each result in the checklist in `00-implementation-checklist.md`. If a result differs, stop and send the test ID, a screenshot of the failing node and the error text.

### Phase 2: WF00 and WF01
Run tests T1–T7 in `07-phase-2-setup.md` §7 (fixtures in `sheets/test-fixtures/`, all `.example`).

### Phase 3: WF02 (real Overpass, websites and Gemini; no email)
WF02 never sends email. Use one small search and businesses you can check by hand.

**3a. Research of a hand-picked lead**
1. In **Import**, add **one** row for a business you have researched by hand, with its real published email and its source URL. Run WF01. **Expected:** a `New Lead` with `discovery_status = IMPORTED`, `research_status = PENDING`.
2. Keep `DISCOVERY_ENABLED = FALSE`, and run WF02 (**Execute workflow**).
3. **Expected:** the lead becomes `Qualified`, `Needs Review` or `Disqualified`, always with `qualification_reasoning` (or `disqualify_reason`), `research_status = RESEARCHED` (or `NEEDS_REVIEW`), `evidence_quality` and `contact_readiness`. Open the cited pages: every `evidence` quote and every `observed_excerpt` in `opportunities` must appear word for word. Text marked `(inferred)` is the AI's interpretation, not a fact.
4. A UK lead whose website doesn't state Ltd/LLP/plc goes to `Needs Review`. Confirm its legal form by hand, then set `stage = Qualified` (or `Disqualified`).

**3b. Discovery (one search, five businesses)**
1. Settings: `DISCOVERY_ENABLED = TRUE`, `DISCOVERY_QUERIES_PER_RUN = 1`. Campaign row: `max_discovered_per_run = 5`.
2. Run WF02 once. **Expected:** one Discovery_Log row (`OK`, `EMPTY` or `FAILED` with an `error`), and up to 5 new Leads with `discovery_status = DISCOVERED` and an openstreetmap.org `discovery_source_url`. Open two of those links to confirm the businesses are real. Run WF02 again to research them (research uses the lead list read at the start of each run).
3. Run WF02 a third time. **Expected:** the next region/industry search runs, and no business is added twice.
4. Set `DISCOVERY_ENABLED = FALSE` again until you want regular discovery.

**Failure checks**
- Remove the Gemini credential and run again on a new lead. **Expected:** it stays `New Lead`, with `research_status = RETRY` and an "AI request failed" `last_error`.
- Use a lead with a broken website. **Expected:** it stays `New Lead` with `research_status = RETRY` and "Website fetch failed". Leads with errors go to the back of the queue.
- A lead whose website is a Facebook or directory page goes to `Needs Review` (not fetched).

### Phase 4: WF03
1. Fill in the sender settings (§2.4), then run WF03.
2. **Expected:** the Qualified lead moves to `Draft Ready`, with `approval_status = Pending` and `draft_check_result = PASS`. Read the draft: it should name the agency, quote real evidence, and contain the legal footer and opt-out.
3. Set `approval_status = Needs Edit`, add the word "guaranteed" to the body, and run WF03. **Expected:** `FAIL: banned phrase: guaranteed`. Undo the edit and run again to get `PASS`.

### Phase 5: WF04 in test mode (no prospect can be emailed)
1. Approve the draft: `approval_status = Approved`, `stage = Approved`, `approved_by`, `approved_at`.
2. With `SENDING_ENABLED = FALSE`, execute WF04 by hand. **Expected:** *Gate & Pick* shows `SENDING_ENABLED is not TRUE`, and nothing is sent.
3. Set `SENDING_ENABLED = TRUE` (keep `TEST_MODE = TRUE`), and execute WF04 by hand inside the send window. **Expected:**
   - one email arrives at `TEST_RECIPIENT` with `[TEST]` in the subject and a banner naming the real recipient;
   - the lead shows `send_status = TestSent` and stays `Approved`;
   - Send_Log gets one `test_sent` row.
4. Execute WF04 again. **Expected:** nothing is sent ("last send was less than 8 minutes ago", or "no approved leads waiting").
5. Set `SENDING_ENABLED = FALSE` again.
6. This step needs Gmail OAuth working. Until then, *Send Email* fails, which is itself a valid check: the lead should become `Failed` with `last_error`, Send_Log should get a `failed` row, and WF00 should log an alert (WF00 runs only when the failure comes from an active, scheduled run; for a manual run, look at the error in the editor). To retry, clear `send_status` and `last_error`.

### Phase 6: WF05 and WF06
1. **WF05, unrelated mail:** execute it by hand. **Expected:** a test-mode email is never matched (only real sends are), so no lead changes. That proves WF05 can't touch leads because of test traffic.
2. **WF06:** execute it twice. **Expected:** one `Metrics` row for today, overwritten on the second run.

## 6. Phase 7: safe end-to-end live test (controlled recipients only)

This sends **real** email, but only to mailboxes FlowHQ owns. The allowlist makes reaching a prospect impossible during the test.

1. In **Import**, add 2 test rows. Use websites on `.example` domains (they will fail research, which is fine) and set `contact_email` to **your own** mailboxes, e.g. `you+flowhq-e2e1@yourdomain`. Run WF01.
2. Because a `.example` website can't be researched, set these two rows by hand to `stage = Qualified`, with an `evidence` line such as `"We aim to respond within 24 hours." — https://e2e1.example [test]` and `company_name` set. Run WF03, then approve both.
3. Make sure **no other lead** has `stage = Approved`, `approval_status = Approved` and an empty `send_status`.
4. Settings: `LIVE_RECIPIENT_ALLOWLIST = you+flowhq-e2e1@yourdomain, you+flowhq-e2e2@yourdomain`, `TEST_MODE = FALSE`, `SENDING_ENABLED = TRUE`, `MIN_MINUTES_BETWEEN_SENDS = 0`.
5. Execute WF04 by hand twice. **Expected:** one email per run, each to your own mailbox, with no `[TEST]` prefix; leads go to `Contacted`; Send_Log gets `sent` rows with thread IDs.
6. Execute WF04 a third time. **Expected:** nothing is sent.
7. From mailbox 1, reply "please unsubscribe". From mailbox 2, reply "thanks, interested". Execute WF05.
   - **Expected:** lead 1 → `Unsubscribed`, and Suppression gets its email and domain.
   - **Expected:** lead 2 → `Replied`, `reply_category = needs_review`.
   - Run WF05 again: nothing changes.
8. Set lead 1 back to `Approved` with an empty `send_status`, and execute WF04. **Expected:** it's blocked with "Suppression list", so suppression is final.
9. **Reset:**
   - Settings: `SENDING_ENABLED = FALSE`, `TEST_MODE = TRUE`, `MIN_MINUTES_BETWEEN_SENDS = 8`, `LIVE_RECIPIENT_ALLOWLIST` cleared.
   - Delete the test leads and their Send_Log rows.
   - Keep the Suppression rows. They're harmless, and deleting suppressions is a bad habit.

## 7. Running the automated tests (developers)

| Command | What it does | Needs |
|---|---|---|
| `npm test` | Checks that generated files match `src/`, then runs 161 unit, schema, workflow-structure, discovery, E2E-logic and secret-scan tests | Node ≥ 20 |
| `npm run scan` | Secret, personal-data and real-sheet-ID scan of all committed files | Node ≥ 20 |
| `npm run build` | Regenerates `sheets/` and `workflows/` after editing `src/` | Node ≥ 20 |
| `N8N_BIN=… N8N_USER_FOLDER=$(mktemp -d) npm run test:engine` | Imports all workflows into a **throwaway** n8n and runs 25 engine checks, including discovery → research → draft → send → replies → metrics, the un-migrated-header refusal, a multi-country (India) campaign, robots.txt, prompt injection and website failures, with Google services, Overpass and websites stubbed | n8n 2.x CLI + **Node 24**. Never point `N8N_USER_FOLDER` at your real n8n data. |

CI (`.github/workflows/ci.yml`) runs `npm test` on every push.

## 8. Go-live checklist: no real sending until **all** boxes are ticked and you sign

- [ ] Decisions D1–D6 in `00-implementation-checklist.md` are resolved.
- [ ] Smoke test (`05-niche-smoke-test.md`) has passed with verified records.
- [ ] Privacy notice is live at `PRIVACY_URL`; the legal-basis review for the campaign country is done (`03` §3), and only then that campaign's `outreach_basis_reviewed = TRUE`.
- [ ] Every `Needs Review` lead has been decided by a human (none are sent automatically).
- [ ] `BUSINESS_LEGAL_NAME` and `BUSINESS_POSTAL_ADDRESS` are correct.
- [ ] The sending domain has SPF, DKIM and DMARC.
- [ ] Gmail OAuth works and won't expire weekly (Internal app, or published app; see `10`).
- [ ] Phase 2–7 validations are all recorded as passed on **your** n8n 2.41.6.
- [ ] WF00 self-test has produced an Errors row and an alert email.
- [ ] Every workflow's Error workflow is set to WF00.
- [ ] `DAILY_SEND_LIMIT = 10` (or lower), `MIN_MINUTES_BETWEEN_SENDS ≥ 8`, `LIVE_RECIPIENT_ALLOWLIST` is blank.
- [ ] Every Approved lead has been read by a human today.
- [ ] Laptop power settings: never sleep while plugged in, during 14:00–21:30 IST.
- [ ] **Authorised by (name, date): ____________________**

**Go-live order:**
1. Activate **WF05** first, so opt-outs are processed from the very first send.
2. Activate WF06.
3. Set `TEST_MODE = FALSE`.
4. Set `SENDING_ENABLED = TRUE`.
5. Activate WF04 last.

Watch the first day's Send_Log and Errors tabs.

## 9. Stopping, rollback and recovery

| Situation | Action |
|---|---|
| Stop all sending now | Set `SENDING_ENABLED = FALSE` (effective on the next WF04 run, within 10 min). For a hard stop, deactivate WF04; for the hardest, stop the n8n container (`docker stop <name>`, **not** `rm`). |
| A lead is stuck in `Sending` (all sending pauses) | Search Gmail **Sent** for its subject. **If it was sent:** set `send_status = Sent`, `sent_at`, `stage = Contacted`, and add a Send_Log row (`status = sent`, with the thread ID from Gmail). **If it wasn't sent:** clear `send_status`. |
| A send `Failed` | Read `last_error` and fix the cause (usually OAuth). To retry, clear `send_status` and `last_error`. The failure breaker resets the next day. |
| WF02 made a wrong decision | Set the stage by hand (`Qualified` or `Disqualified`), or fix the data (e.g. `score_override`), set `stage = New Lead`, and re-run WF02. |
| Discovery added unwanted businesses | Set them to `Disqualified` (don't delete; deleted rows can be re-discovered). Add the domain to Suppression to block it permanently. Set `DISCOVERY_ENABLED = FALSE` to stop discovery. |
| A draft is wrong | `approval_status = Needs Edit`, edit it, then run WF03 to re-check it. Or set `stage = Qualified` and clear `email_body` to regenerate. |
| A misclassified opt-out | Leave the Suppression row in place unless you're certain it wasn't an opt-out. Over-suppression is the safe failure. |
| Bad edits to the Sheet | **File → Version history** in Google Sheets lets you restore an earlier version. |
| A workflow change went wrong | In n8n, deactivate it. Re-import the previous version from this repository (`git checkout <commit> -- workflows/<file>`), re-select the credentials, and delete the broken copy. Your credentials and execution history are kept. |
| Backups | Export the Sheet weekly (**File → Download → .xlsx**), keep it out of this repository, and back up `N8N_ENCRYPTION_KEY` and the n8n data volume. Never run destructive Docker commands (`docker volume rm`, `docker compose down -v`). |

## 10. Known limitations

1. **Laptop-bound.** Nothing runs while the laptop sleeps, and missed schedules aren't caught up. Opt-outs are processed only while WF05 runs; legal deadlines are 5–10 business days (`03`), so don't leave the system off for a week while emails are outstanding.
2. **No external service has been verified** from this build environment: Google Sheets, Gmail, Gemini, the Overpass API and real websites were all stubbed (outbound access was blocked).
3. **Polling, not instant.** WF05 reads up to 100 messages from the last 7 days every 15 minutes.
4. **Discovery:**
   - One provider: OpenStreetMap. Coverage is uneven, many small businesses are missing or lack a website tag, and online-only businesses can't be found. Use WF01 import for those.
   - One active campaign at a time (`ACTIVE_NICHE`), because the send window uses the campaign's time zone. Run several countries as separate campaign rows, switching between them.
   - No company registry is checked. Legal form and company number come only from what the website states, and are unverified.
5. **Heuristics:**
   - Bounce and auto-reply detection relies on common formats, and Gmail may not thread every bounce.
   - Opt-out detection is keyword-based and errs towards suppressing.
   - JavaScript-only websites give little text; WF02 fetches at most 3 pages per business and honours robots.txt (a missing or unreadable robots.txt is treated as no restrictions, as RFC 9309 allows).
   - Prompt-injection detection is pattern-based. A flagged site goes to `Needs Review`; unflagged manipulation is limited because quotes must match the page verbatim and a human approves every email.
6. **Gemini free tier:** limits, data-use terms and model names change. Check them before Phase 3, and treat AI output as a suggestion: every quote is verified, and every email is approved by a human.
7. **Window edge:** the send window's end time is exclusive (`16:00` means the last send is at 15:59).
8. **Locking:** the lock-and-re-read in WF04 narrows, but can't fully eliminate, a race between two runs started in the same second. The architecture's single schedule makes this unlikely.
9. **`won_value`** stays blank until a deal-value column is agreed (D6).
10. **Follow-ups are not implemented**, by design (architecture §12).
