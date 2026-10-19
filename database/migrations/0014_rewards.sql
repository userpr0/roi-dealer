-- 0014_rewards — the Reward Engine's guard in the database (PHASE 17, §2.10).
--
-- A reward links contributions when it is created (reward_contributions is append-only). Each
-- linked contribution must be verified, belong to the reward's person and not be part of
-- another reward that is not cancelled. The contribution row is locked, so two rewards of the
-- same contribution cannot be created at the same time.

CREATE FUNCTION check_reward_contribution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  contribution record;
  reward record;
BEGIN
  SELECT status, contributor_type, contributor_id INTO contribution
    FROM contributions WHERE id = NEW.contribution_id FOR UPDATE;
  SELECT contributor_type, contributor_id INTO reward
    FROM rewards WHERE id = NEW.reward_id;
  IF contribution.status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'contribution % is not verified', NEW.contribution_id
      USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'reward_contributions_verified';
  END IF;
  IF contribution.contributor_type IS DISTINCT FROM reward.contributor_type
     OR contribution.contributor_id IS DISTINCT FROM reward.contributor_id THEN
    RAISE EXCEPTION 'contribution % belongs to another contributor', NEW.contribution_id
      USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'reward_contributions_same_contributor';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reward_contributions AS link
      JOIN rewards ON rewards.id = link.reward_id
     WHERE link.contribution_id = NEW.contribution_id
       AND link.reward_id <> NEW.reward_id
       AND rewards.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'contribution % is already rewarded', NEW.contribution_id
      USING ERRCODE = 'unique_violation', TABLE = TG_TABLE_NAME,
            CONSTRAINT = 'reward_contributions_rewarded_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reward_contributions_check BEFORE INSERT ON reward_contributions
  FOR EACH ROW EXECUTE FUNCTION check_reward_contribution();
