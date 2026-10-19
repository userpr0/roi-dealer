/** Why the evidence engine refused or failed (PHASE 05). */
export type EvidenceEngineErrorCode =
  /** The connector's source has no catalog entry. */
  | 'not_cataloged'
  /** The catalog entry's verdict is not `allowed` (§2.21). */
  | 'not_allowed'
  /** The source answered with an HTTP error or could not be reached. */
  | 'fetch_failed'
  /** The source answered with data of an unexpected shape. */
  | 'bad_response'
  /** The connector was called without what it needs, e.g. a search without words. */
  | 'bad_request';

/** Carries a stable `code` and never the content that was fetched. */
export class EvidenceEngineError extends Error {
  override readonly name = 'EvidenceEngineError';
  readonly code: EvidenceEngineErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: EvidenceEngineErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
