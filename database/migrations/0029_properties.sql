-- 0029_properties — the owner's own real estate (phase 36, ADR-0016 part 2), step 1.
--
-- properties: a versioned entity with events. Only the owner adds and changes an object
-- (domain); the page of a listed object is public, so the database keeps the same limits as the
-- domain: no house number column, prices in USD cents (D-005).
-- library_filings: objects are filed in the library too («Недвижимость › населённый пункт › объект»).

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot', 'revenue_entry', 'media_asset', 'lead',
  'checkout', 'library_vertical', 'library_project', 'library_topic', 'property'
));

CREATE TABLE properties (
  id                 uuid PRIMARY KEY,
  slug               text NOT NULL UNIQUE
                       CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 60),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  kind               text NOT NULL CHECK (kind IN ('apartment', 'house', 'commercial', 'land')),
  deal               text NOT NULL CHECK (deal IN ('sale', 'rent')),
  region             text NOT NULL CHECK (char_length(region) BETWEEN 1 AND 60),
  settlement         text NOT NULL CHECK (char_length(settlement) BETWEEN 1 AND 60),
  street             text CHECK (char_length(street) BETWEEN 1 AND 80),
  area_m2            double precision NOT NULL CHECK (area_m2 > 0 AND area_m2 <= 1000000),
  rooms              integer CHECK (rooms BETWEEN 0 AND 100),
  floor              integer CHECK (floor BETWEEN -5 AND 200),
  floors             integer CHECK (floors BETWEEN 1 AND 200),
  land_sotky         double precision CHECK (land_sotky > 0 AND land_sotky <= 100000),
  separate_entrance  boolean,
  price_cents        integer NOT NULL CHECK (price_cents > 0),
  negotiable         boolean NOT NULL,
  condition          text CHECK (char_length(condition) BETWEEN 1 AND 500),
  utilities          text CHECK (char_length(utilities) BETWEEN 1 AND 500),
  rent_terms         text CHECK (char_length(rent_terms) BETWEEN 1 AND 500),
  purpose            text CHECK (char_length(purpose) BETWEEN 1 AND 500),
  nearby             text CHECK (char_length(nearby) BETWEEN 1 AND 500),
  offer              text CHECK (char_length(offer) BETWEEN 1 AND 500),
  cons               text CHECK (char_length(cons) BETWEEN 1 AND 500),
  status             text NOT NULL
                       CHECK (status IN ('draft', 'listed', 'under_offer', 'closed', 'withdrawn')),
  created_at         timestamptz(3) NOT NULL,
  created_by_type    actor_type NOT NULL CHECK (created_by_type = 'owner'),
  created_by_id      actor_id NOT NULL,
  updated_at         timestamptz(3) NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  CONSTRAINT properties_updated_after_created CHECK (updated_at >= created_at),
  CONSTRAINT properties_floor_within_floors CHECK (floor IS NULL OR floors IS NULL OR floor <= floors),
  CONSTRAINT properties_rent_terms_only_for_rent CHECK (deal = 'rent' OR rent_terms IS NULL)
);
CREATE INDEX properties_status_idx ON properties (status, updated_at);
COMMENT ON TABLE properties IS 'The owner''s own real estate (phase 36, ADR-0016).';

CREATE TRIGGER properties_versioned_update BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_update();
CREATE TRIGGER properties_no_delete BEFORE DELETE ON properties
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER properties_no_truncate BEFORE TRUNCATE ON properties
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER properties_requires_event AFTER INSERT OR UPDATE ON properties
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_event('property');

ALTER TABLE library_filings DROP CONSTRAINT library_filings_object_type_check;
ALTER TABLE library_filings ADD CONSTRAINT library_filings_object_type_check
  CHECK (object_type IN ('pain', 'opportunity', 'property'));
