import {
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  changeSourceStatus,
  createEvidence,
  createSource,
  createSourceSnapshot,
  DomainError,
  evidenceIdSchema,
  sourceIdSchema,
  sourceSnapshotIdSchema,
  timestampMs,
  toTimestamp,
  type Actor,
  type Evidence,
  type NewPrincipal,
  type Principal,
  type Source,
  type SourceSnapshotId,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConstraintViolationError, type Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import {
  accessRequestFor,
  connectableEntry,
  integrationActor,
  sourceFor,
  SOURCE_CATALOG,
  type CatalogEntry,
} from './catalog.js';
import type { SourceConnector } from './connector.js';
import { redactionTotal, redactPersonalData } from './privacy.js';

/** Stored quotes stay short (§2.20: evidence of a pattern, not a copy of the material). */
export const MAX_EXCERPT_LENGTH = 1_000;

/** The platform's own actor for setting up sources. */
export const EVIDENCE_ENGINE_ACTOR: Actor = { type: 'system', id: 'evidence-engine' };

export interface EngineDeps {
  readonly database: Database;
  readonly logger: Logger;
  /** Default: `Date.now`. */
  readonly now?: () => number;
  /** Default: `SOURCE_CATALOG`; tests pass their own entries. */
  readonly catalog?: readonly CatalogEntry[];
  /**
   * Second pass after the rules (PHASE 09): replaces the names of people, e.g. with the
   * `redact-names` AI task. Throws when it cannot run; the rule-based text is kept then.
   */
  readonly redactNames?:
    ((text: string) => Promise<{ readonly text: string; readonly replaced: number }>) | undefined;
}

/** Kill switch (13b): every automation checks it as its first step. */
async function assertRunning(database: Database): Promise<void> {
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined)
    throw new Error('the automation kill switch is missing (migration 0003)');
  assertAutomationRunning(control);
}

function nowTimestamp(deps: EngineDeps): Timestamp {
  return toTimestamp(new Date((deps.now ?? Date.now)()));
}

// ---------------------------------------------------------------- Connecting a source

/** Asks the owner for an integration's access; `ensureAccessRequest` of the command center. */
export type EnsureAccess = (
  database: Database,
  data: NewPrincipal,
  options: { readonly at: Timestamp; readonly correlationId?: string | undefined },
) => Promise<{ readonly state: string; readonly principal: Principal }>;

export interface Connection {
  readonly source: Source;
  /** `requested`, `waiting`, `renewed`, `active`, `suspended` or `revoked`. */
  readonly access: string;
}

/**
 * Sets up a catalog source (§2.7, §2.21): creates its source record and asks the owner for the
 * integration's access in /decisions. A refused integration's source is retired.
 */
export async function ensureConnection(
  catalogKey: string,
  deps: EngineDeps & { readonly ensureAccess: EnsureAccess },
): Promise<Connection> {
  const { database } = deps;
  await assertRunning(database);
  const entry = connectableEntry(catalogKey, deps.catalog ?? SOURCE_CATALOG);
  const at = nowTimestamp(deps);

  let source = await database.repositories.sources.getByCatalogKey(entry.key);
  if (source === undefined) {
    const created = createSource(sourceFor(entry), {
      id: sourceIdSchema.parse(uuidv7()),
      actor: EVIDENCE_ENGINE_ACTOR,
      at,
    });
    try {
      await database.repositories.sources.insert(created);
      source = created;
    } catch (error) {
      // Another worker created it at the same time.
      if (
        !(error instanceof ConstraintViolationError) ||
        error.constraint !== 'sources_catalog_key_key'
      ) {
        throw error;
      }
      source = await database.repositories.sources.getByCatalogKey(entry.key);
      if (source === undefined) throw error;
    }
  }

  const { state, principal } = await deps.ensureAccess(database, accessRequestFor(entry), {
    at,
    correlationId: `evidence-connect-${entry.key}`,
  });
  if (principal.status === 'revoked' && source.status !== 'retired') {
    const retired = changeSourceStatus(source, 'retired', { actor: EVIDENCE_ENGINE_ACTOR, at });
    await database.repositories.sources.update(retired, EVIDENCE_ENGINE_ACTOR);
    source = retired;
    deps.logger.info('evidence source retired: access refused', { catalog_key: entry.key });
  }
  return { source, access: state };
}

// ---------------------------------------------------------------- Collecting

export type SkipReason =
  'source_missing' | 'source_inactive' | 'access_missing' | 'access_not_active' | 'nothing_new';

export type CollectOutcome =
  | {
      readonly status: 'collected';
      readonly snapshotId: SourceSnapshotId;
      readonly itemCount: number;
      readonly evidenceCount: number;
      readonly redactions: number;
    }
  | { readonly status: 'skipped'; readonly reason: SkipReason };

function shortExcerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/**
 * One load from a catalog source: kill switch → catalog → source → access → fetch → redact →
 * the snapshot and its evidence in one transaction, written by the integration's identity.
 * Nothing is requested from the source unless the owner has granted the integration.
 */
export async function collectEvidence(
  connector: SourceConnector,
  deps: EngineDeps & { readonly signal?: AbortSignal | undefined },
): Promise<CollectOutcome> {
  const { database, logger } = deps;
  await assertRunning(database);
  const entry = connectableEntry(connector.catalogKey, deps.catalog ?? SOURCE_CATALOG);

  const source = await database.repositories.sources.getByCatalogKey(entry.key);
  if (source === undefined) return { status: 'skipped', reason: 'source_missing' };
  if (source.status !== 'active') return { status: 'skipped', reason: 'source_inactive' };
  const actor = integrationActor(entry);
  const principal = await database.repositories.principals.getByActor(actor);
  if (principal === undefined) return { status: 'skipped', reason: 'access_missing' };
  if (principal.status !== 'active') return { status: 'skipped', reason: 'access_not_active' };

  const run = await connector.fetch({
    maxItems: entry.limits.maxItemsPerRun,
    known: (ids) => database.repositories.evidence.knownExternalIds(source.id, ids),
    signal: deps.signal,
  });
  if (run.itemCount === 0) return { status: 'skipped', reason: 'nothing_new' };

  const at = nowTimestamp(deps);
  const snapshotId = sourceSnapshotIdSchema.parse(uuidv7());
  let redactions = 0;
  // After the first failure of the AI pass the rest of the load keeps the rule-based text,
  // so an unavailable provider costs one attempt, not one per item.
  let namesPass = deps.redactNames;
  const evidence: Evidence[] = [];
  for (const item of run.items) {
    // One item that cannot be stored safely is skipped; it must not stop the whole load.
    try {
      const redacted = redactPersonalData(item.text);
      // Only the stored excerpt is sent to the AI pass: fewer tokens, and nothing more leaves.
      let text = shortExcerpt(redacted.text);
      if (text !== '' && namesPass !== undefined) {
        try {
          const withoutNames = await namesPass(text);
          text = withoutNames.text;
          redactions += withoutNames.replaced;
        } catch (error) {
          namesPass = undefined;
          logger.warn('name redaction unavailable: rules only', {
            catalog_key: entry.key,
            code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown',
          });
        }
      }
      const excerpt = shortExcerpt(text);
      if (excerpt === '') continue;
      const observedAt = timestampMs(item.observedAt) <= timestampMs(at) ? item.observedAt : at;
      evidence.push(
        createEvidence(
          {
            sourceId: source.id,
            kind: item.kind,
            excerpt,
            ...(item.url === undefined ? {} : { url: item.url }),
            observedAt,
            ...(item.language === undefined ? {} : { language: item.language }),
            ...(item.market === undefined && entry.evidenceMarket === undefined
              ? {}
              : { market: item.market ?? entry.evidenceMarket }),
            snapshotId,
            externalId: item.externalId,
          },
          { id: evidenceIdSchema.parse(uuidv7()), actor, at },
        ),
      );
      redactions += redactionTotal(redacted);
    } catch (error) {
      // The message and code only: the item's text never reaches the logs.
      logger.warn('evidence item skipped', {
        catalog_key: entry.key,
        external_id: item.externalId,
        reason: error instanceof DomainError ? error.code : 'redaction_failed',
      });
    }
  }
  const snapshot = createSourceSnapshot(
    {
      sourceId: source.id,
      requestUrl: run.requestUrl,
      fetchedAt: at,
      contentSha256: run.contentSha256,
      itemCount: run.itemCount,
      evidenceCount: evidence.length,
    },
    { id: snapshotId, actor, at },
  );

  await database.transaction(
    async ({ repositories }) => {
      await repositories.sourceSnapshots.insert(snapshot);
      for (const item of evidence) await repositories.evidence.insert(item);
    },
    { correlationId: `evidence-collect-${snapshotId}` },
  );
  logger.info('evidence collected', {
    catalog_key: entry.key,
    item_count: run.itemCount,
    evidence_count: evidence.length,
    redactions,
  });
  return {
    status: 'collected',
    snapshotId,
    itemCount: run.itemCount,
    evidenceCount: evidence.length,
    redactions,
  };
}
