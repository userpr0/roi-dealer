-- 0010_agents — journals of the agents (PHASE 10).
--
-- agent_runs: one row per run of an agent (what it did, why it stopped), for /agents.
-- agent_work: one row per object version an agent worked on — the research agent per pain
-- version, the market context agent per opportunity version; a version is worked on once.
-- No texts: the result holds ids, counts and, for research, the checked search query.
-- Both append-only, like the other journals.

CREATE TABLE agent_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent           text NOT NULL CHECK (agent ~ '^[a-z][a-z0-9-]{1,39}$'),
  started_at      timestamptz(3) NOT NULL,
  finished_at     timestamptz(3) NOT NULL,
  -- done: worked on something; idle: nothing new; no_access: the owner has not granted (or has
  -- suspended) the agent; stopped: ended early (stopped_by); failed: an error ended the run.
  outcome         text NOT NULL CHECK (outcome IN ('done', 'idle', 'no_access', 'stopped', 'failed')),
  processed       integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  stopped_by      text CHECK (stopped_by IN ('budget', 'unavailable', 'failed')),
  -- A short error code (never a message or a text).
  failure         text CHECK (failure ~ '^[a-z0-9_]{1,64}$'),
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT agent_runs_finished_after_start CHECK (finished_at >= started_at),
  CONSTRAINT agent_runs_stopped_by_for_stopped CHECK ((stopped_by IS NOT NULL) = (outcome = 'stopped')),
  CONSTRAINT agent_runs_failure_for_failed CHECK ((failure IS NOT NULL) = (outcome = 'failed'))
);
CREATE INDEX agent_runs_agent_started_idx ON agent_runs (agent, started_at DESC);
COMMENT ON TABLE agent_runs IS 'Append-only journal: one row per run of an agent (PHASE 10).';

CREATE TABLE agent_work (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz(3) NOT NULL DEFAULT now(),
  agent           text NOT NULL CHECK (agent ~ '^[a-z][a-z0-9-]{1,39}$'),
  -- The object worked on; polymorphic, so no foreign key (like decisions.subject).
  subject_type    text NOT NULL CHECK (subject_type IN ('pain', 'opportunity')),
  subject_id      uuid NOT NULL,
  subject_version integer NOT NULL CHECK (subject_version >= 1),
  task            text NOT NULL CHECK (task ~ '^[a-z][a-z0-9-]{1,63}$'),
  task_version    integer NOT NULL CHECK (task_version >= 1),
  -- done: a result was stored; empty: nothing was found or confirmed; rejected: the answer
  -- failed the checks in code; failed: every model failed on this object.
  outcome         text NOT NULL CHECK (outcome IN ('done', 'empty', 'rejected', 'failed')),
  result          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  actor_type      actor_type NOT NULL,
  actor_id        actor_id NOT NULL,
  correlation_id  text CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT agent_work_version_once UNIQUE (agent, subject_type, subject_id, subject_version)
);
CREATE INDEX agent_work_occurred_at_idx ON agent_work (occurred_at);
CREATE INDEX agent_work_subject_idx ON agent_work (subject_type, subject_id);
COMMENT ON TABLE agent_work IS
  'Append-only journal: each object version an agent worked on, once, with its outcome (PHASE 10).';

CREATE TRIGGER agent_runs_append_only BEFORE UPDATE OR DELETE
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER agent_runs_no_truncate BEFORE TRUNCATE ON agent_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER agent_work_append_only BEFORE UPDATE OR DELETE
  ON agent_work FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER agent_work_no_truncate BEFORE TRUNCATE ON agent_work
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
