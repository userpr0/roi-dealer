-- 0007_signals_pain — journal of evidence analysis (PHASE 06).
--
-- The pain analyst reads each Evidence once: the AI decides whether it shows a pain, code checks
-- the quote, groups the signal into a pain candidate and records the outcome here in the same
-- transaction. A recorded Evidence is never analyzed again, so no AI budget is spent twice.
-- Append-only, like access_log and ai_calls.

CREATE TABLE signal_extractions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz(3) NOT NULL DEFAULT now(),
  evidence_id     uuid NOT NULL REFERENCES evidence (id),
  task_version    integer NOT NULL CHECK (task_version >= 1),
  -- signal: a signal was created; no_pain: the AI found no pain; rejected: the answer failed the
  -- checks in code (a quote not in the text); failed: every model failed on this evidence.
  outcome         text NOT NULL CHECK (outcome IN ('signal', 'no_pain', 'rejected', 'failed')),
  signal_id       uuid REFERENCES signals (id),
  pain_id         uuid REFERENCES pains (id),
  actor_type      actor_type NOT NULL,
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT signal_extractions_evidence_once UNIQUE (evidence_id),
  CONSTRAINT signal_extractions_signal_for_signal CHECK ((signal_id IS NOT NULL) = (outcome = 'signal')),
  CONSTRAINT signal_extractions_pain_with_signal CHECK (pain_id IS NULL OR signal_id IS NOT NULL)
);
CREATE INDEX signal_extractions_occurred_at_idx ON signal_extractions (occurred_at);
COMMENT ON TABLE signal_extractions IS
  'Append-only journal: each Evidence analyzed once for pains, with its outcome (PHASE 06).';

CREATE TRIGGER signal_extractions_append_only BEFORE UPDATE OR DELETE ON signal_extractions
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER signal_extractions_no_truncate BEFORE TRUNCATE ON signal_extractions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
