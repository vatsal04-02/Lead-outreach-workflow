# Niche smoke test: UK independent estate and letting agencies

**Status: NOT RUN. Zero of 20 agencies verified.** Re-checked on 2026-10-09: page fetching is still blocked in the build environment (`ENOTFOUND` for every site tried), so all 22 candidates remain `UNVERIFIED`. The smoke test has **not** passed or failed. No prospect in this repository has a verified legal form, a verified email address, or a verified observation.

## 1. Why I couldn't verify prospects

In this cloud session, every web page fetch failed with `ENOTFOUND`. That included a public company register, agency websites, Zoopla, Propertymark and gov.uk, because the environment's network policy blocks those hosts. Only a web *search* tool worked, and it returns summaries of search results, not the pages themselves. A search summary isn't acceptable evidence of legal form, a published email address, or an operational observation, so I didn't record any of those from it.

You can allow these hosts in the environment's network settings (session title bar → environment → Edit → Network access). Then I can do the verification in a later session. Otherwise, use the manual process below. It takes about 60–75 minutes.

## 2. What is prepared

| File | Contents |
|---|---|
| `research/smoke-test-template.csv` | A blank research sheet with one column for every required field. |
| `research/smoke-test-candidates.csv` | **22 candidate agency names** (Reading, Leicester, Norwich) taken from web-search summaries. Every row is `UNVERIFIED`, and only the name and town are filled in. Two agencies the search described as large multi-branch firms (Romans, with "over 30 branches", and Chancellors, with "branches across Berkshire and other counties") were left out because they fail the 1–3 branch ICP, but that's unverified too. |

Treat the candidate names as leads to check, not facts. Directory listings go out of date, and some of these firms may have closed, merged, or may not be limited companies.

## 3. Three kinds of evidence (kept separate)

| Column | What it means | What counts | What does **not** count |
|---|---|---|---|
| `evidence_exists` | The business is real and in the ICP. | A live agency website that states its legal form ("Ltd", "LLP" or a company number) and shows it trading | A directory listing alone |
| `evidence_opportunity` | Something public suggests a workflow FlowHQ could improve. | An exact quote and URL from the agency's own site, e.g. opening hours that close evenings and Sundays, "we aim to respond within 24 hours", "call to book a viewing", or one inbox shared across branches | Your guess that "they probably miss leads" |
| `evidence_buying_intent` | They're actively looking for a solution like this. | A job ad for a CRM/automation administrator, a public request for recommendations, a tender | Pain signals. These are an *opportunity*, not intent. **Expect "none" for almost every agency, and write "none".** |

## 4. Manual process (about 3 minutes per agency)

Work through `smoke-test-candidates.csv` (or your own finds), filling the template columns:

1. **Website.** Search for the agency's name and town. Confirm the site is the agency's own: the address and phone should match its portal listing. Fill in `website` and `discovery_source_url` (the page where you found the agency).
2. **Legal form.** Look in the website footer, terms or privacy page for the legal name and form, e.g. "Example Lettings Ltd, registered in England & Wales No. ########". Record:
   - `stated_legal_name` and `stated_company_number` (exactly as written; blank if not stated)
   - `stated_legal_form` (`Ltd`, `LLP`, `plc`, or blank)
   - `legal_form_source_url` (the page that states it)
   - `manual_register_check` (optional): if you choose to look the company up on a public register by hand, note what you saw and when. The system never does this and doesn't need it.

   If the site states no corporate form, record `EXCLUDED`, or mark it for a human decision, because it may be a sole trader or partnership (PECR, see `03-compliance-guardrails.md`). WF02 applies the same rule: such UK leads go to `Needs Review`.
3. **Size.** Count the branches on the site. More than 3, or a national chain or franchise, means `EXCLUDED`.
4. **Email.** Copy the address **exactly** as shown on the agency's own contact page or footer, and fill in `email_source_url`. If there's only a contact form, leave `public_email` blank. **Never** guess a pattern like `info@`.
5. **No-solicitation check.** If the site says something like "no unsolicited sales contact", set `no_solicitation_notice = Y` and record `EXCLUDED`.
6. **Observation.** Find one specific, quotable line that's relevant to enquiry handling, and record it with `observation_source_url` and `observation_signal_type` (one of the niche's `pain_signals`). Then write one sentence in `why_flowhq_relevant`. **Do not** submit test enquiries, phone the agency, or quote reviews you haven't read in full.
7. **Classify:**
   - `meets_email_and_ltd` = `Y` only if steps 2 and 4 are both satisfied.
   - `has_citable_signal` = `Y` only if step 6 has a quote and a URL.
   - `confidence`:
     - **High**: the website states the legal form and company number, the email is on the agency's own site, and there's a quoted signal.
     - **Medium**: the website states the legal form but no company number, or the signal is weak (opening hours alone).
     - **Low**: anything else.
   - `outcome`: `PASS` (meets email + limited company), `PASS+SIGNAL` (also has a citable signal), `EXCLUDED` (give a reason), or `UNVERIFIED`.

## 5. Scoring (thresholds from `01-strategy-icp-offer.md` §6)

| Criterion | Pass if | Result |
|---|---|---|
| Published business email **and** limited company | ≥ 12 of 20 | **Not measured** |
| At least one genuine, citable pain signal | ≥ 8 of 20 | **Not measured** |

If both pass, the niche goes ahead to Phase 3. If either fails, switch to the lettings-admin angle or the Test 2 niche **before** building research automation.

## 6. From research to the pipeline

Copy only `PASS` and `PASS+SIGNAL` rows into the Sheet's **Import** tab:

| Research column | Import column |
|---|---|
| `company_name` | `company_name` |
| `website` | `website` |
| `town` | `city` |
| `region` | `region` |
| `public_email` | `contact_email` |
| `email_source_url` | `email_source_url` |
| `discovery_source_url` | `discovery_source_url` |
| `researched_at` | `discovered_at` |
| (type `smoke-test`) | `discovery_source` |
| stated legal form and number + observation quote and URL | `notes` |

The Import tab has no legal-form columns. WF02 fills the Leads `company_number` and `legal_entity_type` when a researched page states them; both are always treated as unverified statements.

## 7. Using the pipeline once candidates are verified

After you've found an agency's own website and **published** email by hand (steps 1 and 4 above), you can import it with WF01. WF02 then reads the agency's own pages (honouring robots.txt) and captures quoted evidence automatically. No company registry is queried. It never invents a legal form, an email or a quote: any quote the AI returns is discarded unless it appears verbatim on the cited page. That makes WF02 a second check on your manual research, **not** a replacement for it. Evidence of *buying intent* is never inferred by any workflow.

