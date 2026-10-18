import type { CountryCode, EvidenceKind, Timestamp } from '@roi-dealer/domain';

/** One usable item a source returned, before redaction. */
export interface CollectedItem {
  /** Id at the source; repeated collection skips known ids. */
  readonly externalId: string;
  readonly kind: EvidenceKind;
  /** Plain text as published; redacted by the engine before it is stored. */
  readonly text: string;
  /** Link to the original item (not to its author). */
  readonly url?: string;
  readonly observedAt: Timestamp;
  readonly language?: string;
  readonly market?: CountryCode;
}

export interface FetchRequest {
  /** At most this many new items per load (catalog `limits.maxItemsPerRun`). */
  readonly maxItems: number;
  /** Which of these ids are already stored. */
  readonly known: (externalIds: readonly string[]) => Promise<ReadonlySet<string>>;
  readonly signal?: AbortSignal | undefined;
}

export interface ConnectorRun {
  /** The main request, without credentials (stored in the snapshot). */
  readonly requestUrl: string;
  /** SHA-256 of the raw responses in request order. */
  readonly contentSha256: string;
  /** New items the source returned, usable or not (deleted, empty). */
  readonly itemCount: number;
  readonly items: readonly CollectedItem[];
}

/** Reads one catalog source through its official access method (§2.21). */
export interface SourceConnector {
  readonly catalogKey: string;
  fetch(request: FetchRequest): Promise<ConnectorRun>;
}
