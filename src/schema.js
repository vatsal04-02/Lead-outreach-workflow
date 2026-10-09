'use strict';

// Canonical Google Sheet schema. Column names and order come from
// docs/02-mvp-architecture.md §3. `npm run build` writes sheets/*.csv from this
// file and the tests check both against the architecture doc, so a rename here
// fails CI instead of silently drifting.

const TABS = {
  Settings: ['key', 'value', 'notes'],

  // Fields from docs/01-strategy-icp-offer.md §8.
  Niches: [
    'niche_id',
    'active',
    'country',
    'timezone',
    'target_description',
    'decision_maker_roles',
    'pain_signals',
    'service_angle',
    'cta',
    'exclusions',
    'legal_entity_required',
    'template_id',
  ],

  // docs/02-mvp-architecture.md §3.6: the Leads columns a human fills in,
  // followed by four status columns that WF01 writes back.
  Import: [
    'company_name',
    'website',
    'city',
    'region',
    'contact_name',
    'contact_role',
    'contact_email',
    'email_source_url',
    'phone',
    'discovery_source',
    'discovery_source_url',
    'discovered_at',
    'notes',
    'import_status',
    'import_message',
    'lead_id',
    'processed_at',
  ],

  Leads: [
    'lead_id',
    'niche_id',
    'country',
    'company_name',
    'website',
    'city',
    'region',
    'contact_name',
    'contact_role',
    'contact_email',
    'email_source_url',
    'phone',
    'discovery_source',
    'discovery_source_url',
    'discovered_at',
    'company_number',
    'company_status',
    'legal_entity_type',
    'stage',
    'fit_score',
    'problem_score',
    'contact_score',
    'channel_score',
    'total_score',
    'score_override',
    'qualification_reasoning',
    'evidence',
    'opportunity_hypothesis',
    'disqualify_reason',
    'template_id',
    'email_subject',
    'email_body',
    'draft_generated_at',
    'draft_check_result',
    'approval_status',
    'approved_by',
    'approved_at',
    'send_status',
    'sent_at',
    'gmail_message_id',
    'gmail_thread_id',
    'reply_status',
    'reply_received_at',
    'reply_category',
    'next_action',
    'next_action_due',
    'notes',
    'last_updated',
    'last_error',
  ],

  Suppression: ['email', 'domain', 'reason', 'source', 'added_at'],

  Send_Log: [
    'lead_id',
    'to_email',
    'subject',
    'attempted_at',
    'status',
    'gmail_message_id',
    'gmail_thread_id',
    'test_mode',
    'error',
  ],

  Errors: ['timestamp', 'workflow', 'node', 'lead_id', 'message'],

  // §8 lists these metrics in prose; Phase 6 (WF06) writes them.
  Metrics: [
    'date',
    'new_leads',
    'qualified',
    'qualification_rate',
    'drafts_approved',
    'drafts_rejected',
    'emails_sent',
    'bounces',
    'bounce_rate',
    'unsubscribes',
    'replies',
    'positive_replies',
    'meetings_booked',
    'proposals_sent',
    'clients_won',
    'won_value',
  ],
};

// Settings rows exactly as listed in docs/02-mvp-architecture.md §3.1.
// Values left blank must be filled in by FlowHQ before the phase that uses them.
const SETTINGS_ROWS = [
  ['SENDING_ENABLED', 'FALSE', 'Global kill switch. Anything other than exactly TRUE means no sending.'],
  ['TEST_MODE', 'TRUE', 'While TRUE every send goes to TEST_RECIPIENT with a [TEST] subject prefix.'],
  ['TEST_RECIPIENT', '', 'A FlowHQ inbox for test sends.'],
  ['DAILY_SEND_LIMIT', '10', 'Maximum initial emails per day. Raise slowly.'],
  ['MIN_MINUTES_BETWEEN_SENDS', '8', 'Spacing between sends.'],
  ['SEND_DAYS', 'Mon,Tue,Wed,Thu', 'Days on which sending is allowed.'],
  ['SEND_WINDOW_START', '09:30', "Recipient's time zone (from the niche)."],
  ['SEND_WINDOW_END', '16:00', "Recipient's time zone (from the niche)."],
  ['ACTIVE_NICHE', 'uk-estate-letting', 'The only niche processed. Must match an active Niches row.'],
  ['MIN_QUALIFY_SCORE', '60', 'Starting threshold; tune after seeing real scores.'],
  ['RESEARCH_BATCH_SIZE', '5', 'Leads researched per run (free-tier AI limits).'],
  ['SENDER_NAME', '', 'Shown in the email.'],
  ['SENDER_EMAIL', '', 'Shown in the email.'],
  ['BUSINESS_POSTAL_ADDRESS', '', 'Required in the email footer.'],
  ['PRIVACY_URL', '', 'Shown in the email footer.'],
  ['WEBSITE_URL', '', 'Shown in the email footer.'],
  // Added in Phase 3-7 (rows appended, no column changes): see docs/02 §3.1.
  ['BUSINESS_LEGAL_NAME', '', "FlowHQ's registered legal name, required in every email footer (compliance rule 4)."],
  ['LIVE_RECIPIENT_ALLOWLIST', '', 'Optional. When set, live sends go ONLY to these comma-separated addresses (Phase 7 testing). Clear it to go live.'],
];

// Test 1 niche, from docs/01-strategy-icp-offer.md §8.
const NICHE_ROWS = [
  {
    niche_id: 'uk-estate-letting',
    active: 'TRUE',
    country: 'UK',
    timezone: 'Europe/London',
    target_description: 'Independent UK estate and letting agencies, limited companies, 1–3 branches',
    decision_maker_roles: 'Director; Owner; Branch Manager; Lettings Manager; Office Manager',
    pain_signals:
      '24h reply promise; phone-only viewings; office closed evenings/weekends; shared generic inbox; hiring admin staff; reviews citing slow replies',
    service_angle:
      'Enquiry Autopilot: instant acknowledgement, logging, routing, and chasers for portal and website enquiries',
    cta: 'Free 15-minute enquiry workflow review',
    exclusions:
      'National chains; corporate franchise branches; sole traders/partnerships; no published email; "no solicitation" notice',
    legal_entity_required: 'limited_company_or_llp',
    template_id: 'uk-estate-letting-v1',
  },
];

module.exports = { TABS, SETTINGS_ROWS, NICHE_ROWS };
