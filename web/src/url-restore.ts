import type { LinkState } from "./store";
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
  link: LinkState | null;
  camera: "fly" | "none";
}

/** Resolve both ends before applying a linked URL; never degrade it to a
 * normal selection merely because one stable key has not streamed in yet. */
export async function resolveUrlSelection(
  urlState: UrlState,
  locate: TargetLocator,
): Promise<ResolvedUrlSelection | null> {
  const target = await locate(urlState.key, urlState.rank);
  if (!target) return null;

  let link: LinkState | null = null;
  if (urlState.link) {
    const source = await locate(
      urlState.link.fromKey,
      urlState.link.fromRank,
    );
    if (!source) return null;
    link = { ...urlState.link, fromRank: source.rank };
  }
  return {
    ...target,
    link,
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
  if (!point || (key !== null && point.key !== key)) return null;
  return { key: point.key, rank: rankHint };
}
