# Phase 1: Target niche, ideal customer profile, and offer

**Status:** Proposal. Waiting for FlowHQ sign-off. Nothing here has been tested with real prospects yet.

---

## 1. Assumptions (please confirm or correct)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | FlowHQ is based in India (budget given in ₹) and the team works roughly Indian daytime and evening hours. | It affects which countries' business hours overlap with yours, for both sending and sales calls. |
| A2 | FlowHQ has **no paying clients, case studies, or testimonials yet**. | The outreach must not imply experience you don't have. Credibility has to come from relevance, honesty, and a working demo. |
| A3 | FlowHQ can build n8n workflows that combine Gmail/IMAP, Google Sheets, webhooks/forms, HTTP APIs, and an LLM. | The offer only includes things in this list. |
| A4 | FlowHQ owns (or can get) a business domain and a mailbox on that domain. | Cold email from a free `@gmail.com` address looks less credible and puts deliverability at risk. **If you don't have a domain, this is the one place where ₹0 may not be realistic**, so please tell me. |
| A5 | FlowHQ has, or can publish, a website or page with its legal name, postal address, and a short privacy notice. | US law requires a postal address in commercial email, and UK GDPR expects people to be told where you got their data. See `03-compliance-guardrails.md`. |
| A6 | One person at FlowHQ can spend about 30–45 minutes on each sending day reviewing and approving drafts. | Every first email goes through manual approval, so that time is the real limit on volume. |
| A7 | Client automations will **not** run on FlowHQ's laptop. | An "instant enquiry response" service can't depend on a laptop that sleeps. Client workflows would run on infrastructure the client owns (see §5.4). |

---

## 2. Choosing the first niche

The brief lists five candidate segments across four countries. Testing all of them at once makes it impossible to tell why something worked or didn't. I scored each combination on what matters for a **brand-new agency with no case studies and a ₹0 budget**:

| Segment | Clear, provable pain FlowHQ can fix | Compliance burden for FlowHQ | Contact info publicly available | Likelihood they're already flooded with "AI agency" emails | Verdict |
|---|---|---|---|---|---|
| Physio and healthcare clinics | High (intake, booking, reminders) | **High.** The workflows touch patient health data (HIPAA in the US, special-category data under UK GDPR, health-records laws in Canada and Australia). In the US, FlowHQ would likely become a "business associate" needing a BAA, which free Google tools don't cover. | Medium | Medium | **Not first.** Revisit once FlowHQ has paid infrastructure and a compliance process. |
| Marketing agencies | Medium (reporting, client onboarding, lead routing) | Low | High | **Very high.** They're the most common target of automation-agency cold email, and many build their own automations. | **Good second test**, possibly as white-label *partners* rather than end clients. |
| Real estate agencies | **High.** A constant stream of enquiries from property portals and websites, viewing bookings, chasing applicants, and landlord updates. | Low to medium (enquirer data is ordinary personal data, not special category) | High (agencies publish office emails) | Medium | **Recommended first test.** |
| General SMB service businesses | Varies | Low | Varies | Medium | Too broad for a first test, because the messaging can't be specific. |

### Country for the first test

| Country | B2B cold email rule (summary, not legal advice) | Time zone overlap with India | Verdict |
|---|---|---|---|
| **UK** | Allowed to **corporate subscribers** (limited companies and LLPs) without prior consent, as long as you identify yourself and offer an opt-out (PECR + UK GDPR legitimate interests). Companies House offers a **free** public API to check whether a business is a limited company. | **Good.** UK business hours are about 13:30–22:30 IST. | **Recommended first.** |
| US | Opt-out model (CAN-SPAM). Requires a postal address and an opt-out. | **Poor.** US business hours are roughly evening to early morning IST. | Second option. |
| Canada | CASL is strict. Cold B2B email relies on narrow "implied consent" (an address that's conspicuously published, relevant to the person's role, and with no "no solicitation" statement). Penalties are large. | Poor | Later. |
| Australia | The Spam Act requires consent. It can be inferred from a conspicuously published business address under similar narrow conditions. | Good (AEST is about IST + 4.5h) | Later. |

### Recommendation: Test 1 = independent UK estate and letting agencies (limited companies)

**Why:**
1. **Concrete pain that n8n can actually solve.** Enquiries arrive by email from portals (Rightmove, Zoopla, OnTheMarket) and website forms. Each one needs a reply, logging, routing to a negotiator, and chasing. You can explain this in one sentence and demonstrate it in five minutes.
2. **The legal path is clear.** B2B email to limited companies is allowed under PECR with identification and an opt-out. Companies House lets us **verify** each prospect is a limited company for free, before we email them.
3. **Workable hours.** Sending and calls happen in your afternoon and evening, while your laptop is on.
4. **Contacts are public.** Agencies publish office and branch email addresses on their own websites. We never have to guess an email.

**Known risk (please read):** many UK agency CRMs (Reapit, Alto, Street, Jupix, and others) already import portal leads automatically, and some send auto-replies. FlowHQ's value is probably in the **gaps**: out-of-hours responses, chasing un-actioned enquiries, routing across branches, connecting tools the CRM doesn't connect, and simple response-time reporting. That's why the first email **asks a question** rather than claiming they have a problem. If the Phase 1 smoke test (§6) or early replies show the gap isn't real, the fallback angle within the same niche is **lettings admin** (triaging maintenance requests, renewal reminders, landlord updates).

**Test 2 (decide after Test 1 data):** either US independent brokerages (same offer, different compliance and hours) or UK marketing agencies (different offer, framed as a partnership).

---

## 3. Ideal Customer Profile, Test 1

| Attribute | Include | Exclude |
|---|---|---|
| Business type | Independent estate agent and/or letting agent | National chains and corporate-owned franchise branches (they have central procurement and IT) |
| Legal entity | **UK limited company or LLP**, verified on Companies House as "active" | Sole traders and partnerships (PECR treats them as individuals, so consent would be required), and dissolved companies |
| Size | Roughly 1–3 branches, about 3–25 staff (estimated from the team page) | Single-person operations with no enquiry volume |
| Digital presence | Own website with listings or an enquiry/valuation form, and listings on at least one portal | No website |
| Contact channel | An email address **published on the agency's own website** (role addresses like `info@` or `lettings@` are fine). A named person's email **only** if the company itself publishes it. | No published email, or a website that says it doesn't want unsolicited sales contact |
| Decision maker | Director/owner, branch manager, lettings manager, or office manager | Junior negotiators, as the primary target |

**Public "pain signals" we look for during research** (each one is recorded with its source URL):
- The contact page promises a reply "within 24 hours" or "during office hours", or the office is closed evenings and weekends.
- Viewings or valuations can only be booked by phone.
- Several branches share one generic inbox.
- They're hiring for administrators, lettings coordinators, or negotiators. That suggests admin load, but **not** a confirmed problem.
- Public reviews mention slow replies. Read these manually, quote them accurately, and use them carefully.

**Hard rule:** we **never** submit fake enquiries or "mystery shop" a prospect to test their response time. That would be deceptive, and it wastes their staff's time. We only use what's publicly visible.

---

## 4. Positioning (what FlowHQ says about itself)

> **FlowHQ builds small, reliable automations for estate and letting agents, so that enquiries get answered, logged, and followed up even when the office is busy or closed.**

Honesty rules for all outreach (later enforced in the draft checks):
- We don't claim past clients, results, case studies, percentages, or testimonials until they exist and the client has agreed to be referenced.
- We don't use invented statistics ("78% of leads go to the first responder…"). If a third-party statistic is ever used, it needs a citable source stored in the sheet.
- We describe **what the automation does** (the mechanism) and the **plausible benefit** ("so enquirers get a reply straight away"), not guaranteed outcomes ("double your instructions").
- It's fine to say we're new. Optional suggested line: *"We're a new agency, so we're offering our first few clients a reduced founding rate in exchange for honest feedback."*

---

## 5. Core offer

### 5.1 The entry offer (what the email asks for)
**A free 20-minute "enquiry workflow review" call.** We walk through how enquiries reach them today, identify one gap, and sketch the automation. There's no obligation.

### 5.2 The paid pilot (what we sell on the call)
**Enquiry Autopilot pilot:** one fixed-scope workflow, built in about 2–3 weeks.

| Included | Not included in the pilot |
|---|---|
| Read new enquiries from the agency's existing enquiry inbox (portal lead emails and website-form notifications). | Phone, SMS, or WhatsApp automation |
| Extract the enquirer's details and the property they asked about. | Voice AI / AI phone answering |
| Send an instant, agency-branded acknowledgement **from the agency's own mailbox**, using wording the agency approves. | CRM migration |
| Log every enquiry to a Google Sheet, or to their CRM **only if we confirm their CRM offers API access**. | **Any automated decision about applicants**, such as AI tenant screening or prioritising by personal characteristics, because of discrimination and fairness risk |
| Notify the right negotiator or branch. | Anything we haven't built and tested in our own demo first |
| A reminder if an enquiry hasn't been marked as handled within X hours. | |
| A simple weekly summary (enquiry count, how many were acknowledged, how many are still open). | |

### 5.3 Commercials (decision needed from FlowHQ)
- I recommend **one fixed pilot price**, so a reply asking "how much?" gets a straight answer, plus an **optional monthly support fee** after go-live.
- I haven't set the numbers, because I don't have reliable UK pricing data for this niche and don't want to invent it. **FlowHQ should decide the pilot price before Phase 5 (sending).**

### 5.4 Delivery prerequisites (to tell prospects honestly on the call)
- **Hosting:** the client's workflow runs 24/7 on infrastructure **the client owns** (for example, their own n8n Cloud account or a small VPS), and the client pays that cost directly. FlowHQ's laptop never hosts client production workflows. *Check the n8n Sustainable Use License terms before hosting any client workflow on an n8n instance FlowHQ operates.*
- **Data protection:** FlowHQ would be a **data processor** for the enquirers' personal data. Have a simple Data Processing Agreement ready before the first paid project.
- **Access:** OAuth access to the enquiry mailbox, granted by the client.

### 5.5 Proof without fake case studies
**Before the first email is sent (before Phase 5), build a working internal demo of the Enquiry Autopilot** using made-up test enquiries sent to a FlowHQ test inbox. A 3-minute screen recording of it working is honest proof that FlowHQ can deliver. Use it on calls, and optionally link it in the email.

---

## 6. Phase 1 validation: the niche smoke test (about 1 hour, manual, no tools)

Before we build anything, check the niche against reality:

1. Manually find **20 independent UK estate and letting agencies** (from Google searches or portal branch directories, browsing only with no scraping) in 2–3 towns of your choice.
2. For each one, note: the website, whether it publishes an email address (and where), whether it's a limited company (search on the Companies House website), and any public pain signal from §3.
3. Record these in a scratch spreadsheet. They become the **first test records for Phase 2**.

**Pass criteria (proposed):**
- At least **12 of 20** have a published business email **and** are limited companies.
- At least **8 of 20** show at least one genuine, citable pain signal.

If it fails, we switch to the lettings-admin angle or the Test 2 niche **before** building the pipeline.

---

## 7. Messaging angle for Test 1 (template skeleton, not final)

The final templates are produced in Phase 4. This shows the shape and tone. Every `{…}` must be filled from stored research, or the draft is rejected.

```
Subject: Enquiries at {agency_name}

Hi {first_name | "there"},

I was looking at {agency_name}'s {page_name} and noticed {specific_observation_with_source}.

FlowHQ builds small automations for estate and letting agents. For example: every portal or
website enquiry gets an immediate, personalised acknowledgement from your own inbox, is logged,
and is passed to the right negotiator, with a nudge if nobody has picked it up.

Is out-of-hours or busy-day enquiry follow-up something you've already got covered?
If not, I'd be happy to sketch what it could look like for {agency_name} on a free 15-minute call.

{sender_name}
FlowHQ · {website}
{business_postal_address}

You're receiving this because {agency_name}'s contact address is published on your website.
If you'd rather not hear from us, reply "unsubscribe" and we won't contact you again.
Privacy notice: {privacy_url}
```

Rules: under about 120 words in the body, one service only, one question as the CTA, no links except the website and privacy notice (fewer links helps deliverability), and no attachments.

---

## 8. Configurable niche definition

Each niche is one row in the `Niches` tab (see `02-mvp-architecture.md`). Only the niche named in `Settings.ACTIVE_NICHE` is processed. Test 1's row:

| Field | Value |
|---|---|
| `niche_id` | `uk-estate-letting` |
| `active` | `TRUE` |
| `country` | `UK` |
| `timezone` | `Europe/London` |
| `target_description` | Independent UK estate and letting agencies, limited companies, 1–3 branches |
| `decision_maker_roles` | Director; Owner; Branch Manager; Lettings Manager; Office Manager |
| `pain_signals` | 24h reply promise; phone-only viewings; office closed evenings/weekends; shared generic inbox; hiring admin staff; reviews citing slow replies |
| `service_angle` | Enquiry Autopilot: instant acknowledgement, logging, routing, and chasers for portal and website enquiries |
| `cta` | Free 15-minute enquiry workflow review |
| `exclusions` | National chains; corporate franchise branches; sole traders/partnerships; no published email; "no solicitation" notice |
| `legal_entity_required` | `limited_company_or_llp` |
| `template_id` | `uk-estate-letting-v1` |

Placeholder rows for `uk-marketing-agency`, `us-real-estate-brokerage`, and `uk-physio-clinic` can be added later with `active = FALSE`.

---

## 9. Decisions needed from FlowHQ before Phase 2

1. **Approve the Test 1 niche** (UK independent estate and letting agencies), or pick a different one.
2. **Sending identity:** do you own a domain with a mailbox (Google Workspace or other)? What address will send?
3. **Legal name and postal address** to show in every email.
4. **Privacy notice URL:** is there a FlowHQ website where this can live?
5. **Who approves drafts,** and who takes sales calls.
6. **Pilot price:** decide it now or before Phase 5.
7. **Run the smoke test** (§6) and share the results, or ask me to adjust the criteria.
