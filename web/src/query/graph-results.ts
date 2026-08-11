import { parseEntityRef } from "./contract";
import type { QueryGraphEntityRef } from "./engine";

export interface QueryGraphResolver {
  episodeSubjectKey(id: number): Promise<number | null>;
  rankOfKey(key: number): number | null;
}

export function queryGraphEntityKey(ref: QueryGraphEntityRef): number | null {
  const entity = parseEntityRef(ref);
  if (entity.owner === "episode" || entity.archiveId > 0xffffff) return null;
  const kind = entity.owner === "subject" ? 1
    : entity.owner === "person" ? 2
      : 3;
  return (kind << 24) | entity.archiveId;
}

/** Resolve query answer entities to the nodes present on the star map. */
export async function queryResultGraphRanks(
  refs: readonly string[],
  resolver: QueryGraphResolver,
): Promise<number[]> {
  const resolved = await Promise.all(refs.map(async (ref) => {
    const entity = parseEntityRef(ref);
    let key: number | null;
    if (entity.owner === "episode") {
      key = await resolver.episodeSubjectKey(entity.archiveId);
    } else key = queryGraphEntityKey(ref as QueryGraphEntityRef);
    return key === null ? null : resolver.rankOfKey(key);
  }));
  const ranks = new Set<number>();
  for (const rank of resolved)
    if (rank !== null) ranks.add(rank);
  return [...ranks];
}
