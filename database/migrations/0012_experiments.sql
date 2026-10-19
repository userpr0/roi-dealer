-- 0012_experiments — the honest-test checklist and the funnel of experiments (PHASE 15).
--
-- experiments: the honest-test checks the owner confirmed and when (D-014 п.8). An experiment
-- cannot be running, stopped or completed without them — the domain refuses the start, this
-- schema refuses the row.
-- experiment_events: one funnel for every test (D-014 п.9, ADR-0007): the stage, how many, the
-- channel, UTM tags and the UTC time, from the owner's reports now and from own pages later.
-- Append-only, like the other journals; the success metric is computed from sums per stage.

ALTER TABLE experiments
  ADD COLUMN honest_checks text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(honest_checks) <= 9 AND array_is_set(honest_checks)
    AND honest_checks <@ ARRAY[
      'no_fabrication', 'channel_rules', 'funnel_tracking', 'fake_door_disclosed', 'page_legal',
      'outreach_rules', 'refund_terms', 'payment_tested', 'crash_test']::text[]),
  ADD COLUMN checks_confirmed_at timestamptz(3),
  ADD CONSTRAINT experiments_checks_confirmed CHECK (
    (checks_confirmed_at IS NULL) = (cardinality(honest_checks) = 0)),
  -- Nothing starts before the honest-test checklist (D-014 п.8).
  ADD CONSTRAINT experiments_checks_before_start CHECK (
    status NOT IN ('running', 'stopped', 'completed') OR checks_confirmed_at IS NOT NULL),
  -- Target of the experiment_events (experiment_id, hypothesis_id) reference.
  ADD CONSTRAINT experiments_id_hypothesis_key UNIQUE (id, hypothesis_id);

CREATE TABLE experiment_events (
  id              uuid PRIMARY KEY,
  experiment_id   uuid NOT NULL,
  hypothesis_id   uuid NOT NULL,
  stage           text NOT NULL CHECK (stage IN (
                    'impression', 'attention', 'cta_click', 'activation', 'lead', 'payment',
                    'product_use', 'outcome', 'retention')),
  -- A reported batch of identical events (platform numbers); 1 for a single tracked event.
  quantity        integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  channel         text_100 NOT NULL,
  utm_source      text_100,
  utm_medium      text_100,
  utm_campaign    text_100,
  utm_content     text_100,
  utm_term        text_100,
  occurred_at     timestamptz(3) NOT NULL,
  recorded_at     timestamptz(3) NOT NULL DEFAULT now(),
  -- owner_report: numbers the owner reports through /funnel; tracker: events of own pages.
  source          text NOT NULL CHECK (source IN ('owner_report', 'tracker')),
  actor_type      actor_type NOT NULL,
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- The event belongs to the experiment's own hypothesis.
  CONSTRAINT experiment_events_experiment_fkey FOREIGN KEY (experiment_id, hypothesis_id)
    REFERENCES experiments (id, hypothesis_id)
);
CREATE INDEX experiment_events_experiment_stage_idx ON experiment_events (experiment_id, stage);
COMMENT ON TABLE experiment_events IS
  'Append-only journal: the funnel events of experiments, one schema for every test (PHASE 15).';

CREATE TRIGGER experiment_events_append_only BEFORE UPDATE OR DELETE
  ON experiment_events FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER experiment_events_no_truncate BEFORE TRUNCATE ON experiment_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
