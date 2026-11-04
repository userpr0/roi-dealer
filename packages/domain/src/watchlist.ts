/*
 * The watchlist (phase 27, ADR-0013): a pain the owner cut off stays watched. When new similar
 * pains gather strength from sources the cut pain never had, the owner is asked whether to look
 * again. Code counts; the owner decides.
 */

/** New similar signals needed before the owner is asked, at least. */
export const WATCH_MIN_SIGNALS = 2;

/** What the cut pain had when it was cut off. */
export interface WatchSnapshot {
  readonly signals: number;
  readonly sources: readonly string[];
}

/** A new open pain similar to the cut one. */
export interface WatchEcho {
  readonly signals: number;
  readonly sources: readonly string[];
}

export interface WatchGrowth {
  /** Signals of the similar new pains together. */
  readonly signals: number;
  /** Their sources that the cut pain never had. */
  readonly newSources: readonly string[];
  /** Ask the owner: at least twice the cut pain's signals (and the last level the owner kept), from a new source. */
  readonly growing: boolean;
}

export function watchGrowth(
  snapshot: WatchSnapshot,
  echoes: readonly WatchEcho[],
  keptAtSignals = 0,
): WatchGrowth {
  const signals = echoes.reduce((sum, echo) => sum + echo.signals, 0);
  const known = new Set(snapshot.sources);
  const newSources = [...new Set(echoes.flatMap((echo) => echo.sources))]
    .filter((source) => !known.has(source))
    .sort();
  const bar = Math.max(WATCH_MIN_SIGNALS, 2 * snapshot.signals, 2 * keptAtSignals);
  return { signals, newSources, growing: signals >= bar && newSources.length > 0 };
}
