import { parseEntityRef } from "./contract";

export interface QueryGraphResolver {
  episodeSubjectKey(id: number): Promise<number | null>;
  rankOfKey(key: number): number | null;
}

/** Resolve currently rendered answer entities to the nodes present on the star map. */
export async function queryResultGraphRanks(
  refs: readonly string[],
  resolver: QueryGraphResolver,
): Promise<number[]> {
  const resolved = await Promise.all(refs.map(async (ref) => {
    const entity = parseEntityRef(ref);
    let key: number | null;
    if (entity.owner === "episode") {
      key = await resolver.episodeSubjectKey(entity.archiveId);
    } else if (entity.archiveId <= 0xffffff) {
      const kind = entity.owner === "subject" ? 1
        : entity.owner === "person" ? 2
          : 3;
      key = (kind << 24) | entity.archiveId;
    } else {
      key = null;
    }
    return key === null ? null : resolver.rankOfKey(key);
  }));
  const ranks = new Set<number>();
  for (const rank of resolved)
    if (rank !== null) ranks.add(rank);
  return [...ranks];
}
