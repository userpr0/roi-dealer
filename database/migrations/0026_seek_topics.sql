-- 0026_seek_topics — topics the owner asks the research agent to search (/seek).
--
-- seek_topics: a plain-words query the owner gave (letters and digits only, like every search).
-- seek_runs: the one search of each topic and how much evidence it brought. Ids, words, numbers.

CREATE TABLE seek_topics (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  query          text NOT NULL CHECK (query ~ '^[a-z0-9]+( [a-z0-9]+){1,7}$' AND char_length(query) <= 100),
  actor_id       text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  correlation_id text
);
COMMENT ON TABLE seek_topics IS 'Append-only journal: topics the owner asked to search (/seek).';

CREATE TABLE seek_runs (
  topic_id  bigint PRIMARY KEY REFERENCES seek_topics (id),
  ran_at    timestamptz(3) NOT NULL DEFAULT now(),
  evidence  integer NOT NULL CHECK (evidence >= 0)
);
COMMENT ON TABLE seek_runs IS 'Append-only journal: the one search of each owner topic.';

CREATE TRIGGER seek_topics_append_only BEFORE UPDATE OR DELETE
  ON seek_topics FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER seek_topics_no_truncate BEFORE TRUNCATE ON seek_topics
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER seek_runs_append_only BEFORE UPDATE OR DELETE
  ON seek_runs FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER seek_runs_no_truncate BEFORE TRUNCATE ON seek_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
