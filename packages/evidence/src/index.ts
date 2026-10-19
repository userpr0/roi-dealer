/**
 * @roi-dealer/evidence — Evidence Engine (PHASE 05, D-014 п.5–6, §2.5, §2.20, §2.21).
 *
 * A source catalog with checked terms, connectors for permitted official APIs, redaction of
 * personal data before anything is stored, and collection: kill switch → catalog → owner's
 * grant → fetch → redact → snapshot + Evidence with provenance, written by the integration.
 */
export {
  ACCESS_METHODS,
  accessRequestFor,
  AUTHENTICATION_KINDS,
  CATALOG_VERDICTS,
  catalogEntrySchema,
  connectableEntry,
  findCatalogEntry,
  integrationActor,
  PERSONAL_DATA_RISKS,
  SOURCE_CATALOG,
  sourceFor,
  type CatalogEntry,
  type CatalogVerdict,
} from './catalog.js';
export {
  collectEvidence,
  ensureConnection,
  EVIDENCE_ENGINE_ACTOR,
  MAX_EXCERPT_LENGTH,
  type CollectOutcome,
  type Connection,
  type EngineDeps,
  type EnsureAccess,
  type SkipReason,
} from './collect.js';
export type { CollectedItem, ConnectorRun, FetchRequest, SourceConnector } from './connector.js';
export { EvidenceEngineError, type EvidenceEngineErrorCode } from './errors.js';
export {
  createHackerNewsConnector,
  HACKER_NEWS_API_URL,
  HACKER_NEWS_CATALOG_KEY,
  type HackerNewsOptions,
} from './hacker-news.js';
export {
  createHackerNewsSearchConnector,
  HACKER_NEWS_SEARCH_URL,
  MAX_QUERY_LENGTH,
} from './hacker-news-search.js';
export { htmlToText } from './html.js';
export {
  REDACTION_KINDS,
  redactionTotal,
  redactPersonalData,
  type Redacted,
  type RedactionKind,
} from './privacy.js';
export {
  createEvidenceScheduler,
  type EvidenceScheduler,
  type EvidenceSchedulerOptions,
} from './scheduler.js';

export const PACKAGE_NAME = '@roi-dealer/evidence';
