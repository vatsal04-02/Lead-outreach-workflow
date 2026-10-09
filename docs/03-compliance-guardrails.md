# Compliance guardrails (multi-country)

> **This is not legal advice.** It's a working summary for designing the system safely. Before live sending in **any** country, get a short review from someone qualified. The system enforces this: WF04 refuses live email for a campaign until its `outreach_basis_reviewed` is set to `TRUE`.

## 1. Country summary (B2B cold email)

| | UK | US | Canada | Australia | India | EU / EEA |
|---|---|---|---|---|---|---|
| Main rules | PECR + UK GDPR | CAN-SPAM | CASL | Spam Act 2003 | DPDP Act 2023 (personal data) + IT Act; no CAN-SPAM-style email statute | GDPR + national ePrivacy laws |
| Cold B2B email allowed? | Yes to **corporate subscribers** (Ltd, LLP, plc, public bodies); **not** to sole traders/partnerships without consent | Yes (opt-out model) | Only with consent; implied consent can apply to a **conspicuously published** business address, with no "no messages" statement, relevant to the role | Only with consent; inferred consent can apply to a conspicuously published business address, relevant to the role | Not specifically prohibited for email, but a named person's email is personal data under DPDP, so purpose, notice and data handling need review | **Varies by country** (e.g. Germany is very strict); always needs country-specific review |
| Sender identity | Required | Required, accurate headers, non-deceptive subject | Name + contact info | Required | Recommended | Required |
| Postal address | Recommended | **Required** | Required | Sender contact info | Recommended | Usually required |
| Opt-out | In every message | Works 30 days; honour ≤ 10 business days | Works 60 days; honour ≤ 10 business days | Functional; honour ≤ 5 business days | Honour promptly | Honour immediately |
| Before going live | Legitimate Interests Assessment; privacy notice link | — | Check the implied-consent conditions per lead | Check the inferred-consent conditions | Legal review of DPDP obligations | Legal review per country |

**Requires legal review before live sending:** every campaign (the default `outreach_basis_reviewed = FALSE`), and especially Canada, Australia, India, any EU country, and any campaign whose prospects are mostly individuals (sole traders, self-employed professionals). Where the basis is unclear, leave `outreach_basis_reviewed = FALSE`: test-mode sending still works, so drafts can be reviewed safely.

**Healthcare prospects:** outreach uses only the business's published contact details, never patient data. Delivering automation for healthcare clients later involves health-data law (HIPAA, UK GDPR special-category data, DPDP), which needs its own review and contracts.

## 2. FlowHQ rules (enforced by the system, wherever it can enforce them)

1. **Never invent or guess email addresses.** Imported leads need `contact_email` + `email_source_url` (WF01). For discovered leads, WF02 takes an address only from the business's own pages, on its own domain (or a shared mailbox it publishes there), and records the page. It never takes addresses from OpenStreetMap or the AI.
2. **UK legal basis (PECR).** For UK campaigns, a lead whose website doesn't state a Ltd/LLP/plc legal form goes to `Needs Review` (it may be a sole trader or partnership, who need prior consent). No company registry is queried: the legal form is what the business states publicly, and a human confirms it where needed.
3. **Respect "no solicitation" statements** on websites (hard gate).
4. **Every email contains:** the sender's name, FlowHQ's legal name, a postal address, the reason for contact, a simple opt-out ("reply unsubscribe") and the privacy notice link. WF03 and WF04 reject drafts that lack any of these.
5. **Honour opt-outs immediately.** WF05 suppresses the email and company domain the same day (while the laptop is on), which is well within every listed deadline. Suppression is permanent.
6. **One initial email per business.** No automated follow-ups.
7. **Accurate content.** No fake case studies, testimonials or statistics; numbers and quotes must come from stored evidence; subjects can't pose as replies; a human approves every email.
8. **No special-category data** is collected about prospects.
9. **Data minimisation and retention.** Only business contact data and public business facts are stored. Email addresses and phone numbers are redacted from text sent to the AI. Delete or anonymise leads that never replied after 12 months (manual). Keep Suppression indefinitely.
10. **No deceptive research.** WF02 only issues GET requests to public pages; it never submits forms or fake enquiries.
11. **Platform terms and robots.** Discovery uses OpenStreetMap open data (ODbL, attributed). WF02 honours robots.txt, fetches at most 3 pages per business with an identifying User-Agent, and never fetches social or directory profiles (Facebook, Instagram, LinkedIn, Yell, Justdial…). No scraping of Google Maps, property portals or LinkedIn; no bypassing CAPTCHAs, logins or paywalls.
12. **No evasion.** One sending identity, daily caps, no spam-filter tricks, no identity rotation, no leaked or bought lists.

## 3. Documents FlowHQ needs before live sending

- [ ] A short **privacy notice** (who FlowHQ is, what data is held, where it came from, why, how long it's kept, how to object, and a contact address), published at `PRIVACY_URL`.
- [ ] A **legal-basis review per campaign country**. Then set that campaign's `outreach_basis_reviewed = TRUE`. For the UK, this is a one-page Legitimate Interests Assessment.
- [ ] FlowHQ's **legal name and postal address** in Settings.

## 4. Where each rule is enforced

| Rule (§2) | Enforced by |
|---|---|
| 1. No guessed emails | WF01 required fields; WF02 `chooseContact` (own pages, own domain; third-party and AI-supplied addresses ignored). |
| 2. UK legal basis | WF02: UK campaigns without a stated corporate form → `Needs Review`. WF04: live sending needs `outreach_basis_reviewed = TRUE`. |
| 3. No-solicitation | WF02 deterministic detection, plus verified AI quotes → Disqualified. |
| 4. Footer contents | `src/lib/drafting.js` template footer; WF03 and WF04 refuse blank sender settings and edited footers. |
| 5. Opt-outs | WF05 keyword rules → Suppression first; every workflow checks Suppression (email + company domain). |
| 6. One email per business | WF04 Send_Log email/domain history and lock; no follow-up workflow. |
| 7. Accurate content | Banned-claims list, evidence-only numbers and quotes, human approval. |
| 9. Minimisation | Redaction before AI; reply text never sent to AI. |
| 10–11. Research conduct | WF02 robots.txt gate, page cap, profile-page skip, rate limits. |
