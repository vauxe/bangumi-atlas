import {
  QueryHighlightBuilder,
  type QueryHighlights,
} from "./highlights";
import type { QueryDocument } from "./document";

export interface QueryHighlightResolverDependencies {
  nodeCount: number;
  loadedEntityKeys(): Uint32Array | null;
  ensureRankIndex(): Promise<void>;
  rankOfKey(key: number): number | null;
}

interface KeyReuseAnalysis {
  bounded: boolean;
  loadsKeys: boolean;
}

const NO_KEY_REUSE: KeyReuseAnalysis = { bounded: false, loadsKeys: false };

/** Structural name lookup loads key.bin while producing candidates. Require
 * every result-producing leaf to be lookup-bounded (or finite Values) so a
 * nested/unrelated lookup cannot move a full scan onto the Set-backed path. */
export function queryCanReuseLoadedEntityKeys(
  document: QueryDocument,
): boolean {
  const memo = new Map<string, KeyReuseAnalysis>();
  const visiting = new Set<string>();
  const analyze = (id: string): KeyReuseAnalysis => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return NO_KEY_REUSE;
    const operator = document.operators[id];
    if (!operator) return NO_KEY_REUSE;
    visiting.add(id);
    let result: KeyReuseAnalysis;
    if (operator.kind === "lookup") {
      result = operator.owner === "episode"
        ? NO_KEY_REUSE
        : { bounded: true, loadsKeys: true };
    } else if (operator.kind === "values") {
      result = { bounded: true, loadsKeys: false };
    } else if ("branches" in operator) {
      const branches = operator.branches.map((branch) => analyze(branch.input));
      result = {
        bounded: branches.every((branch) => branch.bounded),
        loadsKeys: branches.some((branch) => branch.loadsKeys),
      };
    } else if ("input" in operator) {
      result = analyze(operator.input);
    } else {
      result = NO_KEY_REUSE;
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  const root = analyze(document.root);
  return root.bounded && root.loadsKeys;
}

/** Resolve stable graph keys to visual ranks without duplicating an index that
 * the query path has already loaded. */
export async function resolveQueryHighlights(
  keys: ReadonlySet<number>,
  dependencies: QueryHighlightResolverDependencies,
): Promise<QueryHighlights> {
  const highlights = new QueryHighlightBuilder(dependencies.nodeCount);
  if (!keys.size) return highlights.finish();

  const keysByRank = dependencies.loadedEntityKeys();
  if (keysByRank) {
    if (keysByRank.length !== dependencies.nodeCount)
      throw new TypeError("query entity key index does not match node count");
    for (let rank = 0; rank < keysByRank.length; rank++)
      if (keys.has(keysByRank[rank]!)) highlights.add(rank);
    return highlights.finish();
  }

  await dependencies.ensureRankIndex();
  for (const key of keys) {
    const rank = dependencies.rankOfKey(key);
    if (rank !== null) highlights.add(rank);
  }
  return highlights.finish();
}
