# Repository review before Phase 2 (2026-10-09)

> Historical record from the Phase 2 round. The current status, audit and decisions are in `00-implementation-checklist.md`.

## 1. State before this change

- Branch `claude/kind-johnson-ik3vzk` held one commit (`6126b08`) and four files: the README and the three Phase 1 docs. The working tree was clean, and there was no other branch or unrelated work to protect.
- **Nothing was implemented.** There were no sheets, workflows, code, or tests. Phase 1 existed only as documentation, and its sign-off decisions (`01-strategy-icp-offer.md` §9) are **still open**.

## 2. Documented vs. implemented after this change

| Item | Status | Evidence |
|---|---|---|
| Phase 1 strategy, ICP, offer | Documented; FlowHQ sign-off still pending | `docs/01–03` |
| Niche smoke test (20 agencies) | **Not run.** Research template and 22 *unverified* candidate names prepared | `docs/05-niche-smoke-test.md`, `research/` |
| Offer feasibility review | Documented | `docs/06-offer-review.md` |
| Sheet templates (8 tabs) | Implemented | `sheets/*.csv`, generated from `src/schema.js` |
| WF00 Error Handler | Implemented. Engine-tested in n8n 2.42.6 with Sheets and Gmail stubbed. **Not yet run against your Google account.** | `workflows/WF00-error-handler.json` |
| WF01 Import & Dedupe | Implemented. Unit-tested and engine-tested with Sheets stubbed. **Not yet run against your Google Sheet.** | `workflows/WF01-import-dedupe.json` |
| WF02–WF06 | Not started | — |

## 3. Inconsistencies found

| # | Inconsistency | Where | Resolution |
|---|---|---|---|
| 1 | The call length is "20-minute" in the offer but "15-minute" in the email skeleton and the niche `cta`. (Your brief says 15–20.) | `01` §5.1 vs §7, §8 | **Needs your decision.** I recommend 15 minutes, because a smaller ask is easier to accept. Not changed. |
| 2 | The Niches `active` column was required by §8's prose but missing from its field table. | `01` §8 | **Fixed.** Added to the table and to `sheets/Niches.csv`. |
| 3 | WF01 "reads an `Import` tab", but the Sheet schema never defined that tab. | `02` §3, §6 | **Fixed.** Added §3.6 with exact columns. The four status columns are new; no existing field was renamed. |
| 4 | Your Phase 2 request describes WF00 as "initialization or configuration", but the architecture defines WF00 as the **Error Handler**. | `02` §6 | **Followed the architecture.** Initialization is done by importing the CSV templates. If you want a workflow that creates the tabs automatically, that's a small addition. |
| 5 | WF01 rejects rows without `email_source_url`, yet WF02 has a hard gate for `channel_score = 0` (no email). That gate implies leads without an email could reach Leads. | `02` §5, §6 | WF01 follows its own spec: `contact_email` **and** `email_source_url` are required. Agencies with no published email stay in the research sheet. The WF02 gate stays as a second line of defence. **Please confirm.** |
| 6 | Compliance rule 4 requires "FlowHQ's legal name" in every email, but Settings has no legal-name key, and the §7 footer only says "FlowHQ · {website}". | `03` §2 vs `02` §3.1, `01` §7 | **Open, needed before Phase 4.** Proposal: add a `BUSINESS_LEGAL_NAME` Settings key. Not added yet, so the Settings schema still matches the architecture. |
| 7 | WF00 "emails FlowHQ", but no setting holds the alert address. | `02` §6 | **Resolved.** `alert_email` lives in WF00's Config node rather than in the Sheet, so an alert can still go out when Sheets is what failed. Documented in `02` §6. |
| 8 | "Every other workflow points to [WF00]", but n8n **does not run error workflows for manual executions**, and WF01 is manual. | `02` §6 | **Documented.** WF01 failures appear in the n8n editor. WF00 covers scheduled workflows (WF02 onwards). |
| 9 | "Instant acknowledgement" appears in the offer and the niche's `service_angle`, but Gmail/IMAP triggers poll the mailbox, typically every minute or more. | `01` §5.2, §7, §8 | **Flagged in `06-offer-review.md`.** Say "within minutes", not "instant". Wording not changed until you approve the offer. |
| 10 | Domain-level suppression applied literally would block a whole mail provider. For example, a bounce from an agency's `@btinternet.com` address would suppress every BT customer. | `02` §3.4, `03` rule 5 | **Fixed** in WF01 with a shared-provider exception, and documented in `02` §3.4. |
| 11 | The `Metrics` columns were described only in prose. | `02` §8 | Defined in `src/schema.js` using §8's wording. WF06 (Phase 6) will use them, so review them then. |

## 4. n8n setup assumptions to confirm

- **Your n8n version is unknown.** The workflows were import- and engine-tested on **n8n 2.42.6** (the latest stable release on npm today). The node versions used are Google Sheets 4.5, Code 2, Set 3.4, Gmail 2.1, Schedule Trigger 1.2, Error Trigger 1, and Manual Trigger 1. They should import on any recent 1.x or 2.x release. If yours is older and an import fails, tell me the version shown under **Help → About n8n**.
- The workflows don't use `$env`, n8n Variables (a paid feature), community nodes, or public webhooks. That's consistent with "no inbound internet exposure".
- Timestamps written by WF00 and WF01 are **UTC** (ISO 8601), regardless of `GENERIC_TIMEZONE`.
