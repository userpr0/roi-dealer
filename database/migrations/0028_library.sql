-- 0028_library — the library: vertical → project → topic (phase 35, ADR-0016).
--
-- library_verticals / library_projects / library_topics: the tree, versioned entities with
-- events. A name is unique inside its parent, whatever its case.
-- library_filings: an append-only journal "object → topic". The latest row of an object is
-- where it is now; the owner moves an object with a new row. Ids only, no texts.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot', 'revenue_entry', 'media_asset', 'lead',
  'checkout', 'library_vertical', 'library_project', 'library_topic'
));

CREATE TABLE library_verticals (
  id               uuid PRIMARY KEY,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60 AND name !~ '[/\n\r\t]'),
  status           text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL CHECK (created_by_type IN ('owner', 'agent', 'system')),
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT library_verticals_updated_after_created CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX library_verticals_name ON library_verticals (replace(lower(name), 'ё', 'е'));
COMMENT ON TABLE library_verticals IS 'The library: verticals (phase 35).';

CREATE TABLE library_projects (
  id               uuid PRIMARY KEY,
  vertical_id      uuid NOT NULL REFERENCES library_verticals (id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60 AND name !~ '[/\n\r\t]'),
  status           text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL CHECK (created_by_type IN ('owner', 'agent', 'system')),
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT library_projects_updated_after_created CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX library_projects_name
  ON library_projects (vertical_id, replace(lower(name), 'ё', 'е'));
COMMENT ON TABLE library_projects IS 'The library: projects of a vertical (phase 35).';

CREATE TABLE library_topics (
  id               uuid PRIMARY KEY,
  project_id       uuid NOT NULL REFERENCES library_projects (id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60 AND name !~ '[/\n\r\t]'),
  status           text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL CHECK (created_by_type IN ('owner', 'agent', 'system')),
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT library_topics_updated_after_created CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX library_topics_name
  ON library_topics (project_id, replace(lower(name), 'ё', 'е'));
COMMENT ON TABLE library_topics IS 'The library: topics of a project (phase 35).';

DO $$
DECLARE
  entity record;
BEGIN
  FOR entity IN
    SELECT * FROM (VALUES
      ('library_verticals', 'library_vertical'),
      ('library_projects', 'library_project'),
      ('library_topics', 'library_topic')
    ) AS entities (table_name, entity_type)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_versioned_update()',
      entity.table_name || '_versioned_update', entity.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_change()',
      entity.table_name || '_no_delete', entity.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_change()',
      entity.table_name || '_no_truncate', entity.table_name);
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED '
      'FOR EACH ROW EXECUTE FUNCTION require_event(%L)',
      entity.table_name || '_requires_event', entity.table_name, entity.entity_type);
  END LOOP;
END;
$$;

CREATE TABLE library_filings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filed_at        timestamptz(3) NOT NULL DEFAULT now(),
  -- The object filed; polymorphic, so no foreign key (like agent_work.subject).
  object_type     text NOT NULL CHECK (object_type IN ('pain', 'opportunity')),
  object_id       uuid NOT NULL,
  topic_id        uuid NOT NULL REFERENCES library_topics (id),
  -- The librarian agent and code file; the owner moves.
  actor_type      actor_type NOT NULL CHECK (actor_type IN ('owner', 'agent', 'system')),
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);
CREATE INDEX library_filings_object_idx ON library_filings (object_type, object_id, id DESC);
CREATE INDEX library_filings_topic_idx ON library_filings (topic_id);
CREATE INDEX library_filings_filed_at_idx ON library_filings (filed_at);
COMMENT ON TABLE library_filings IS
  'Append-only journal: which topic an object is filed under; the latest row counts (phase 35).';

CREATE TRIGGER library_filings_append_only BEFORE UPDATE OR DELETE
  ON library_filings FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER library_filings_no_truncate BEFORE TRUNCATE ON library_filings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
