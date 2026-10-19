-- 0018_payments — payments through a merchant of record (PHASE 20b, ADR-0009, D-022).
--
-- checkouts: the payment link of a preorder test, set by the owner; a signed test-mode order
-- marks it tested (§7.2). One active link per experiment.
-- payment_events: what the provider's signed webhooks brought — orders, refunds, test orders —
-- each exactly once (provider + event key), with the revenue or refund line it created.
-- Revenue from an integration only from the payment provider's identity.

ALTER DOMAIN entity_type DROP CONSTRAINT entity_type_check;
ALTER DOMAIN entity_type ADD CONSTRAINT entity_type_check CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset',
  'system_control', 'principal', 'source_snapshot', 'revenue_entry', 'media_asset', 'lead',
  'checkout'
));

CREATE TABLE checkouts (
  id               uuid PRIMARY KEY,
  experiment_id    uuid NOT NULL,
  hypothesis_id    uuid NOT NULL,
  opportunity_id   uuid NOT NULL REFERENCES opportunities (id),
  provider         text NOT NULL CHECK (provider IN ('lemonsqueezy')),
  url              text NOT NULL CHECK (
    length(url) <= 500 AND url ~ '^https://[a-z0-9-]+\.lemonsqueezy\.com/(checkout/)?buy/'),
  status           text NOT NULL CHECK (status IN ('active', 'retired')),
  tested_at        timestamptz(3),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT checkouts_experiment_fkey FOREIGN KEY (experiment_id, hypothesis_id)
    REFERENCES experiments (id, hypothesis_id),
  CONSTRAINT checkouts_updated_after_created CHECK (updated_at >= created_at),
  -- Only the owner sets payment links.
  CONSTRAINT checkouts_created_by_owner CHECK (created_by_type = 'owner')
);
CREATE UNIQUE INDEX checkouts_one_active ON checkouts (experiment_id) WHERE status = 'active';
COMMENT ON TABLE checkouts IS 'Payment links of preorder tests at the merchant of record (PHASE 20b).';

CREATE TRIGGER checkouts_versioned_update BEFORE UPDATE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION guard_versioned_update();
CREATE TRIGGER checkouts_no_delete BEFORE DELETE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER checkouts_no_truncate BEFORE TRUNCATE ON checkouts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE CONSTRAINT TRIGGER checkouts_requires_event AFTER INSERT OR UPDATE ON checkouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_event('checkout');

CREATE TABLE payment_events (
  id                uuid PRIMARY KEY,
  provider          text NOT NULL CHECK (provider IN ('lemonsqueezy')),
  -- order:<id>, test_order:<id> or refund:<id>:<cumulative cents>: each happens once.
  event_key         text NOT NULL CHECK (event_key ~ '^[a-z_]+:[A-Za-z0-9_:-]{1,120}$'),
  kind              text NOT NULL CHECK (kind IN ('order', 'test_order', 'refund')),
  order_id          text_100 NOT NULL,
  experiment_id     uuid REFERENCES experiments (id),
  amount_usd_cents  usd_cents NOT NULL CHECK (amount_usd_cents >= 0),
  revenue_entry_id  uuid REFERENCES revenue_entries (id),
  cost_entry_id     uuid REFERENCES cost_entries (id),
  received_at       timestamptz(3) NOT NULL,
  actor_type        actor_type NOT NULL,
  actor_id          actor_id NOT NULL,
  correlation_id    text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT payment_events_once UNIQUE (provider, event_key)
);
CREATE INDEX payment_events_order_idx ON payment_events (provider, order_id);
CREATE INDEX payment_events_received_idx ON payment_events (received_at);
COMMENT ON TABLE payment_events IS
  'Append-only journal: orders, refunds and test orders the payment provider reported (PHASE 20b).';

CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE
  ON payment_events FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Revenue from an integration comes only from the payment provider's signed webhooks.
ALTER TABLE revenue_entries ADD CONSTRAINT revenue_entries_integration_provider CHECK (
  created_by_type <> 'integration' OR created_by_id = 'lemonsqueezy');
