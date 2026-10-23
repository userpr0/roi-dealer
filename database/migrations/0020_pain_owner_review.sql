-- 0020_pain_owner_review — the owner's review of pains in /pains (D-030).
--
-- pains.owner_confirmed_at: the owner confirmed the pain («беру в работу»). It does not validate
-- the pain — that still needs evidence from two sources (§2.5) — it puts the pain first in the
-- opportunity engine's queue.
-- pain_translations: the pain's title and audience in Russian for the owner, proposed by the AI
-- after each run of the pain analyst. Display data only: kept apart from the pain so a
-- translation never makes a new pain version (no repeated assessments or agent work) and
-- matching keeps using the original text. One row per pain; no events (like ai_calls).

ALTER TABLE pains
  ADD COLUMN owner_confirmed_at timestamptz(3),
  ADD CONSTRAINT pains_confirmed_after_created CHECK (owner_confirmed_at >= created_at);

CREATE TABLE pain_translations (
  pain_id        uuid PRIMARY KEY REFERENCES pains (id),
  title_ru       text_200 NOT NULL,
  audience_ru    text_1000 NOT NULL,
  task_version   integer NOT NULL CHECK (task_version >= 1),
  translated_at  timestamptz(3) NOT NULL DEFAULT now()
);
COMMENT ON TABLE pain_translations IS
  'The Russian title and audience of each pain for the owner (D-030); display data, no events.';

CREATE TRIGGER pain_translations_no_truncate BEFORE TRUNCATE ON pain_translations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
