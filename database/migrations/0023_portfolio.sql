-- 0023_portfolio — the month's test budget and its limits (phase 26, ADR-0013).
--
-- portfolio_budgets: each owner change is a new row; the latest row of a month up to the
-- current one applies, so a budget carries over until the owner changes it. Numbers only.

CREATE TABLE portfolio_budgets (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_at            timestamptz(3) NOT NULL DEFAULT now(),
  -- The UTC month the budget starts from, 'YYYY-MM'.
  month             text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  total_cents       integer NOT NULL CHECK (total_cents BETWEEN 100 AND 1000000),
  country_cents     integer NOT NULL CHECK (country_cents BETWEEN 100 AND total_cents),
  opportunity_cents integer NOT NULL CHECK (opportunity_cents BETWEEN 100 AND total_cents),
  actor_id          text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  correlation_id    text
);
CREATE INDEX portfolio_budgets_month_idx ON portfolio_budgets (month, id DESC);
COMMENT ON TABLE portfolio_budgets IS
  'Append-only journal: the owner''s month test budget and limits per country and opportunity (phase 26).';

CREATE TRIGGER portfolio_budgets_append_only BEFORE UPDATE OR DELETE
  ON portfolio_budgets FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER portfolio_budgets_no_truncate BEFORE TRUNCATE ON portfolio_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
