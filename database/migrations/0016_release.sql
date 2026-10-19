-- 0016_release — Solution Factory (PHASE 21, D-022): the Release Gate of a landing (§7.2).
--
-- A landing is released by the owner after the gate: the code checks pass and the owner
-- confirms the Early User Crash Test and that no blocking defect is known. The confirmed
-- checks and the release time are stored with the asset; a released asset always has both.

ALTER TABLE media_assets
  ADD COLUMN release_checks text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(release_checks) <= 2 AND array_is_set(release_checks)
    AND release_checks <@ ARRAY['crash_test', 'no_blockers']::text[]),
  ADD COLUMN released_at timestamptz(3),
  ADD CONSTRAINT media_assets_release_complete CHECK (
    (released_at IS NULL) = (cardinality(release_checks) = 0)),
  -- Released only with every check the owner confirms at the gate.
  ADD CONSTRAINT media_assets_release_confirmed CHECK (
    status <> 'released' OR cardinality(release_checks) = 2);
