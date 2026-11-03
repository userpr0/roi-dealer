-- 0020_backup_watch — the watchdog also watches the nightly backup (D-029, ADR-0010).
--
-- After a successful dump (and its copy into the reserve database) infra/hetzner/backup.sh
-- leaves one mark as the service 'backup'. The bot's watchdog tells the owner once when no
-- backup has succeeded for 26 hours, and once when one succeeds again.

ALTER TABLE service_heartbeats DROP CONSTRAINT service_heartbeats_service_check;
ALTER TABLE service_heartbeats ADD CONSTRAINT service_heartbeats_service_check
  CHECK (service IN ('bot', 'worker', 'api', 'backup'));
COMMENT ON TABLE service_heartbeats IS
  'The last mark of each running service, and of the last successful backup (13c, 0020).';
