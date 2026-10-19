-- 0015_media — Media Factory (PHASE 19a, D-022): the landing page of a test and its ad texts.
--
-- media_assets: a creative an agent wrote for an experiment, versioned like the other
-- entities; the owner approves or rejects it. The content is the checked structure as JSON
-- text (the domain schema validates it on read). One live asset (draft, approved, released)
-- per experiment. agent_work also records work on experiments and on rejected assets.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot', 'revenue_entry', 'media_asset'
));

CREATE TABLE media_assets (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('landing')),
  experiment_id    uuid NOT NULL REFERENCES experiments (id),
  hypothesis_id    uuid NOT NULL REFERENCES hypotheses (id),
  opportunity_id   uuid NOT NULL REFERENCES opportunities (id),
  content          text NOT NULL CHECK (
    length(content) <= 20000 AND jsonb_typeof(content::jsonb) = 'object'
  ),
  slug             text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  preview_token    text NOT NULL CHECK (preview_token ~ '^[A-Za-z0-9_-]{22,64}$'),
  status           text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'released', 'retired')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT media_assets_slug_key UNIQUE (slug),
  CONSTRAINT media_assets_preview_token_key UNIQUE (preview_token),
  CONSTRAINT media_assets_updated_after_created CHECK (updated_at >= created_at)
);
-- One live creative per experiment: a new draft only after the previous one was rejected.
CREATE UNIQUE INDEX media_assets_one_live ON media_assets (experiment_id)
  WHERE status IN ('draft', 'approved', 'released');
CREATE INDEX media_assets_status_idx ON media_assets (status, updated_at);
COMMENT ON TABLE media_assets IS 'Creatives of experiments (PHASE 19a): landing pages and ad texts.';

CREATE TRIGGER media_assets_versioned_update BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_update();
CREATE TRIGGER media_assets_no_delete BEFORE DELETE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER media_assets_no_truncate BEFORE TRUNCATE ON media_assets
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER media_assets_requires_event AFTER INSERT OR UPDATE ON media_assets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('media_asset');

-- The landing writer works on experiments (the first draft) and on rejected assets (a rewrite).
ALTER TABLE agent_work DROP CONSTRAINT agent_work_subject_type_check;
ALTER TABLE agent_work ADD CONSTRAINT agent_work_subject_type_check
  CHECK (subject_type IN ('pain', 'opportunity', 'experiment', 'media_asset'));
