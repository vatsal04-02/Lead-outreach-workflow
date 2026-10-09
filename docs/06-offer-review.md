# Offer review: Enquiry Autopilot pilot

**Status:** This review was written before any prospect conversation. Every judgement below still has to be checked on real discovery calls.

## 1. Is the offer specific enough?

| Strength | Weakness |
|---|---|
| It names one concrete workflow (portal and website enquiries) and the mechanism (acknowledge → log → route → chase → summarise). | The pain is **assumed, not shown.** Many agencies' CRMs already import portal leads, and some already send auto-replies. "We automate enquiries" may sound like something they already have. |
| The free review call is low-risk to accept. | "Workflow review" is vague. It doesn't say what the agency walks away with. |
| It avoids AI hype and fake results. | It doesn't separate **sales** (vendor valuations, buyer enquiries) from **lettings** (applicant volume, viewings), and those have different pain. |

**Recommendations:**
1. **Lead with the gap, framed as a question:** "What happens to a Rightmove enquiry that arrives at 7pm on a Saturday?" Don't lead with the product.
2. **Make the free call deliver something tangible.** Within 48 hours, send a one-page *enquiry flow map*: how enquiries arrive today, where they wait, and the one automation we'd build first. It's useful even if they never buy, and it's honest proof of competence.
3. **Pick sales or lettings per prospect,** based on the research observation (for example, a lettings-heavy site gets the lettings angle).
4. **Say "within minutes", not "instant".** See §2.1.

## 2. Can the pilot actually deliver each component?

| Component | Feasible? | How | Dependencies and risks |
|---|---|---|---|
| **2.1 Acknowledge** incoming enquiries | **Yes, with conditions** | n8n Gmail Trigger (Google Workspace), Microsoft Outlook Trigger (Microsoft 365), or IMAP Email Trigger, then reply from the agency's mailbox. | **The triggers poll**, typically every minute, so the reply takes minutes, not seconds. Portal lead-email formats are unverified: we need 5–10 real samples from the client to check that the enquirer's email address is actually in the message, and formats can change without notice. Agency approval of the wording is needed. **Risk of a double reply** if the CRM or portal already auto-responds, so check this on the call. Microsoft 365 needs an Azure app registration, which the client's admin must approve. |
| **2.2 Log** enquiries | **Yes** to a Google Sheet. **Only if their CRM has an accessible API** for CRM logging. | Google Sheets node or HTTP Request node | CRM API access varies. Some offer partner or marketplace programmes with approval steps or fees. **Don't promise CRM integration until you've checked their specific CRM's API docs and access terms.** Also watch for duplicate records if the CRM already ingests portal leads. |
| **2.3 Route** and notify staff | **Yes** | Rules (branch, postcode, sales vs lettings, property reference), then an email notification. Slack or Teams if they use them. | The client must provide a routing table and keep it current. SMS and WhatsApp cost money (client-paid) and are out of pilot scope. |
| **2.4 Escalate** when nobody picks up | **Feasible, but the hardest part** | A scheduled check for enquiries not marked "handled" after X hours, then a reminder to the manager. | **"Handled" needs a reliable signal.** Options: (a) staff click a "done" link, which needs a webhook reachable from the internet and therefore the client's hosted n8n; (b) we detect a reply in the same mailbox thread, which fails if staff phone the enquirer or reply from the CRM; (c) a status column in the log sheet, which staff must remember to update. Agree the definition up front, or false escalations will annoy staff and the pilot will be judged a failure. |
| **2.5 Weekly summary** | **Yes** | A scheduled workflow that reads the log and sends an email. | Counts (received, acknowledged, marked handled, still open) are reliable. **Response-time figures are only as good as the "handled" signal in 2.4.** Don't present them as precise without that. |

**Cross-cutting dependencies:**
- **Hosting.** The client's workflow must run 24/7 on infrastructure the client owns: their own n8n Cloud subscription (cost to the client) or a VPS someone maintains. Check the n8n Sustainable Use License before FlowHQ operates any instance on a client's behalf.
- **Access.** OAuth consent to the enquiry mailbox, granted by the client's account owner or admin.
- **Data protection.** Enquirers' personal data passes through the workflow. The agency is the controller and FlowHQ is the processor, so you need a Data Processing Agreement before go-live. The agency's privacy notice must cover automated acknowledgements.
- **Fair treatment.** No automated decisions about applicants, such as ranking, screening, or filtering by personal characteristics. This is already excluded in the strategy.
- **Proof.** The internal demo (`01` §5.5) must exist before outreach, because it's the only evidence FlowHQ can deliver.

## 3. Claims that need evidence before use

| Claim (where it appears) | Status | Action |
|---|---|---|
| "Instant acknowledgement" (`01` §5.2, §7, §8) | **Overstated** (polling) | Change to "within minutes" before Phase 4 templates. |
| "Many UK agency CRMs already import portal leads" (`01` §2) | My assumption, unverified | Ask on each discovery call: "Which CRM do you use, and do portal leads land in it automatically?" |
| Portal lead emails contain the enquirer's contact details | Unverified | Get sample emails from the first prospect who agrees to a pilot. |
| A faster response wins more instructions or lets | **No source in this repo** | Don't use this, or any statistic, unless you can cite it with a source stored in the sheet. |
| FlowHQ can build and support this | Unproven until the demo exists | Build the demo (`01` §5.5) before Phase 5. |

Nothing in the offer promises outcomes (more instructions, more revenue), and it must stay that way.

## 4. Pricing validation (no price is set here)

Don't pick a price from guesses. Use the first conversations to collect evidence:

1. **Cost floor (FlowHQ-internal).** Estimate the build hours for the pilot scope after building the demo, and multiply by the minimum internal day rate FlowHQ will accept. List the client's hosting cost **separately**, because the client pays it directly.
2. **Value questions on every discovery call,** recorded in the Leads `notes` column:
   - Enquiries per week, and what share arrive out of hours.
   - Who handles them today, and how much time it takes.
   - Which tools they pay for already (CRM, portal packages, answering service, virtual assistant) and roughly what. Only record what they volunteer.
3. **Public price anchors.** Manually collect the published prices of alternatives they could buy instead (answering services, CRM add-ons, virtual assistants). Record the source URL and date for each. I couldn't do this here because page fetching is blocked.
4. **Test a price range** from about the third call onward. Name a fixed pilot price range and record the reaction: "too cheap to be credible", "reasonable", "expensive but worth considering", or "too expensive". Don't negotiate during this phase, just record.
5. **Decide after at least 5 data points.** Set one fixed pilot price above the cost floor and inside the range most prospects called reasonable. Revisit it after the first 3 pilots. An honest founding-client discount is fine; fake "normally £X" anchors are not.
