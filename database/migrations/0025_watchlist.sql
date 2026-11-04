-- 0025_watchlist — the watchlist of cut-off pains (phase 27, ADR-0013).
--
-- watch_decisions: the owner's answer when a cut pain came back stronger in new similar pains:
-- 'returned' (look again at the similar pain) or 'kept' (stay cut until it doubles again).
-- The latest answer per cut pain applies. Ids and numbers only.

CREATE TABLE watch_decisions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decided_at     timestamptz(3) NOT NULL DEFAULT now(),
  pain_id        uuid NOT NULL REFERENCES pains (id),
  echo_pain_id   uuid NOT NULL REFERENCES pains (id),
  decision       text NOT NULL CHECK (decision IN ('returned', 'kept')),
  signals        integer NOT NULL CHECK (signals >= 0),
  actor_id       text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  correlation_id text,
  CONSTRAINT watch_decisions_other_pain CHECK (echo_pain_id <> pain_id)
);
CREATE INDEX watch_decisions_pain_idx ON watch_decisions (pain_id, id DESC);
COMMENT ON TABLE watch_decisions IS
  'Append-only journal: the owner returns a cut pain to review or keeps it cut (phase 27).';

CREATE TRIGGER watch_decisions_append_only BEFORE UPDATE OR DELETE
  ON watch_decisions FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER watch_decisions_no_truncate BEFORE TRUNCATE ON watch_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
