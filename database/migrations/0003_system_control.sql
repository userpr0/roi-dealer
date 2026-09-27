-- 0003_system_control — the automation kill switch (13b, D-002).
--
-- SystemControl is the 14th entity: a versioned switch of the whole system. The row of the
-- `automation` switch is created here, with its event, so every environment has exactly one.
-- Pausing is recorded here; every automation and automated spend checks it first (CLAUDE.md).

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control'
));

CREATE TABLE system_controls (
  id               uuid PRIMARY KEY,
  key              text NOT NULL UNIQUE CHECK (key IN ('automation')),
  status           text NOT NULL CHECK (status IN ('running', 'paused')),
  reason           text_500,
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT system_controls_updated_after_created CHECK (updated_at >= created_at),
  -- A paused switch always says why; a running one has no reason.
  CONSTRAINT system_controls_reason_matches_status CHECK ((reason IS NOT NULL) = (status = 'paused'))
);
COMMENT ON TABLE system_controls IS 'Switches of the whole system: the automation kill switch (D-002).';

CREATE TRIGGER system_controls_versioned_update BEFORE UPDATE ON system_controls
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_update();
CREATE TRIGGER system_controls_no_delete BEFORE DELETE ON system_controls
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER system_controls_no_truncate BEFORE TRUNCATE ON system_controls
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER system_controls_requires_event AFTER INSERT OR UPDATE ON system_controls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('system_control');

-- ---------------------------------------------------------------- The automation switch

-- Well-known ids (AUTOMATION_CONTROL_ID in @roi-dealer/domain); the snapshot is the entity
-- exactly as createSystemControl('automation', …) builds it.
DO $$
DECLARE
  created timestamptz(3) := date_trunc('milliseconds', now());
  created_iso text := to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  INSERT INTO system_controls (
    id, key, status, created_at, created_by_type, created_by_id, updated_at, version
  ) VALUES (
    '00000000-0000-7000-8000-000000000001', 'automation', 'running', created,
    'system', 'migration', created, 1
  );
  INSERT INTO events (
    id, type, aggregate_type, aggregate_id, aggregate_version, occurred_at,
    actor_type, actor_id, correlation_id, payload
  ) VALUES (
    '00000000-0000-7000-8000-000000000002', 'system_control.created', 'system_control',
    '00000000-0000-7000-8000-000000000001', 1, created, 'system', 'migration',
    'migration:0003_system_control',
    jsonb_build_object('snapshot', jsonb_build_object(
      'id', '00000000-0000-7000-8000-000000000001',
      'key', 'automation',
      'status', 'running',
      'createdAt', created_iso,
      'createdBy', jsonb_build_object('type', 'system', 'id', 'migration'),
      'updatedAt', created_iso,
      'version', 1))
  );
END;
$$;
