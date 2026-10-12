-- 0004_identity_access — identities, access grants and the access log (PHASE 04).
--
-- Members, agents and integrations act only through a registered identity (principal) that the
-- owner has granted. Roles and permissions live in @roi-dealer/policies; the database is the last
-- line of defence: no event (and so no write) by such an actor without an active principal.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal'
));

-- A new kind of human gate: access for an agent, integration or team member.
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check CHECK (kind IN (
  'spend', 'recurring_payment', 'payout', 'asset_purchase', 'experiment_launch',
  'opportunity_decision', 'production_change', 'legal', 'secret_access', 'policy_change',
  'budget_change', 'access_grant'
));

-- ---------------------------------------------------------------- Principals

CREATE TABLE principals (
  id               uuid PRIMARY KEY,
  actor_type       text NOT NULL CHECK (actor_type IN ('member', 'agent', 'integration')),
  actor_id         actor_id NOT NULL,
  display_name     text_100 NOT NULL,
  purpose          text_500 NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  -- One identity per actor, forever: a revoked actor id is not reused.
  CONSTRAINT principals_actor_key UNIQUE (actor_type, actor_id),
  CONSTRAINT principals_updated_after_created CHECK (updated_at >= created_at)
);
COMMENT ON TABLE principals IS 'Registered identities of members, agents and integrations (PHASE 04).';

-- The identity a grant was given to never changes, and revocation is final.
CREATE FUNCTION guard_principal_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.actor_type IS DISTINCT FROM OLD.actor_type OR NEW.actor_id IS DISTINCT FROM OLD.actor_id THEN
    RAISE EXCEPTION 'the actor of a principal is immutable'
      USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'principals_actor_immutable';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'a revoked principal cannot change'
      USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'principals_revoked_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER principals_versioned_update BEFORE UPDATE ON principals
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_update();
CREATE TRIGGER principals_identity_guard BEFORE UPDATE ON principals
  FOR EACH ROW EXECUTE FUNCTION guard_principal_update();
CREATE TRIGGER principals_no_delete BEFORE DELETE ON principals
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER principals_no_truncate BEFORE TRUNCATE ON principals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER principals_requires_event AFTER INSERT OR UPDATE ON principals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('principal');

-- ---------------------------------------------------------------- No write without access

-- Every change is an event (0002), so this covers every write: a member, agent or integration
-- without an active principal cannot change anything.
CREATE FUNCTION require_active_principal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.actor_type IN ('member', 'agent', 'integration') AND NOT EXISTS (
    SELECT 1 FROM principals
    WHERE actor_type = NEW.actor_type AND actor_id = NEW.actor_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION '% % has no active principal', NEW.actor_type, NEW.actor_id
      USING ERRCODE = 'insufficient_privilege', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'events_actor_principal_active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_actor_principal_active BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION require_active_principal();

-- ---------------------------------------------------------------- Access log

-- Views of the command center and every refused attempt (§2.11 audit logs). Not an entity:
-- like events, a log that is only appended to.
CREATE TABLE access_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz(3) NOT NULL DEFAULT now(),
  channel         text NOT NULL CHECK (channel IN ('telegram', 'database')),
  -- NULL for an unknown sender, identified only by actor_id (e.g. telegram:<id>).
  actor_type      actor_type,
  actor_id        actor_id NOT NULL,
  permission      text NOT NULL CHECK (permission ~ '^[a-z_]{1,32}\.[a-z_]{1,32}$'),
  decision        text NOT NULL CHECK (decision IN ('allowed', 'denied')),
  reason          text CHECK (reason ~ '^[a-z_]{1,64}$'),
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT access_log_reason_for_denials CHECK ((reason IS NOT NULL) = (decision = 'denied'))
);
CREATE INDEX access_log_occurred_at_idx ON access_log (occurred_at);
CREATE INDEX access_log_denied_idx ON access_log (occurred_at) WHERE decision = 'denied';
COMMENT ON TABLE access_log IS 'Append-only audit of views and refused access attempts (PHASE 04).';

CREATE TRIGGER access_log_append_only BEFORE UPDATE OR DELETE ON access_log
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER access_log_no_truncate BEFORE TRUNCATE ON access_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
