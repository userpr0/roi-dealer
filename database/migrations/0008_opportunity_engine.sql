-- 0008_opportunity_engine — journal of opportunity assessments (PHASE 07).
--
-- The opportunity analyst assesses each version of an open pain once: the AI frames it, code
-- checks the quotes, computes the score and picks the business model, and records the outcome
-- here, in the same transaction as the opportunity it created. A pain is assessed again only when
-- it grows (a new version); once it produced an opportunity it is not assessed again.
-- Append-only, like signal_extractions.

CREATE TABLE opportunity_assessments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz(3) NOT NULL DEFAULT now(),
  pain_id         uuid NOT NULL REFERENCES pains (id),
  pain_version    integer NOT NULL CHECK (pain_version >= 1),
  task_version    integer NOT NULL CHECK (task_version >= 1),
  -- opportunity: a draft was created; below_threshold: scored under the bar; rejected: the answer
  -- failed the checks in code; failed: every model failed on this pain.
  outcome         text NOT NULL CHECK (outcome IN (
                    'opportunity', 'below_threshold', 'rejected', 'failed')),
  -- 0–100 and its parts (weights of the spec), present for scored outcomes.
  score           smallint CHECK (score BETWEEN 0 AND 100),
  components      jsonb,
  opportunity_id  uuid REFERENCES opportunities (id),
  actor_type      actor_type NOT NULL,
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT opportunity_assessments_pain_version_once UNIQUE (pain_id, pain_version),
  CONSTRAINT opportunity_assessments_opportunity_for_outcome
    CHECK ((opportunity_id IS NOT NULL) = (outcome = 'opportunity')),
  CONSTRAINT opportunity_assessments_score_when_scored
    CHECK ((score IS NOT NULL) = (outcome IN ('opportunity', 'below_threshold'))),
  CONSTRAINT opportunity_assessments_components_object
    CHECK (components IS NULL OR jsonb_typeof(components) = 'object')
);
CREATE INDEX opportunity_assessments_occurred_at_idx ON opportunity_assessments (occurred_at);
CREATE INDEX opportunity_assessments_opportunity_id_idx ON opportunity_assessments (opportunity_id);
COMMENT ON TABLE opportunity_assessments IS
  'Append-only journal: each pain version assessed once, with its score and outcome (PHASE 07).';

CREATE TRIGGER opportunity_assessments_append_only BEFORE UPDATE OR DELETE
  ON opportunity_assessments FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER opportunity_assessments_no_truncate BEFORE TRUNCATE ON opportunity_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
