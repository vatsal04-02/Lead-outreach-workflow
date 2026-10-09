# Niche smoke test: UK independent estate and letting agencies

**Status: NOT RUN. Zero of 20 agencies verified.** The smoke test has **not** passed or failed. No prospect in this repository has verified company status, a verified email address, or a verified observation.

## 1. Why I couldn't verify prospects

In this cloud session, every web page fetch failed with `ENOTFOUND`. That included Companies House (`find-and-update.company-information.service.gov.uk`), agency websites, Zoopla, Propertymark and gov.uk, because the environment's network policy blocks those hosts. Only a web *search* tool worked, and it returns summaries of search results, not the pages themselves. A search summary isn't acceptable evidence of company status, a published email address, or an operational observation, so I didn't record any of those from it.

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
| `evidence_exists` | The business is real and in the ICP. | A Companies House page showing **Active**, plus the company type, plus a live agency website | A directory listing alone |
| `evidence_opportunity` | Something public suggests a workflow FlowHQ could improve. | An exact quote and URL from the agency's own site, e.g. opening hours that close evenings and Sundays, "we aim to respond within 24 hours", "call to book a viewing", or one inbox shared across branches | Your guess that "they probably miss leads" |
| `evidence_buying_intent` | They're actively looking for a solution like this. | A job ad for a CRM/automation administrator, a public request for recommendations, a tender | Pain signals. These are an *opportunity*, not intent. **Expect "none" for almost every agency, and write "none".** |

## 4. Manual process (about 3 minutes per agency)

Work through `smoke-test-candidates.csv` (or your own finds), filling the template columns:

1. **Website.** Search for the agency's name and town. Confirm the site is the agency's own: the address and phone should match its portal listing. Fill in `website` and `discovery_source_url` (the page where you found the agency).
2. **Company status.** Look in the website footer or terms page for "Registered in England & Wales No. ########". Search that number, or the name, on [Companies House](https://find-and-update.company-information.service.gov.uk/). Record:
   - `ch_company_name` and `ch_company_number`
   - `ch_company_type` (it must be *Private limited company* or *Limited liability partnership*)
   - `ch_status` (it must be *Active*)
   - `ch_source_url` (the company's Companies House page)

   If you can't match a company, record `EXCLUDED`, because it may be a sole trader or partnership (PECR, see `03-compliance-guardrails.md`).
3. **Size.** Count the branches on the site. More than 3, or a national chain or franchise, means `EXCLUDED`.
4. **Email.** Copy the address **exactly** as shown on the agency's own contact page or footer, and fill in `email_source_url`. If there's only a contact form, leave `public_email` blank. **Never** guess a pattern like `info@`.
5. **No-solicitation check.** If the site says something like "no unsolicited sales contact", set `no_solicitation_notice = Y` and record `EXCLUDED`.
6. **Observation.** Find one specific, quotable line that's relevant to enquiry handling, and record it with `observation_source_url` and `observation_signal_type` (one of the niche's `pain_signals`). Then write one sentence in `why_flowhq_relevant`. **Do not** submit test enquiries, phone the agency, or quote reviews you haven't read in full.
7. **Classify:**
   - `meets_email_and_ltd` = `Y` only if steps 2 and 4 are both satisfied.
   - `has_citable_signal` = `Y` only if step 6 has a quote and a URL.
   - `confidence`:
     - **High**: the Companies House record is matched by company number, the email is on the agency's own site, and there's a quoted signal.
     - **Medium**: the Companies House record is matched by name and address only, or the signal is weak (opening hours alone).
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
| Companies House number + observation quote | `notes` |

The Companies House fields (`company_number`, `company_status`, `legal_entity_type`) are filled by WF02 (Phase 3) via the official API, per the architecture. For now, keep them in the research sheet.
