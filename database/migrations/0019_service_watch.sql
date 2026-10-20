-- 0019_service_watch — the service watchdog (13c, D-023).
--
-- service_heartbeats: each service (bot, worker, api) marks once a minute that it runs, with
-- its version and what it has configured — names and switches only, never values or secrets.
-- service_incidents: what the bot's watchdog told the owner — a silent service, a service left
-- on another version, a rejected AI key — once each, and when it recovered.
-- Operational journals: not entities, no events (like access_log and ai_calls).

CREATE TABLE service_heartbeats (
  service     text PRIMARY KEY CHECK (service IN ('bot', 'worker', 'api')),
  version     text NOT NULL CHECK (version ~ '^[A-Za-z0-9._-]{1,64}$'),
  started_at  timestamptz(3) NOT NULL,
  seen_at     timestamptz(3) NOT NULL,
  -- What is configured, e.g. {"ai": ["anthropic"], "form": true}: names and switches only.
  setup       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(setup) = 'object' AND pg_column_size(setup) <= 1024),
  CONSTRAINT service_heartbeats_seen_after_start CHECK (seen_at >= started_at)
);
COMMENT ON TABLE service_heartbeats IS 'The last mark of each running service (13c).';

CREATE TABLE service_incidents (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('silent', 'version', 'ai_key')),
  -- The service (silent, version) or the AI provider (ai_key) concerned.
  subject       text NOT NULL CHECK (subject ~ '^[a-z]{1,20}$'),
  -- What identifies the incident: the last mark of a silent service, the expected version, the
  -- day of a rejected key. One open incident per kind and subject.
  detail        text NOT NULL CHECK (detail ~ '^[A-Za-z0-9._:-]{1,64}$'),
  opened_at     timestamptz(3) NOT NULL,
  resolved_at   timestamptz(3),
  CONSTRAINT service_incidents_resolved_after_open CHECK (
    resolved_at IS NULL OR resolved_at >= opened_at)
);
CREATE UNIQUE INDEX service_incidents_one_open ON service_incidents (kind, subject)
  WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX service_incidents_once ON service_incidents (kind, subject, detail);
CREATE INDEX service_incidents_opened ON service_incidents (opened_at DESC);
COMMENT ON TABLE service_incidents IS 'Incidents the watchdog reported to the owner (13c).';
