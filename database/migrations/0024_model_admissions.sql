-- 0024_model_admissions — model changes by tests (09b, ADR-0014).
--
-- model_admissions: the owner's decision on a candidate model; the latest one per model applies.
-- provider_models: model ids the providers list, with when each was first seen. The first list of
-- a provider is a baseline; ids seen later are new for the owner. Ids only, no texts.

CREATE TABLE model_admissions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decided_at     timestamptz(3) NOT NULL DEFAULT now(),
  model_id       text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 100),
  decision       text NOT NULL CHECK (decision IN ('admitted', 'rejected')),
  actor_id       text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  correlation_id text
);
CREATE INDEX model_admissions_model_idx ON model_admissions (model_id, id DESC);
COMMENT ON TABLE model_admissions IS
  'Append-only journal: the owner admits or rejects a candidate AI model (09b).';

CREATE TRIGGER model_admissions_append_only BEFORE UPDATE OR DELETE
  ON model_admissions FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER model_admissions_no_truncate BEFORE TRUNCATE ON model_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE provider_models (
  provider      text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  model_id      text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 100),
  first_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  baseline      boolean NOT NULL,
  PRIMARY KEY (provider, model_id)
);
COMMENT ON TABLE provider_models IS
  'Model ids each provider listed and when first seen; the first list is the baseline (09b).';
