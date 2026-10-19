-- 0013_economics — the revenue ledger (PHASE 16).
--
-- revenue_entries: money that came in, as immutable lines — a payment (confirmed revenue) or a
-- preorder (a liability until the product exists), the number of paying customers (no personal
-- data) and what it belongs to. A correction is a reversal line. Refunds to customers are
-- cost_entries of category 'refund' (PHASE 01). Every line has its created event.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot', 'revenue_entry'
));

CREATE TABLE revenue_entries (
  id                uuid PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('payment', 'preorder')),
  amount_usd_cents  usd_cents NOT NULL CHECK (amount_usd_cents > 0),
  customers         integer NOT NULL CHECK (customers BETWEEN 0 AND 100000),
  description       text_500 NOT NULL,
  received_at       timestamptz(3) NOT NULL,
  opportunity_id    uuid REFERENCES opportunities (id),
  hypothesis_id     uuid REFERENCES hypotheses (id),
  experiment_id     uuid REFERENCES experiments (id),
  reversal_of       uuid REFERENCES revenue_entries (id),
  created_at        timestamptz(3) NOT NULL,
  created_by_type   actor_type NOT NULL,
  created_by_id     actor_id NOT NULL,
  CONSTRAINT revenue_entries_not_self_reversal CHECK (reversal_of <> id)
);
CREATE INDEX revenue_entries_received_at_idx ON revenue_entries (received_at);
CREATE INDEX revenue_entries_opportunity_id_idx ON revenue_entries (opportunity_id);
CREATE INDEX revenue_entries_experiment_id_idx ON revenue_entries (experiment_id);
CREATE INDEX revenue_entries_reversal_of_idx ON revenue_entries (reversal_of);
COMMENT ON TABLE revenue_entries IS 'Revenue ledger (PHASE 16): immutable lines; a reversal is a new line.';

CREATE TRIGGER revenue_entries_append_only BEFORE UPDATE OR DELETE ON revenue_entries
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER revenue_entries_no_truncate BEFORE TRUNCATE ON revenue_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER revenue_entries_requires_event AFTER INSERT ON revenue_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('revenue_entry');
