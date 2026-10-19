-- 0005_evidence_engine — catalog-bound sources, loads (snapshots) and Evidence provenance (PHASE 05).
--
-- A source is connected by a catalog entry (@roi-dealer/evidence) whose terms were checked; every
-- load leaves an immutable snapshot record (hash, time, request) without the raw response; Evidence
-- points to the load it came from and never stores contact data.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot'
));

-- ---------------------------------------------------------------- Sources by catalog entry

ALTER TABLE sources
  ADD COLUMN catalog_key text CONSTRAINT sources_catalog_key_format
    CHECK (catalog_key ~ '^[a-z0-9][a-z0-9-]{1,39}$');
-- One source per catalog entry.
CREATE UNIQUE INDEX sources_catalog_key_key ON sources (catalog_key) WHERE catalog_key IS NOT NULL;

-- ---------------------------------------------------------------- Source snapshots (append-only)

CREATE TABLE source_snapshots (
  id               uuid PRIMARY KEY,
  source_id        uuid NOT NULL REFERENCES sources (id),
  request_url      http_url NOT NULL,
  fetched_at       timestamptz(3) NOT NULL,
  content_sha256   text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  item_count       integer NOT NULL CHECK (item_count BETWEEN 0 AND 10000),
  evidence_count   integer NOT NULL CHECK (evidence_count BETWEEN 0 AND 10000),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  -- Lets Evidence reference a snapshot of its own source (composite foreign key below).
  CONSTRAINT source_snapshots_id_source_key UNIQUE (id, source_id),
  CONSTRAINT source_snapshots_evidence_within_items CHECK (evidence_count <= item_count),
  CONSTRAINT source_snapshots_fetched_not_after_created CHECK (fetched_at <= created_at)
);
CREATE INDEX source_snapshots_source_fetched_idx ON source_snapshots (source_id, fetched_at);
COMMENT ON TABLE source_snapshots IS
  'One load from a source: request, time and SHA-256 of the response; the raw response is not kept (PHASE 05).';

CREATE TRIGGER source_snapshots_append_only BEFORE UPDATE OR DELETE ON source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER source_snapshots_no_truncate BEFORE TRUNCATE ON source_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER source_snapshots_requires_event AFTER INSERT ON source_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('source_snapshot');

-- ---------------------------------------------------------------- Evidence provenance and privacy

ALTER TABLE evidence
  ADD COLUMN snapshot_id uuid,
  ADD COLUMN external_id text CONSTRAINT evidence_external_id_format
    CHECK (external_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- The load an item came from belongs to the same source.
  ADD CONSTRAINT evidence_snapshot_same_source
    FOREIGN KEY (snapshot_id, source_id) REFERENCES source_snapshots (id, source_id),
  -- No email addresses in stored excerpts (D-014 п.6); the domain also rejects phone numbers.
  ADD CONSTRAINT evidence_excerpt_without_email
    CHECK (excerpt !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}');
-- An item is stored once per source: repeated collection never duplicates it.
CREATE UNIQUE INDEX evidence_source_external_key ON evidence (source_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX evidence_snapshot_id_idx ON evidence (snapshot_id) WHERE snapshot_id IS NOT NULL;
