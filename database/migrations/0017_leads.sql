-- 0017_leads — CRM / Outcomes (PHASE 20, D-022): sign-ups from test pages and their contacts.
--
-- leads: a person who left their email on a released page with consent. Versioned with
-- events like the other entities — and without personal data. The owner moves it (contacted,
-- customer, lost) and records the customer's outcome.
-- lead_contacts: the email itself, apart from the history: no events, no versions, deleted for
-- real on a person's request or after the retention period. One email per experiment.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot', 'revenue_entry', 'media_asset', 'lead'
));

CREATE TABLE leads (
  id                 uuid PRIMARY KEY,
  experiment_id      uuid NOT NULL,
  hypothesis_id      uuid NOT NULL,
  opportunity_id     uuid NOT NULL REFERENCES opportunities (id),
  media_asset_id     uuid NOT NULL REFERENCES media_assets (id),
  channel            text_100 NOT NULL,
  utm_source         text_100,
  consent_at         timestamptz(3) NOT NULL,
  status             text NOT NULL CHECK (status IN ('new', 'contacted', 'customer', 'lost')),
  outcome            text CHECK (outcome IN ('achieved', 'partial', 'not_achieved')),
  outcome_at         timestamptz(3),
  contact_erased_at  timestamptz(3),
  created_at         timestamptz(3) NOT NULL,
  created_by_type    actor_type NOT NULL,
  created_by_id      actor_id NOT NULL,
  updated_at         timestamptz(3) NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  -- The lead belongs to the experiment's own hypothesis.
  CONSTRAINT leads_experiment_fkey FOREIGN KEY (experiment_id, hypothesis_id)
    REFERENCES experiments (id, hypothesis_id),
  CONSTRAINT leads_outcome_complete CHECK ((outcome IS NULL) = (outcome_at IS NULL)),
  CONSTRAINT leads_outcome_customer CHECK (outcome IS NULL OR status = 'customer'),
  CONSTRAINT leads_consent_before_created CHECK (consent_at <= created_at),
  CONSTRAINT leads_updated_after_created CHECK (updated_at >= created_at)
);
CREATE INDEX leads_experiment_idx ON leads (experiment_id, created_at);
CREATE INDEX leads_status_idx ON leads (status, updated_at);
COMMENT ON TABLE leads IS 'Sign-ups from test pages (PHASE 20), without personal data.';

CREATE TRIGGER leads_versioned_update BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_update();
CREATE TRIGGER leads_no_delete BEFORE DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER leads_no_truncate BEFORE TRUNCATE ON leads
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER leads_requires_event AFTER INSERT OR UPDATE ON leads
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('lead');

CREATE TABLE lead_contacts (
  lead_id        uuid PRIMARY KEY REFERENCES leads (id),
  experiment_id  uuid NOT NULL REFERENCES experiments (id),
  email          text NOT NULL CHECK (
    length(email) BETWEEN 6 AND 254 AND email = lower(email)
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  created_at     timestamptz(3) NOT NULL,
  CONSTRAINT lead_contacts_one_per_experiment UNIQUE (experiment_id, email)
);
COMMENT ON TABLE lead_contacts IS
  'Emails of leads (PHASE 20): personal data, kept apart from the history and deleted for real.';

-- An erased lead never gets its contact back.
CREATE FUNCTION lead_contacts_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM leads WHERE id = NEW.lead_id AND contact_erased_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the contact of this lead was erased'
      USING ERRCODE = 'check_violation', TABLE = 'lead_contacts',
            CONSTRAINT = 'lead_contacts_not_erased';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lead_contacts_not_erased BEFORE INSERT OR UPDATE ON lead_contacts
  FOR EACH ROW EXECUTE FUNCTION lead_contacts_check();
