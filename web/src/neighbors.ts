import type { AdjEntry } from "./types";

/**
 * Select globally hottest unique neighbor nodes. A neighbor may occur in
 * several relation groups; its first published group remains the primary
 * edge label while the drawer continues to expose every group.
 */
export function uniqueNeighbors(
  adj: AdjEntry | null,
  cap = 50,
): { ranks: number[]; labels: number[] } {
  if (!adj || cap <= 0) return { ranks: [], labels: [] };
  const primary = new Map<number, number>();
  for (const [label, , ranks] of adj.g)
    for (const rank of ranks)
      if (!primary.has(rank)) primary.set(rank, label);

  const selected = [...primary]
    .sort(([rankA], [rankB]) => rankA - rankB)
    .slice(0, cap);
  return {
    ranks: selected.map(([rank]) => rank),
    labels: selected.map(([, label]) => label),
  };
}
