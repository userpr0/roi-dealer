-- 0027_audience — own audience (phase 28, ADR-0013): people who ticked a separate box on a
-- test page to get emails about its topic.
--
-- audience_contacts: personal data like lead_contacts — no events, no versions, deleted for
-- real. One row per email and opportunity (the topic). `confirmed_at` stays empty until the
-- double opt-in email can be sent: the email service is a separate ADR.

CREATE TABLE audience_contacts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities (id),
  experiment_id  uuid NOT NULL REFERENCES experiments (id),
  email          text NOT NULL CHECK (
    length(email) BETWEEN 6 AND 254 AND email = lower(email)
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  consent_at     timestamptz(3) NOT NULL,
  confirmed_at   timestamptz(3),
  CONSTRAINT audience_contacts_one_per_topic UNIQUE (opportunity_id, email)
);
CREATE INDEX audience_contacts_email_idx ON audience_contacts (email);
COMMENT ON TABLE audience_contacts IS
  'Own audience (phase 28): emails with a separate consent to topic emails; deleted for real.';
