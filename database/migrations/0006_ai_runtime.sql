-- 0006_ai_runtime — journal of AI calls (PHASE 09, ADR-0006).
--
-- Every attempt of an AI task — successful or not, real work or an eval run — is one row: which
-- task and prompt version, which provider (Anthropic, OpenAI, Google — D-021) and model, tokens,
-- cost in micro-USD, latency and the class of failure. Limits (D-007: $50 a month, spread over the
-- days; at most $20 a day), the share of each task and the daily CostEntry are computed from it.
-- Like access_log, it is an append-only log, not an entity. Prompts, outputs and keys are never
-- stored.

CREATE TABLE ai_calls (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz(3) NOT NULL DEFAULT now(),
  task            text NOT NULL CHECK (task ~ '^[a-z][a-z0-9-]{1,47}$'),
  task_version    integer NOT NULL CHECK (task_version >= 1),
  purpose         text NOT NULL CHECK (purpose IN ('task', 'eval')),
  provider        text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  model           text NOT NULL CHECK (model ~ '^[A-Za-z0-9._:-]{1,64}$'),
  input_tokens    integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens   integer NOT NULL CHECK (output_tokens >= 0),
  -- Millionths of a US dollar: a call costs fractions of a cent.
  cost_micro_usd  bigint NOT NULL CHECK (cost_micro_usd >= 0),
  latency_ms      integer NOT NULL CHECK (latency_ms >= 0),
  outcome         text NOT NULL CHECK (outcome IN ('ok', 'failed')),
  failure         text CHECK (failure IN (
                    'rate_limited', 'timeout', 'server_error', 'invalid_output', 'refusal',
                    'model_unavailable', 'auth', 'bad_request')),
  actor_type      actor_type NOT NULL,
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT ai_calls_failure_for_failed CHECK ((failure IS NOT NULL) = (outcome = 'failed'))
);
CREATE INDEX ai_calls_occurred_at_idx ON ai_calls (occurred_at);
-- The daily share of one task (PHASE 09).
CREATE INDEX ai_calls_task_occurred_at_idx ON ai_calls (task, occurred_at);
COMMENT ON TABLE ai_calls IS
  'Append-only journal of AI calls: tokens, cost in micro-USD, latency and failure class (PHASE 09).';

CREATE TRIGGER ai_calls_append_only BEFORE UPDATE OR DELETE ON ai_calls
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER ai_calls_no_truncate BEFORE TRUNCATE ON ai_calls
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
