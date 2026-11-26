-- 0030_property_page — the page of an own object (phase 36, ADR-0016 §9–12), step 2.
--
-- property_photos: up to 15 photos of an object, Telegram's ready size up to 1280 px, at most
--   400 KB each. The owner replaces them; they are not history, so no events.
-- property_funnel: append-only. The page (integration `site`) writes views and leads; the owner
--   writes calls, showings and deals. Every row carries the channel `?c=` and the material `?m=`.
-- property_contacts: the phone of a lead — personal data apart from the history: no events,
--   deleted for real when the object closes or is withdrawn, on request, after 180 days.

CREATE TABLE property_photos (
  property_id  uuid NOT NULL REFERENCES properties (id),
  position     integer NOT NULL CHECK (position BETWEEN 1 AND 15),
  content      bytea NOT NULL CHECK (octet_length(content) BETWEEN 100 AND 409600),
  width        integer NOT NULL CHECK (width BETWEEN 1 AND 1280),
  height       integer NOT NULL CHECK (height BETWEEN 1 AND 1280),
  added_at     timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, position)
);
COMMENT ON TABLE property_photos IS 'Photos of own objects (phase 36): JPEG, at most 15 × 400 KB.';

CREATE TABLE property_funnel (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     uuid NOT NULL REFERENCES properties (id),
  step            text NOT NULL CHECK (step IN ('view', 'lead', 'call', 'showing', 'deal')),
  channel         text NOT NULL
                    CHECK (channel IN ('olx', 'domria', 'fb', 'tg', 'viber', 'ig', 'tt', 'other')),
  material        text CHECK (material ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(material) <= 40),
  -- A call, showing or deal that followed a lead of the page.
  lead_id         bigint REFERENCES property_funnel (id),
  occurred_at     timestamptz(3) NOT NULL DEFAULT now(),
  actor_type      actor_type NOT NULL,
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT property_funnel_writer CHECK (
    (step IN ('view', 'lead') AND actor_type = 'integration' AND actor_id = 'site')
    OR (step IN ('call', 'showing', 'deal') AND actor_type = 'owner')
  ),
  CONSTRAINT property_funnel_lead_link CHECK (lead_id IS NULL OR step IN ('call', 'showing', 'deal'))
);
CREATE INDEX property_funnel_property_idx ON property_funnel (property_id, step);
CREATE INDEX property_funnel_leads_idx ON property_funnel (occurred_at) WHERE step = 'lead';
COMMENT ON TABLE property_funnel IS
  'Append-only funnel of own objects (phase 36): view, lead, call, showing, deal by channel and material.';

CREATE TRIGGER property_funnel_append_only BEFORE UPDATE OR DELETE
  ON property_funnel FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER property_funnel_no_truncate BEFORE TRUNCATE ON property_funnel
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE property_contacts (
  lead_id      bigint PRIMARY KEY REFERENCES property_funnel (id),
  property_id  uuid NOT NULL REFERENCES properties (id),
  phone        text NOT NULL CHECK (phone ~ '^\+[0-9]{10,15}$'),
  name         text CHECK (char_length(name) BETWEEN 1 AND 60),
  preferred    text NOT NULL CHECK (preferred IN ('call', 'telegram', 'viber')),
  consent_at   timestamptz(3) NOT NULL,
  created_at   timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX property_contacts_property_idx ON property_contacts (property_id);
CREATE INDEX property_contacts_phone_idx ON property_contacts (phone);
CREATE INDEX property_contacts_created_idx ON property_contacts (created_at);
COMMENT ON TABLE property_contacts IS
  'Phones of leads of own objects (phase 36): personal data, no events, deleted for real.';
