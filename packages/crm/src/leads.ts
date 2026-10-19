import {
  ConstraintViolationError,
  type Database,
  type TransactionScope,
} from '@roi-dealer/database';
import {
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  createLead,
  DomainError,
  eraseLeadContact,
  LEAD_RETENTION_DAYS,
  leadIdSchema,
  toTimestamp,
  type Actor,
  type Experiment,
  type Hypothesis,
  type LeadId,
  type MediaAsset,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';

/*
 * Leads (PHASE 20): a sign-up is the lead, its email and the funnel's `lead` event in one
 * transaction; deletion removes the email for real and marks the lead without personal data.
 */

export interface SignUp {
  readonly asset: Pick<MediaAsset, 'id'>;
  readonly experiment: Pick<Experiment, 'id' | 'hypothesisId' | 'opportunityId'>;
  readonly hypothesis: Pick<Hypothesis, 'channel'>;
  /** Normalized by `normalizeEmail`. */
  readonly email: string;
  readonly utm: Readonly<Record<string, string>>;
  readonly at: Timestamp;
  readonly correlationId?: string | undefined;
}

export type SignUpOutcome = 'created' | 'existing';

/**
 * Records a sign-up as `actor` (the page counter): a new lead, its email and the funnel's `lead`
 * step together. The same email in the same test is not a new lead.
 */
export async function captureLead(
  database: Pick<Database, 'transaction'>,
  signUp: SignUp,
  actor: Actor,
  newId: () => string = uuidv7,
): Promise<SignUpOutcome> {
  try {
    return await database.transaction(
      async (scope) => {
        const existing = await scope.leadContacts.leadOf(signUp.experiment.id, signUp.email, actor);
        if (existing !== undefined) return 'existing';
        const lead = createLead(
          {
            experimentId: signUp.experiment.id,
            hypothesisId: signUp.experiment.hypothesisId,
            opportunityId: signUp.experiment.opportunityId,
            mediaAssetId: signUp.asset.id,
            channel: signUp.hypothesis.channel,
            ...(signUp.utm['source'] === undefined ? {} : { utmSource: signUp.utm['source'] }),
            consentAt: signUp.at,
          },
          { id: leadIdSchema.parse(newId()), actor, at: signUp.at },
        );
        await scope.repositories.leads.insert(lead);
        await scope.leadContacts.add(
          {
            leadId: lead.id,
            experimentId: signUp.experiment.id,
            email: signUp.email,
            createdAt: signUp.at,
          },
          actor,
        );
        await scope.funnel.record(
          [
            {
              experimentId: signUp.experiment.id,
              hypothesisId: signUp.experiment.hypothesisId,
              stage: 'lead',
              quantity: 1,
              channel: signUp.hypothesis.channel,
              utm: signUp.utm,
              occurredAt: signUp.at,
              source: 'tracker',
            },
          ],
          actor,
          signUp.correlationId,
        );
        return 'created';
      },
      { correlationId: signUp.correlationId },
    );
  } catch (error) {
    // The same email sent twice at the same moment: the other request created the lead.
    if (
      error instanceof ConstraintViolationError &&
      error.constraint === 'lead_contacts_one_per_experiment'
    ) {
      return 'existing';
    }
    throw error;
  }
}

/** Deletes the emails of these leads and marks them erased, in the caller's transaction. */
export async function eraseContacts(
  scope: Pick<TransactionScope, 'repositories' | 'leadContacts'>,
  leadIds: readonly LeadId[],
  actor: Actor,
  at: Timestamp,
): Promise<number> {
  let erased = 0;
  for (const id of leadIds) {
    const lead = await scope.repositories.leads.getById(id);
    if (lead === undefined || lead.contactErasedAt !== undefined) continue;
    await scope.repositories.leads.update(eraseLeadContact(lead, { actor, at }), actor);
    erased += 1;
  }
  await scope.leadContacts.remove(leadIds, actor);
  return erased;
}

/** A person's deletion request: every email of theirs, in every test. */
export async function forgetEmail(
  scope: Pick<TransactionScope, 'repositories' | 'leadContacts'>,
  email: string,
  actor: Actor,
  at: Timestamp,
): Promise<number> {
  const leadIds = await scope.leadContacts.leadsByEmail(email, actor);
  return eraseContacts(scope, leadIds, actor, at);
}

/** The identity the retention period erases contacts as. */
export const LEAD_RETENTION: Actor = { type: 'system', id: 'lead-retention' };
const DAY_MS = 86_400_000;

/**
 * The retention period (PHASE 20): emails of leads that did not become customers are deleted
 * `LEAD_RETENTION_DAYS` after their test ended. The kill switch comes first.
 */
export async function purgeExpiredContacts(options: {
  readonly database: Pick<Database, 'repositories' | 'leadContacts' | 'transaction'>;
  readonly logger: Logger;
  readonly now: () => number;
}): Promise<{ readonly erased: number }> {
  const { database, logger } = options;
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) throw new Error('the automation kill switch is missing');
  assertAutomationRunning(control);
  const nowMs = options.now();
  const cutoff = toTimestamp(new Date(nowMs - LEAD_RETENTION_DAYS * DAY_MS));
  const expired = await database.leadContacts.expired(cutoff, LEAD_RETENTION);
  if (expired.length === 0) return { erased: 0 };
  const at = toTimestamp(new Date(nowMs));
  const erased = await database.transaction(
    (scope) => eraseContacts(scope, expired, LEAD_RETENTION, at),
    { correlationId: `lead-retention-${String(nowMs)}` },
  );
  logger.info('lead contacts erased after the retention period', { erased });
  return { erased };
}

export interface LeadRetention {
  start(): void;
  /** One pass; never throws. */
  runOnce(): Promise<{ readonly erased: number } | undefined>;
  stop(): Promise<void>;
}

/** The retention period on a schedule (PHASE 20): every 6 hours by default. */
export function createLeadRetention(options: {
  readonly database: Pick<Database, 'repositories' | 'leadContacts' | 'transaction'>;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}): LeadRetention {
  const { logger } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 6 * 3_600_000;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;

  async function runOnce(): Promise<{ readonly erased: number } | undefined> {
    try {
      return await purgeExpiredContacts({ database: options.database, logger, now });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'automation_paused') {
        logger.info('lead retention paused by the kill switch');
        return undefined;
      }
      logger.error('lead retention failed', { error });
      return undefined;
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = runOnce().finally(() => {
        running = undefined;
        schedule(intervalMs);
      });
    }, delayMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    runOnce,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
