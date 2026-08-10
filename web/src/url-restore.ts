import type { UrlState } from "./url";

export interface LocatedTarget {
  key: number;
  rank: number;
}

export type TargetLocator = (
  key: number | null,
  rankHint: number | null,
) => Promise<LocatedTarget | null>;

export interface ResolvedUrlSelection extends LocatedTarget {
  camera: "fly" | "none";
}

export async function resolveUrlSelection(
  urlState: UrlState,
  locate: TargetLocator,
): Promise<ResolvedUrlSelection | null> {
  const target = await locate(urlState.key, urlState.rank);
  if (!target) return null;
  return {
    ...target,
    camera: urlState.view ? "none" : "fly",
  };
}

/** Prefer a stable-key lookup. The saved rank is only a hint and is accepted
 * after checking that the record still carries the expected key. */
export async function locateStableTarget(
  key: number | null,
  rankHint: number | null,
  rankOfKey: (stableKey: number) => number | null,
  pointAtRank: (rank: number) => Promise<{ key: number } | null>,
): Promise<LocatedTarget | null> {
  if (key !== null) {
    const loadedRank = rankOfKey(key);
    if (loadedRank !== null) return { key, rank: loadedRank };
  }
  if (rankHint === null) return null;
  const point = await pointAtRank(rankHint);
  if (point && (key === null || point.key === key))
    return { key: point.key, rank: rankHint };

  // Geometry may have advanced to (or reached) the stable key while the
  // range hint was in flight. Recheck before declaring the URL unresolved.
  if (key !== null) {
    const loadedRank = rankOfKey(key);
    if (loadedRank !== null) return { key, rank: loadedRank };
  }
  return null;
}
