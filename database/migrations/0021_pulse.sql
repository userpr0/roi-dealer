-- 0021_pulse — numeric demand series and the calendar of the "Pulse" (05c, ADR-0012).
--
-- metric_points: one value of a series per day, e.g. the daily views of a Wikipedia article.
-- calendar_events: public holidays, seasons and regulatory dates per market.
-- Journals of aggregates collected from catalog sources with verdict `allowed`: no people, no
-- free text from users, no events (like ai_calls and access_log). A repeated load updates the
-- stored value instead of adding rows.

CREATE TABLE metric_points (
  catalog_key  text NOT NULL CHECK (catalog_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- The series within the source, e.g. 'en:Tax_return' for an English Wikipedia article.
  series       text NOT NULL CHECK (char_length(series) BETWEEN 1 AND 200),
  -- A market of D-008 when the series belongs to one; null for a language-wide series.
  market       text CHECK (market ~ '^[A-Z]{2}$'),
  day          date NOT NULL,
  value        numeric NOT NULL CHECK (value >= 0),
  collected_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_key, series, day)
);
CREATE INDEX metric_points_day ON metric_points (day DESC);
COMMENT ON TABLE metric_points IS 'Daily values of demand series from catalog sources (05c).';

CREATE TABLE calendar_events (
  catalog_key  text NOT NULL CHECK (catalog_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  market       text NOT NULL CHECK (market ~ '^[A-Z]{2}$'),
  starts_on    date NOT NULL,
  ends_on      date,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  kind         text NOT NULL CHECK (kind IN ('holiday', 'season', 'regulatory')),
  source_url   text NOT NULL CHECK (source_url ~ '^https?://' AND char_length(source_url) <= 500),
  collected_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_key, market, starts_on, title),
  CONSTRAINT calendar_events_ends_after_start CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX calendar_events_starts ON calendar_events (starts_on);
COMMENT ON TABLE calendar_events IS 'Holidays, seasons and regulatory dates per market (05c).';
