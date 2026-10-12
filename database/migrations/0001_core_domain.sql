-- 0001_core_domain — the 13 entities of the ROI CORE v0.1 domain (PHASE 01) in PostgreSQL.
--
-- The domain package (@roi-dealer/domain) owns behaviour: who may decide, which status changes
-- are allowed, the five-hypothesis rule. This schema is the last line of defence for structure:
-- types, references, money, time, human-gate consistency and append-only history.
--
-- Conventions (docs: database/docs/schema.md):
--   * ids are uuid; the application always passes them (uuidv7() from @roi-dealer/shared);
--   * instants are timestamptz(3) — millisecond precision, as Date#toISOString(); sessions run in UTC;
--   * money is integer US cents (D-005) in *_usd_cents columns;
--   * an actor is a pair of *_type / *_id columns;
--   * id lists are link tables with a position that keeps the order; code lists are text[]
--     with format checks (built-in array types keep the driver independent of custom types);
--   * rows are never deleted; immutable records and link rows are never updated.

-- ---------------------------------------------------------------- Value domains

CREATE DOMAIN text_32 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 32 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_100 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 100 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_200 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 200 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_300 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 300 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_500 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 500 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_1000 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 1000 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_2000 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 2000 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_3000 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 3000 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_5000 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 5000 AND VALUE = btrim(VALUE, E' \t\r\n'));
CREATE DOMAIN text_50000 AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 50000 AND VALUE = btrim(VALUE, E' \t\r\n'));

CREATE DOMAIN country_code AS text CHECK (VALUE ~ '^[A-Z]{2}$');
CREATE DOMAIN language_tag AS text CHECK (VALUE ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
CREATE DOMAIN http_url AS text CHECK (VALUE ~* '^https?://' AND char_length(VALUE) <= 2000);

-- Integer cents that JavaScript can represent exactly (Number.MAX_SAFE_INTEGER).
CREATE DOMAIN usd_cents AS bigint
  CHECK (VALUE BETWEEN -9007199254740991 AND 9007199254740991);

CREATE DOMAIN actor_type AS text
  CHECK (VALUE IN ('owner', 'member', 'agent', 'system', 'integration'));
CREATE DOMAIN actor_id AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 128 AND VALUE = btrim(VALUE, E' \t\r\n'));

CREATE DOMAIN entity_type AS text CHECK (VALUE IN (
  'source', 'evidence', 'signal', 'pain', 'opportunity', 'decision', 'approval_request',
  'hypothesis', 'experiment', 'cost_entry', 'contribution', 'reward', 'knowledge_asset'
));

-- ---------------------------------------------------------------- Helper functions

-- True when the array has no NULL and no repeated element (the domain's uniqueList).
CREATE FUNCTION array_is_set(anyarray) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT count(*) = count(DISTINCT element) FROM unnest($1) AS element $$;

-- True when every element matches the regular expression (an empty array matches).
CREATE FUNCTION array_all_match(text[], text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT coalesce(bool_and(element ~ $2), true) FROM unnest($1) AS element $$;

-- Rows of history tables are never rewritten or removed (§2.2): corrections are new rows.
CREATE FUNCTION reject_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          TABLE = TG_TABLE_NAME,
          CONSTRAINT = TG_TABLE_NAME || '_' || lower(TG_OP) || '_forbidden';
END;
$$;

-- Optimistic locking: every update is a new version (version + 1) of the same record.
CREATE FUNCTION guard_versioned_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_type IS DISTINCT FROM OLD.created_by_type
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'id and creation metadata of % are immutable', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = TG_TABLE_NAME || '_creation_immutable';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'an update of % must increment version by exactly 1', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = TG_TABLE_NAME || '_version_increment';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Source

CREATE TABLE sources (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN (
                     'website', 'forum', 'social', 'marketplace', 'review_site',
                     'search_trends', 'news', 'dataset', 'manual', 'other')),
  name             text_200 NOT NULL,
  url              http_url,
  markets          text[] NOT NULL CHECK (
                     cardinality(markets) BETWEEN 1 AND 50 AND array_is_set(markets)
                     AND array_all_match(markets, '^[A-Z]{2}$')),
  languages        text[] NOT NULL CHECK (
                     cardinality(languages) BETWEEN 1 AND 20 AND array_is_set(languages)
                     AND array_all_match(languages, '^[a-z]{2,3}(-[A-Z]{2})?$')),
  trust            text NOT NULL CHECK (trust IN ('unverified', 'low', 'medium', 'high')),
  status           text NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT sources_updated_after_created CHECK (updated_at >= created_at)
);
COMMENT ON TABLE sources IS 'Where market data comes from (PHASE 01 Source).';

-- ---------------------------------------------------------------- Evidence (append-only)

CREATE TABLE evidence (
  id               uuid PRIMARY KEY,
  source_id        uuid NOT NULL REFERENCES sources (id),
  kind             text NOT NULL CHECK (kind IN (
                     'quote', 'review', 'post', 'metric', 'price', 'search_trend',
                     'observation', 'document', 'other')),
  excerpt          text_5000 NOT NULL,
  url              http_url,
  observed_at      timestamptz(3) NOT NULL,
  market           country_code,
  language         language_tag,
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  CONSTRAINT evidence_observed_not_after_created CHECK (observed_at <= created_at)
);
CREATE INDEX evidence_source_id_idx ON evidence (source_id);
COMMENT ON TABLE evidence IS 'Immutable facts captured from a source; corrections are new rows (§2.2, §2.5).';

-- ---------------------------------------------------------------- Signal

CREATE TABLE signals (
  id               uuid PRIMARY KEY,
  title            text_200 NOT NULL,
  summary          text_2000 NOT NULL,
  markets          text[] NOT NULL CHECK (
                     cardinality(markets) BETWEEN 1 AND 50 AND array_is_set(markets)
                     AND array_all_match(markets, '^[A-Z]{2}$')),
  strength         text NOT NULL CHECK (strength IN ('weak', 'moderate', 'strong')),
  status           text NOT NULL CHECK (status IN ('new', 'triaged', 'promoted', 'dismissed')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT signals_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TABLE signal_evidence (
  signal_id        uuid NOT NULL REFERENCES signals (id),
  evidence_id      uuid NOT NULL REFERENCES evidence (id),
  position         smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (signal_id, evidence_id),
  UNIQUE (signal_id, position)
);
CREATE INDEX signal_evidence_evidence_id_idx ON signal_evidence (evidence_id);

-- ---------------------------------------------------------------- Pain

CREATE TABLE pains (
  id               uuid PRIMARY KEY,
  title            text_200 NOT NULL,
  description      text_5000 NOT NULL,
  audience         text_1000 NOT NULL,
  desired_outcome  text_1000 NOT NULL,
  severity         smallint NOT NULL CHECK (severity BETWEEN 1 AND 5),
  frequency        text NOT NULL CHECK (frequency IN ('rare', 'occasional', 'frequent', 'constant')),
  markets          text[] NOT NULL CHECK (
                     cardinality(markets) BETWEEN 1 AND 50 AND array_is_set(markets)
                     AND array_all_match(markets, '^[A-Z]{2}$')),
  status           text NOT NULL CHECK (status IN ('candidate', 'validated', 'rejected', 'archived')),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  updated_at       timestamptz(3) NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  CONSTRAINT pains_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TABLE pain_signals (
  pain_id          uuid NOT NULL REFERENCES pains (id),
  signal_id        uuid NOT NULL REFERENCES signals (id),
  position         smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (pain_id, signal_id),
  UNIQUE (pain_id, position)
);
CREATE INDEX pain_signals_signal_id_idx ON pain_signals (signal_id);

CREATE TABLE pain_evidence (
  pain_id          uuid NOT NULL REFERENCES pains (id),
  evidence_id      uuid NOT NULL REFERENCES evidence (id),
  position         smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (pain_id, evidence_id),
  UNIQUE (pain_id, position)
);
CREATE INDEX pain_evidence_evidence_id_idx ON pain_evidence (evidence_id);

-- ---------------------------------------------------------------- Opportunity

CREATE TABLE opportunities (
  id                       uuid PRIMARY KEY,
  title                    text_200 NOT NULL,
  summary                  text_3000 NOT NULL,
  icp                      text_1000 NOT NULL,
  markets                  text[] NOT NULL CHECK (
                             cardinality(markets) BETWEEN 1 AND 50 AND array_is_set(markets)
                             AND array_all_match(markets, '^[A-Z]{2}$')),
  value_problem            text_1000 NOT NULL,
  value_change             text_1000 NOT NULL,
  value_measurable_result  text_500 NOT NULL,
  value_proof              text_1000,
  business_model           text NOT NULL CHECK (business_model IN (
                             'free_limit', 'subscription', 'one_time', 'setup_fee', 'bundle',
                             'usage_based', 'outcome_based', 'lifetime_deal', 'service',
                             'marketplace', 'affiliate', 'advertising', 'licensing', 'other')),
  pricing_hypothesis       text_500,
  parent_id                uuid REFERENCES opportunities (id),
  status                   text NOT NULL CHECK (status IN (
                             'draft', 'under_review', 'approved', 'rejected', 'validating',
                             'paused', 'scaling', 'killed', 'archived')),
  last_decision_id         uuid,
  created_at               timestamptz(3) NOT NULL,
  created_by_type          actor_type NOT NULL,
  created_by_id            actor_id NOT NULL,
  updated_at               timestamptz(3) NOT NULL,
  version                  integer NOT NULL CHECK (version >= 1),
  CONSTRAINT opportunities_updated_after_created CHECK (updated_at >= created_at),
  CONSTRAINT opportunities_not_own_parent CHECK (parent_id <> id)
);
CREATE INDEX opportunities_parent_id_idx ON opportunities (parent_id);

CREATE TABLE opportunity_pains (
  opportunity_id   uuid NOT NULL REFERENCES opportunities (id),
  pain_id          uuid NOT NULL REFERENCES pains (id),
  position         smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (opportunity_id, pain_id),
  UNIQUE (opportunity_id, position)
);
CREATE INDEX opportunity_pains_pain_id_idx ON opportunity_pains (pain_id);

-- ---------------------------------------------------------------- Decision (append-only)

CREATE TABLE decisions (
  id               uuid PRIMARY KEY,
  subject_type     text NOT NULL CHECK (subject_type IN ('opportunity', 'experiment')),
  subject_id       uuid NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN (
                     'approve', 'reject', 'more_research', 'pause', 'kill', 'scale', 'improve',
                     'pivot')),
  rationale        text_3000 NOT NULL,
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL
);
CREATE INDEX decisions_subject_idx ON decisions (subject_type, subject_id);
COMMENT ON TABLE decisions IS 'Immutable owner decisions (§2.3); only the owner creates them (domain rule).';

CREATE TABLE decision_evidence (
  decision_id      uuid NOT NULL REFERENCES decisions (id),
  evidence_id      uuid NOT NULL REFERENCES evidence (id),
  position         smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (decision_id, evidence_id),
  UNIQUE (decision_id, position)
);
CREATE INDEX decision_evidence_evidence_id_idx ON decision_evidence (evidence_id);

ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_last_decision_id_fkey
  FOREIGN KEY (last_decision_id) REFERENCES decisions (id);

-- ---------------------------------------------------------------- ApprovalRequest

CREATE TABLE approval_requests (
  id                 uuid PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN (
                       'spend', 'recurring_payment', 'payout', 'asset_purchase',
                       'experiment_launch', 'opportunity_decision', 'production_change', 'legal',
                       'secret_access', 'policy_change', 'budget_change')),
  title              text_200 NOT NULL,
  summary            text_3000 NOT NULL,
  subject_type       entity_type,
  subject_id         uuid,
  amount_usd_cents   usd_cents CHECK (amount_usd_cents > 0),
  expires_at         timestamptz(3) NOT NULL,
  status             text NOT NULL CHECK (status IN (
                       'pending', 'approved', 'rejected', 'expired', 'cancelled')),
  decided_by_type    actor_type,
  decided_by_id      actor_id,
  decided_at         timestamptz(3),
  decision_comment   text_1000,
  created_at         timestamptz(3) NOT NULL,
  created_by_type    actor_type NOT NULL,
  created_by_id      actor_id NOT NULL,
  updated_at         timestamptz(3) NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  CONSTRAINT approval_requests_updated_after_created CHECK (updated_at >= created_at),
  CONSTRAINT approval_requests_subject_complete CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  -- D-006: the owner always sees the money at stake.
  CONSTRAINT approval_requests_amount_required CHECK (
    kind NOT IN ('spend', 'recurring_payment', 'payout', 'asset_purchase', 'budget_change',
                 'experiment_launch')
    OR amount_usd_cents IS NOT NULL),
  CONSTRAINT approval_requests_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT approval_requests_resolution_complete CHECK (
    (decided_by_type IS NULL) = (decided_by_id IS NULL)
    AND (decided_by_type IS NULL) = (decided_at IS NULL)
    AND (decision_comment IS NULL OR decided_at IS NOT NULL)),
  -- A resolution is recorded exactly when the owner approved or rejected the request.
  CONSTRAINT approval_requests_resolution_matches_status CHECK (
    (decided_at IS NOT NULL) = (status IN ('approved', 'rejected')))
);
CREATE INDEX approval_requests_subject_idx ON approval_requests (subject_type, subject_id);
COMMENT ON TABLE approval_requests IS 'Human gates (§2.7, D-006): what the owner must approve.';

-- ---------------------------------------------------------------- Hypothesis

CREATE TABLE hypotheses (
  id                        uuid PRIMARY KEY,
  opportunity_id            uuid NOT NULL REFERENCES opportunities (id),
  statement                 text_1000 NOT NULL,
  audience                  text_500 NOT NULL,
  geo                       country_code NOT NULL,
  offer                     text_500 NOT NULL,
  price_usd_cents           usd_cents NOT NULL CHECK (price_usd_cents >= 0),
  channel                   text_100 NOT NULL,
  creative                  text_1000 NOT NULL,
  cta                       text_200 NOT NULL,
  validation_method         text NOT NULL CHECK (validation_method IN (
                              'landing_page', 'demo', 'clickable_prototype', 'concierge',
                              'preorder', 'ads_test', 'outreach', 'interviews',
                              'marketplace_listing', 'waitlist', 'other')),
  success_metric_name       text_100 NOT NULL,
  success_metric_target     double precision NOT NULL
                              CHECK (success_metric_target NOT IN ('Infinity', '-Infinity', 'NaN')),
  success_metric_unit       text_32 NOT NULL,
  success_metric_direction  text NOT NULL CHECK (success_metric_direction IN ('at_least', 'at_most')),
  budget_usd_cents          usd_cents NOT NULL CHECK (budget_usd_cents > 0),
  stop_loss_usd_cents       usd_cents NOT NULL CHECK (stop_loss_usd_cents > 0),
  minimum_data              text_300 NOT NULL,
  parent_id                 uuid REFERENCES hypotheses (id),
  status                    text NOT NULL CHECK (status IN (
                              'proposed', 'selected', 'discarded', 'testing', 'confirmed',
                              'refuted', 'inconclusive')),
  created_at                timestamptz(3) NOT NULL,
  created_by_type           actor_type NOT NULL,
  created_by_id             actor_id NOT NULL,
  updated_at                timestamptz(3) NOT NULL,
  version                   integer NOT NULL CHECK (version >= 1),
  CONSTRAINT hypotheses_updated_after_created CHECK (updated_at >= created_at),
  CONSTRAINT hypotheses_stop_loss_within_budget CHECK (stop_loss_usd_cents <= budget_usd_cents),
  CONSTRAINT hypotheses_not_own_parent CHECK (parent_id <> id),
  -- Target of the experiments (hypothesis_id, opportunity_id) reference.
  CONSTRAINT hypotheses_id_opportunity_key UNIQUE (id, opportunity_id)
);
CREATE INDEX hypotheses_opportunity_id_idx ON hypotheses (opportunity_id);

-- ---------------------------------------------------------------- Experiment

CREATE TABLE experiments (
  id                            uuid PRIMARY KEY,
  opportunity_id                uuid NOT NULL REFERENCES opportunities (id),
  hypothesis_id                 uuid NOT NULL,
  artifact                      text NOT NULL CHECK (artifact IN (
                                  'demo', 'landing', 'clickable_prototype', 'single_function_app',
                                  'concierge', 'minimal_automation', 'other')),
  description                   text_3000 NOT NULL,
  build_max_money_usd_cents     usd_cents NOT NULL CHECK (build_max_money_usd_cents >= 0),
  build_max_ai_cost_usd_cents   usd_cents NOT NULL CHECK (build_max_ai_cost_usd_cents >= 0),
  build_max_human_hours         double precision NOT NULL
                                  CHECK (build_max_human_hours BETWEEN 0 AND 10000),
  build_max_calendar_days       smallint NOT NULL CHECK (build_max_calendar_days BETWEEN 1 AND 365),
  test_budget_usd_cents         usd_cents NOT NULL CHECK (test_budget_usd_cents > 0),
  stop_loss_usd_cents           usd_cents NOT NULL CHECK (stop_loss_usd_cents > 0),
  success_metric_name           text_100 NOT NULL,
  success_metric_target         double precision NOT NULL
                                  CHECK (success_metric_target NOT IN ('Infinity', '-Infinity', 'NaN')),
  success_metric_unit           text_32 NOT NULL,
  success_metric_direction      text NOT NULL
                                  CHECK (success_metric_direction IN ('at_least', 'at_most')),
  kill_criteria                 text_1000 NOT NULL,
  expected_evidence             text_1000 NOT NULL,
  status                        text NOT NULL CHECK (status IN (
                                  'planned', 'awaiting_approval', 'approved', 'running', 'stopped',
                                  'completed', 'cancelled')),
  approval_request_id           uuid REFERENCES approval_requests (id),
  started_at                    timestamptz(3),
  ended_at                      timestamptz(3),
  stop_reason                   text_500,
  result_outcome                text CHECK (result_outcome IN ('scale', 'improve', 'pivot', 'kill')),
  result_summary                text_3000,
  created_at                    timestamptz(3) NOT NULL,
  created_by_type               actor_type NOT NULL,
  created_by_id                 actor_id NOT NULL,
  updated_at                    timestamptz(3) NOT NULL,
  version                       integer NOT NULL CHECK (version >= 1),
  CONSTRAINT experiments_updated_after_created CHECK (updated_at >= created_at),
  -- The tested hypothesis belongs to the same opportunity.
  CONSTRAINT experiments_hypothesis_fkey FOREIGN KEY (hypothesis_id, opportunity_id)
    REFERENCES hypotheses (id, opportunity_id),
  CONSTRAINT experiments_stop_loss_within_budget CHECK (stop_loss_usd_cents <= test_budget_usd_cents),
  -- Nothing runs without the owner's launch approval (D-006).
  CONSTRAINT experiments_launch_approval_referenced CHECK (
    status NOT IN ('awaiting_approval', 'approved', 'running', 'stopped', 'completed')
    OR approval_request_id IS NOT NULL),
  CONSTRAINT experiments_started_matches_status CHECK (
    (started_at IS NOT NULL) = (status IN ('running', 'stopped', 'completed'))),
  CONSTRAINT experiments_ended_matches_status CHECK (
    (ended_at IS NOT NULL) = (status IN ('stopped', 'completed'))),
  CONSTRAINT experiments_ended_after_started CHECK (ended_at >= started_at),
  CONSTRAINT experiments_stop_reason_when_stopped CHECK (
    (status <> 'stopped' OR stop_reason IS NOT NULL)
    AND (stop_reason IS NULL OR status IN ('stopped', 'completed'))),
  -- Every cycle leaves an asset (§2.9): a completed experiment has a result.
  CONSTRAINT experiments_result_complete CHECK ((result_outcome IS NULL) = (result_summary IS NULL)),
  CONSTRAINT experiments_result_matches_status CHECK (
    (result_outcome IS NOT NULL) = (status = 'completed'))
);
CREATE INDEX experiments_opportunity_id_idx ON experiments (opportunity_id);
CREATE INDEX experiments_hypothesis_id_idx ON experiments (hypothesis_id);
CREATE INDEX experiments_approval_request_id_idx ON experiments (approval_request_id);

-- ---------------------------------------------------------------- KnowledgeAsset (append-only)

CREATE TABLE knowledge_assets (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN (
                     'evidence_summary', 'knowledge', 'pattern', 'failure_pattern', 'skill',
                     'asset', 'reusable_code', 'market_data')),
  title            text_200 NOT NULL,
  summary          text_3000 NOT NULL,
  body             text_50000,
  opportunity_id   uuid REFERENCES opportunities (id),
  hypothesis_id    uuid REFERENCES hypotheses (id),
  experiment_id    uuid REFERENCES experiments (id),
  tags             text[] NOT NULL CHECK (
                     cardinality(tags) <= 20 AND array_is_set(tags)
                     AND array_all_match(tags, '^[a-z0-9][a-z0-9_-]{0,39}$')),
  supersedes       uuid REFERENCES knowledge_assets (id),
  created_at       timestamptz(3) NOT NULL,
  created_by_type  actor_type NOT NULL,
  created_by_id    actor_id NOT NULL,
  CONSTRAINT knowledge_assets_not_self_superseding CHECK (supersedes <> id)
);
CREATE INDEX knowledge_assets_opportunity_id_idx ON knowledge_assets (opportunity_id);
CREATE INDEX knowledge_assets_experiment_id_idx ON knowledge_assets (experiment_id);
CREATE INDEX knowledge_assets_supersedes_idx ON knowledge_assets (supersedes);
COMMENT ON TABLE knowledge_assets IS 'Company Brain entries; a new version references the one it supersedes (§2.9).';

CREATE TABLE knowledge_asset_evidence (
  knowledge_asset_id  uuid NOT NULL REFERENCES knowledge_assets (id),
  evidence_id         uuid NOT NULL REFERENCES evidence (id),
  position            smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (knowledge_asset_id, evidence_id),
  UNIQUE (knowledge_asset_id, position)
);
CREATE INDEX knowledge_asset_evidence_evidence_id_idx ON knowledge_asset_evidence (evidence_id);

CREATE TABLE experiment_result_assets (
  experiment_id       uuid NOT NULL REFERENCES experiments (id),
  knowledge_asset_id  uuid NOT NULL REFERENCES knowledge_assets (id),
  position            smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (experiment_id, knowledge_asset_id),
  UNIQUE (experiment_id, position)
);
CREATE INDEX experiment_result_assets_asset_id_idx ON experiment_result_assets (knowledge_asset_id);

-- ---------------------------------------------------------------- CostEntry (append-only)

CREATE TABLE cost_entries (
  id                   uuid PRIMARY KEY,
  category             text NOT NULL CHECK (category IN (
                         'ai', 'api', 'infrastructure', 'storage', 'media', 'ads', 'human',
                         'refund', 'vendor', 'other')),
  amount_usd_cents     usd_cents NOT NULL CHECK (amount_usd_cents > 0),
  description          text_500 NOT NULL,
  incurred_at          timestamptz(3) NOT NULL,
  recurring            boolean NOT NULL,
  opportunity_id       uuid REFERENCES opportunities (id),
  hypothesis_id        uuid REFERENCES hypotheses (id),
  experiment_id        uuid REFERENCES experiments (id),
  approval_request_id  uuid REFERENCES approval_requests (id),
  reversal_of          uuid REFERENCES cost_entries (id),
  created_at           timestamptz(3) NOT NULL,
  created_by_type      actor_type NOT NULL,
  created_by_id        actor_id NOT NULL,
  CONSTRAINT cost_entries_not_self_reversal CHECK (reversal_of <> id)
);
CREATE INDEX cost_entries_incurred_at_idx ON cost_entries (incurred_at);
CREATE INDEX cost_entries_opportunity_id_idx ON cost_entries (opportunity_id);
CREATE INDEX cost_entries_experiment_id_idx ON cost_entries (experiment_id);
CREATE INDEX cost_entries_approval_request_id_idx ON cost_entries (approval_request_id);
CREATE INDEX cost_entries_reversal_of_idx ON cost_entries (reversal_of);
COMMENT ON TABLE cost_entries IS 'Cost ledger (§2.8): immutable lines; a reversal is a new line.';

-- ---------------------------------------------------------------- Contribution

CREATE TABLE contributions (
  id                uuid PRIMARY KEY,
  contributor_type  actor_type NOT NULL,
  contributor_id    actor_id NOT NULL,
  kind              text NOT NULL CHECK (kind IN (
                      'research', 'evidence', 'analysis', 'build', 'content', 'sales',
                      'operations', 'other')),
  description       text_2000 NOT NULL,
  subject_type      entity_type,
  subject_id        uuid,
  occurred_at       timestamptz(3) NOT NULL,
  status            text NOT NULL CHECK (status IN ('recorded', 'verified', 'rejected')),
  reviewed_by_type  actor_type,
  reviewed_by_id    actor_id,
  reviewed_at       timestamptz(3),
  review_note       text_1000,
  created_at        timestamptz(3) NOT NULL,
  created_by_type   actor_type NOT NULL,
  created_by_id     actor_id NOT NULL,
  updated_at        timestamptz(3) NOT NULL,
  version           integer NOT NULL CHECK (version >= 1),
  CONSTRAINT contributions_updated_after_created CHECK (updated_at >= created_at),
  CONSTRAINT contributions_subject_complete CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT contributions_review_complete CHECK (
    (reviewed_by_type IS NULL) = (reviewed_by_id IS NULL)
    AND (reviewed_by_type IS NULL) = (reviewed_at IS NULL)
    AND (review_note IS NULL OR reviewed_at IS NOT NULL)),
  CONSTRAINT contributions_review_matches_status CHECK (
    (reviewed_at IS NOT NULL) = (status IN ('verified', 'rejected')))
);
CREATE INDEX contributions_contributor_idx ON contributions (contributor_type, contributor_id);

-- ---------------------------------------------------------------- Reward

CREATE TABLE rewards (
  id                   uuid PRIMARY KEY,
  -- Rewards are paid to people only (§2.10).
  contributor_type     actor_type NOT NULL CHECK (contributor_type IN ('owner', 'member')),
  contributor_id       actor_id NOT NULL,
  amount_usd_cents     usd_cents NOT NULL CHECK (amount_usd_cents > 0),
  rule_id              text_100 NOT NULL,
  note                 text_1000,
  status               text NOT NULL CHECK (status IN (
                         'calculated', 'approved', 'payable', 'paid', 'cancelled')),
  approval_request_id  uuid REFERENCES approval_requests (id),
  paid_at              timestamptz(3),
  payment_reference    text_200,
  created_at           timestamptz(3) NOT NULL,
  created_by_type      actor_type NOT NULL,
  created_by_id        actor_id NOT NULL,
  updated_at           timestamptz(3) NOT NULL,
  version              integer NOT NULL CHECK (version >= 1),
  CONSTRAINT rewards_updated_after_created CHECK (updated_at >= created_at),
  -- Payouts always need the owner's approval (D-006).
  CONSTRAINT rewards_payout_approval_referenced CHECK (
    status NOT IN ('approved', 'payable', 'paid') OR approval_request_id IS NOT NULL),
  CONSTRAINT rewards_payment_complete CHECK ((paid_at IS NULL) = (payment_reference IS NULL)),
  CONSTRAINT rewards_payment_matches_status CHECK ((paid_at IS NOT NULL) = (status = 'paid'))
);
CREATE INDEX rewards_contributor_idx ON rewards (contributor_type, contributor_id);
CREATE INDEX rewards_approval_request_id_idx ON rewards (approval_request_id);

CREATE TABLE reward_contributions (
  reward_id        uuid NOT NULL REFERENCES rewards (id),
  contribution_id  uuid NOT NULL REFERENCES contributions (id),
  position         smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (reward_id, contribution_id),
  UNIQUE (reward_id, position)
);
CREATE INDEX reward_contributions_contribution_id_idx ON reward_contributions (contribution_id);

-- ---------------------------------------------------------------- History protection

-- Versioned entities: updates must be the next version; rows are never deleted.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources', 'signals', 'pains', 'opportunities', 'approval_requests', 'hypotheses',
    'experiments', 'contributions', 'rewards'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_versioned_update()',
      table_name || '_versioned_update', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_change()',
      table_name || '_no_delete', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_change()',
      table_name || '_no_truncate', table_name);
  END LOOP;

  -- Append-only records and every link table: no update, delete or truncate.
  FOREACH table_name IN ARRAY ARRAY[
    'evidence', 'decisions', 'cost_entries', 'knowledge_assets',
    'signal_evidence', 'pain_signals', 'pain_evidence', 'opportunity_pains', 'decision_evidence',
    'knowledge_asset_evidence', 'experiment_result_assets', 'reward_contributions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_change()',
      table_name || '_append_only', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_change()',
      table_name || '_no_truncate', table_name);
  END LOOP;
END;
$$;
