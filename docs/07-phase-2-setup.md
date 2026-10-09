# Phase 2 setup: Google Sheet, WF00, and WF01

> **Update (all phases implemented):** this guide still covers Phase 2. The full sequence for every workflow, including the two Settings rows added since Phase 2 (`BUSINESS_LEGAL_NAME`, `LIVE_RECIPIENT_ALLOWLIST`), is in `09-setup-and-go-live.md`. If you import the CSVs now, `sheets/Settings.csv` already contains those rows. In n8n, set every workflow's Error workflow to WF00.

**What's verified so far:**
- The workflow logic passes the unit and schema tests (`npm test`; 161 tests in total now).
- The workflow files import into n8n **2.41.6** and 2.42.6 and run correctly in their engines with Google Sheets and Gmail **stubbed**.

**What isn't verified yet:** real reads and writes against your Google Sheet, and real Gmail alerts. That's what steps 6–7 below test. Phase 2 is complete only when every test in step 7 matches.

Estimated time: 45–60 minutes.

---

## 1. Check your n8n version
Open n8n (usually `http://localhost:5678`) and go to **Help → About n8n**. Write the version down. If any import in step 5 fails, send me that version and the exact error.

## 2. Create the Google Sheet
1. In Google Drive, create a blank spreadsheet called **FlowHQ Outreach**.
2. For **each** file in `sheets/` (`Settings`, `Niches`, `Import`, `Leads`, `Suppression`, `Send_Log`, `Errors`, `Metrics`):
   1. Go to **File → Import → Upload** and choose the CSV.
   2. Set **Import location** to *Insert new sheet(s)*.
   3. **Untick** *Convert text to numbers, dates, and formulas*.
   4. Click **Import data**.
3. Make sure the tab names are **exactly** `Settings`, `Niches`, `Import`, `Leads`, `Suppression`, `Send_Log`, `Errors`, `Metrics` (case-sensitive, no `.csv`). Delete the empty default tab (`Sheet1`).
4. On the **Import** tab, select all cells and go to **Format → Number → Plain text**. This stops Sheets from changing phone numbers and dates as you type.
5. **Don't** rename, reorder, or add header cells. WF01 refuses to write if Leads gains or loses a column.
6. Copy the **sheet ID** from the URL: the part between `/d/` and `/edit`.

## 3. Google Cloud credentials (one-time)
1. Go to [console.cloud.google.com](https://console.cloud.google.com/), create a project (e.g. *FlowHQ n8n*), and enable the **Google Sheets API** and the **Google Drive API**.
2. Under **OAuth consent screen**:
   - With Google Workspace, choose **Internal**.
   - With a personal Gmail account, choose **External** and add yourself as a test user. ⚠ In *Testing* status, the login expires every 7 days (see `02-mvp-architecture.md` §10).
3. Under **Credentials → Create credentials → OAuth client ID**, choose type *Web application*. Under **Authorized redirect URI**, paste the *OAuth Redirect URL* that n8n shows in the next step (usually `http://localhost:5678/rest/oauth2-credential/callback`).
4. In n8n, go to **Credentials → Add credential → Google Sheets OAuth2 API**, paste the client ID and secret, click **Sign in with Google**, and allow access.
5. *(Optional now, required in Phase 5.)* Repeat step 4 with **Gmail OAuth2 API** for the WF00 alert email.

## 4. What gets imported

| File | Purpose |
|---|---|
| `workflows/WF00-error-handler.json` | Error handler (import first) |
| `workflows/WF01-import-dedupe.json` | Manual lead import |
| `workflows/WF00-selftest-trigger.json` | Temporary helper to test WF00. Delete it after step 7. |

## 5. Import and configure
For each file, in this order (WF00, WF01, then the self-test):
1. In n8n, go to **Overview → Create workflow**, open the **⋯** menu (top right) → **Import from File…**, choose the file, then **Save**.
2. Open the **Config** node and replace `PASTE_YOUR_GOOGLE_SHEET_ID_HERE` with your sheet ID. In WF00, also replace `PASTE_FLOWHQ_ALERT_EMAIL_HERE` with the inbox that should receive alerts.
3. Open every **Google Sheets** node and select your *Google Sheets OAuth2* credential. That's 7 nodes in WF01 and 1 in WF00.
4. In WF00's **Email Alert** node, select the Gmail credential. If you haven't set up Gmail yet, right-click the node and choose **Deactivate** for now.
5. In WF01, open **⋯ → Settings**, set **Error workflow** to *WF00 Error Handler*, then **Save**. (Manual runs report errors in the editor; this setting matters once WF01 is scheduled.)
6. **Don't activate** WF00 or WF01. Error workflows run without activation, and WF01 is run manually.

## 6. Load the test data
1. On the **Import** tab, use **File → Import → Upload**, choose `sheets/test-fixtures/Import-test-rows.csv`, and select **Append to current sheet** (with conversion unticked). Then delete the duplicated header row if one appears. You should now have 9 data rows, on sheet rows 2–10.
2. Do the same on the **Suppression** tab with `sheets/test-fixtures/Suppression-test-rows.csv`. You should have 2 rows.

All test data uses the reserved `.example` domain, so it can't match a real business or mailbox.

## 7. Validation tests (record each result)

| # | Do this | Expected result | Pass? |
|---|---|---|---|
| T1 | Open WF01 and click **Execute workflow**. | Every node turns green. On the **Import** tab, rows 2–10 match `sheets/test-fixtures/Import-expected-results.csv` exactly: 3 `IMPORTED`, 3 `REJECTED_INVALID`, 1 `REJECTED_DUPLICATE`, 2 `REJECTED_SUPPRESSED`. `processed_at` is the run time. | |
| T2 | Check the **Leads** tab. | Exactly 3 new rows (`fixture-one.example`, `fixture-two.example`, `fixture-nine.example`), all with stage `New Lead`, niche `uk-estate-letting`, country `UK`. The email for Fixture Nine reads `hello@fixture-nine.example` (lower case, no `mailto:`). | |
| T3 | Run WF01 again without changing anything. | No new Leads rows, and no Import cells change. The *Validate & Dedupe* output shows `skippedAlreadyProcessed: 9`. | |
| T4 | Clear the `import_status` cell on row 2 only, then run WF01. | Row 2 becomes `REJECTED_DUPLICATE` ("lead_id fixture-one.example already exists in Leads"). Leads still has 3 test rows. | |
| T5 | On the **Settings** tab, change `ACTIVE_NICHE` to `none`. Clear row 3's `import_status` and run WF01. Then **change `ACTIVE_NICHE` back to `uk-estate-letting`**. | The run fails at *Validate & Dedupe* with *ACTIVE_NICHE "none" has no row in the Niches tab*. Nothing is written to Leads or Import. | |
| T6 | In the **WF00 Self-Test** workflow, set **⋯ → Settings → Error workflow** to *WF00 Error Handler*. **Activate** it, wait about 2 minutes, then **deactivate** it. | The **Errors** tab gains rows with workflow *WF00 Self-Test (temporary)*, node *Fail On Purpose*, and `lead_id` `selftest.example`. If Gmail is connected, you also get an alert email. | |
| T7 | Clean up. | Delete the test rows from **Leads**, **Import**, **Suppression**, and **Errors**. Delete the self-test workflow. | |

If any result differs, **stop**. Send me the test number, a screenshot of the failing node's output, and the error text. Don't continue to real data until T1–T6 match.

## 8. Using it for real
1. Copy verified `PASS` rows from the smoke test into **Import** (column mapping is in `05-niche-smoke-test.md` §6).
2. Run WF01, then read every `import_message`. Warnings (e.g. "email_source_url is not on the agency website") don't block the import, but they're worth a second look before Phase 3.
3. To retry a rejected row, fix it and clear its `import_status`.

## 9. For developers (optional)
- `npm test` (Node 20+) rebuilds nothing. It fails if `sheets/` or `workflows/` are out of date with `src/`, then runs all unit and schema tests.
- After changing anything in `src/`, run `npm run build`, commit the regenerated files, and re-import the changed workflow into n8n.
- Engine test: `N8N_BIN=/path/to/n8n N8N_USER_FOLDER=$(mktemp -d) node scripts/n8n-engine-test.js` runs the workflows inside a throwaway n8n instance with Sheets and Gmail stubbed. n8n 2.x needs Node 24.
