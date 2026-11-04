-- 0022_forecasts — forecast vs fact (phase 25, ADR-0013).
--
-- forecasts: when a test starts, how likely its success metric is to be reached, computed in
-- code from the opportunity's score, with the rules version and the inputs the rules saw.
-- forecast_outcomes: the fact once the owner records the result of the test.
-- Append-only journals of numbers: no texts, no people, no events (like opportunity_assessments).

CREATE TABLE forecasts (
  experiment_id  uuid PRIMARY KEY REFERENCES experiments (id),
  occurred_at    timestamptz(3) NOT NULL DEFAULT now(),
  rules_version  integer NOT NULL CHECK (rules_version >= 1),
  probability    numeric(4, 3) NOT NULL CHECK (probability > 0 AND probability < 1),
  signals        jsonb NOT NULL CHECK (jsonb_typeof(signals) = 'object'),
  correlation_id text
);
CREATE INDEX forecasts_rules_version_idx ON forecasts (rules_version);
COMMENT ON TABLE forecasts IS
  'Append-only journal: the forecast of each test at its start, computed in code (phase 25).';

CREATE TABLE forecast_outcomes (
  experiment_id  uuid PRIMARY KEY REFERENCES forecasts (experiment_id),
  occurred_at    timestamptz(3) NOT NULL DEFAULT now(),
  reached        boolean NOT NULL,
  metric_value   numeric,
  verdict        text NOT NULL CHECK (verdict IN ('confirmed', 'refuted', 'inconclusive')),
  correlation_id text,
  CONSTRAINT forecast_outcomes_reached_is_confirmed CHECK (reached = (verdict = 'confirmed'))
);
COMMENT ON TABLE forecast_outcomes IS
  'Append-only journal: the fact of each forecast test, from the owner''s result (phase 25).';

CREATE TRIGGER forecasts_append_only BEFORE UPDATE OR DELETE
  ON forecasts FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER forecasts_no_truncate BEFORE TRUNCATE ON forecasts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER forecast_outcomes_append_only BEFORE UPDATE OR DELETE
  ON forecast_outcomes FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER forecast_outcomes_no_truncate BEFORE TRUNCATE ON forecast_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
