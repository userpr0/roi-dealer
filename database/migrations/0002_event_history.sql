-- 0002_event_history — append-only Event History, audit and idempotent commands (PHASE 03).
--
-- Every insert or update of an entity row must come with an event of the same version in the
-- same transaction (checked at COMMIT). Events are the audit trail: who, when, which version,
-- within which request (correlation_id). They are never rewritten or removed (§2.2).

-- ---------------------------------------------------------------- Events

CREATE TABLE events (
  position          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id                uuid PRIMARY KEY,
  type              text NOT NULL CHECK (type ~ '^[a-z_]+\.(created|updated)$'),
  aggregate_type    entity_type NOT NULL,
  aggregate_id      uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  occurred_at       timestamptz(3) NOT NULL,
  recorded_at       timestamptz(3) NOT NULL DEFAULT now(),
  actor_type        actor_type NOT NULL,
  actor_id          actor_id NOT NULL,
  correlation_id    text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  payload           jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- One event per version of an entity: the history has no gaps and no forks.
  CONSTRAINT events_aggregate_version_key UNIQUE (aggregate_type, aggregate_id, aggregate_version),
  CONSTRAINT events_type_matches_aggregate CHECK (
    split_part(type, '.', 1) = aggregate_type
    AND (split_part(type, '.', 2) = 'created') = (aggregate_version = 1))
);
CREATE INDEX events_occurred_at_idx ON events (occurred_at, position);
CREATE INDEX events_correlation_id_idx ON events (correlation_id) WHERE correlation_id IS NOT NULL;
COMMENT ON TABLE events IS 'Append-only history of every entity change (§2.2) and its audit trail.';

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- ---------------------------------------------------------------- No change without an event

-- Checked at COMMIT: the inserted or updated row has an event of the same version.
-- TG_ARGV[0] is the entity type; append-only tables have no version column (version 1).
CREATE FUNCTION require_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  entity_version integer := coalesce((to_jsonb(NEW) ->> 'version')::integer, 1);
  event_type text := TG_ARGV[0] || CASE WHEN TG_OP = 'INSERT' THEN '.created' ELSE '.updated' END;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM events
    WHERE aggregate_type = TG_ARGV[0]
      AND aggregate_id = NEW.id
      AND aggregate_version = entity_version
      AND type = event_type
  ) THEN
    RAISE EXCEPTION '% % of % version % has no event', TG_TABLE_NAME, TG_OP, NEW.id, entity_version
      USING ERRCODE = 'integrity_constraint_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = TG_TABLE_NAME || '_requires_event';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  entity record;
BEGIN
  FOR entity IN
    SELECT * FROM (VALUES
      ('sources', 'source', 'INSERT OR UPDATE'),
      ('evidence', 'evidence', 'INSERT'),
      ('signals', 'signal', 'INSERT OR UPDATE'),
      ('pains', 'pain', 'INSERT OR UPDATE'),
      ('opportunities', 'opportunity', 'INSERT OR UPDATE'),
      ('decisions', 'decision', 'INSERT'),
      ('approval_requests', 'approval_request', 'INSERT OR UPDATE'),
      ('hypotheses', 'hypothesis', 'INSERT OR UPDATE'),
      ('experiments', 'experiment', 'INSERT OR UPDATE'),
      ('cost_entries', 'cost_entry', 'INSERT'),
      ('contributions', 'contribution', 'INSERT OR UPDATE'),
      ('rewards', 'reward', 'INSERT OR UPDATE'),
      ('knowledge_assets', 'knowledge_asset', 'INSERT')
    ) AS entities (table_name, entity_type, operations)
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER %s ON %I DEFERRABLE INITIALLY DEFERRED '
      'FOR EACH ROW EXECUTE FUNCTION require_event(%L)',
      entity.table_name || '_requires_event', entity.operations, entity.table_name,
      entity.entity_type);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------- Idempotent commands

-- A command with an idempotency key runs at most once. The row is inserted first (a concurrent
-- duplicate waits on the key and then sees it), the result is stored before COMMIT.
CREATE TABLE idempotency_keys (
  key             text PRIMARY KEY CHECK (key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  command         text_100 NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  result          jsonb
);
COMMENT ON TABLE idempotency_keys IS 'Commands that must run at most once, with their stored result.';

-- The only allowed update stores the result, once.
CREATE FUNCTION guard_idempotency_result() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.result IS NOT NULL
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.command IS DISTINCT FROM OLD.command
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an idempotency key only stores its result once'
      USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'idempotency_keys_update_forbidden';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_keys_result_once BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION guard_idempotency_result();
