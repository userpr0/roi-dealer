-- 0011_judges — journal of the judges' assessments of opportunities (PHASE 11).
--
-- Six judges score each version of a draft opportunity, one criterion per call: a score 1–5,
-- the checked rationale and concerns the decision card shows, and the evidence cited. One row per
-- opportunity version and criterion; append-only, like the other journals. The owner decides on
-- the opportunity (PHASE 12); these rows are what the decision card is built from.

CREATE TABLE opportunity_judgements (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at          timestamptz(3) NOT NULL DEFAULT now(),
  opportunity_id       uuid NOT NULL REFERENCES opportunities (id),
  opportunity_version  integer NOT NULL CHECK (opportunity_version >= 1),
  criterion            text NOT NULL CHECK (criterion IN (
                         'market', 'pain_value', 'economics', 'buildability', 'risk', 'reuse')),
  task_version         integer NOT NULL CHECK (task_version >= 1),
  -- judged: a checked score; rejected: the answer failed the checks in code; failed: every model
  -- failed on this criterion.
  outcome              text NOT NULL CHECK (outcome IN ('judged', 'rejected', 'failed')),
  score                smallint CHECK (score BETWEEN 1 AND 5),
  -- Whether the judgement cites evidence; a required citation missing caps the score at 2.
  supported            boolean,
  rationale            text CHECK (char_length(rationale) BETWEEN 1 AND 600),
  concerns             text[] NOT NULL DEFAULT '{}' CHECK (cardinality(concerns) <= 3),
  evidence_ids         uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_ids) <= 8),
  actor_type           actor_type NOT NULL,
  actor_id             actor_id NOT NULL,
  correlation_id       text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT opportunity_judgements_once UNIQUE (opportunity_id, opportunity_version, criterion),
  CONSTRAINT opportunity_judgements_score_when_judged
    CHECK ((score IS NOT NULL) = (outcome = 'judged')),
  CONSTRAINT opportunity_judgements_rationale_when_judged
    CHECK ((rationale IS NOT NULL) = (outcome = 'judged')),
  CONSTRAINT opportunity_judgements_supported_when_judged
    CHECK ((supported IS NOT NULL) = (outcome = 'judged'))
);
CREATE INDEX opportunity_judgements_occurred_at_idx ON opportunity_judgements (occurred_at);
COMMENT ON TABLE opportunity_judgements IS
  'Append-only journal: the judges'' score of each opportunity version per criterion (PHASE 11).';

CREATE TRIGGER opportunity_judgements_append_only BEFORE UPDATE OR DELETE
  ON opportunity_judgements FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER opportunity_judgements_no_truncate BEFORE TRUNCATE ON opportunity_judgements
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
