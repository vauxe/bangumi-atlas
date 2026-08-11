export type QueryHighlights =
  | {
      encoding: "ranks-u32";
      nodeCount: number;
      count: number;
      ranks: Uint32Array;
    }
  | {
      encoding: "rank-bitset";
      nodeCount: number;
      count: number;
      bits: Uint8Array;
    };

function bitsetBytes(nodeCount: number): number {
  return Math.ceil(nodeCount / 8);
}

function assertNodeCount(nodeCount: number): void {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || nodeCount > 0xffffffff)
    throw new TypeError("query highlight node count is invalid");
}

/** Builds the smaller of a sorted u32 rank list and a fixed-universe bitset. */
export class QueryHighlightBuilder {
  private sparse: Set<number> | null = new Set();
  private bits: Uint8Array | null = null;
  private count = 0;

  constructor(private readonly nodeCount: number) {
    assertNodeCount(nodeCount);
  }

  add(rank: number): void {
    if (!Number.isSafeInteger(rank) || rank < 0 || rank >= this.nodeCount)
      throw new TypeError("query highlight rank is invalid");
    if (this.bits) {
      const byte = rank >> 3;
      const mask = 1 << (rank & 7);
      if ((this.bits[byte]! & mask) !== 0) return;
      this.bits[byte] = this.bits[byte]! | mask;
      this.count++;
      return;
    }
    const before = this.sparse!.size;
    this.sparse!.add(rank);
    if (this.sparse!.size === before) return;
    this.count++;
    if (this.count * Uint32Array.BYTES_PER_ELEMENT <= bitsetBytes(this.nodeCount))
      return;
    this.bits = new Uint8Array(bitsetBytes(this.nodeCount));
    for (const item of this.sparse!)
      this.bits[item >> 3] = this.bits[item >> 3]! | (1 << (item & 7));
    this.sparse = null;
  }

  finish(): QueryHighlights {
    if (this.bits)
      return {
        encoding: "rank-bitset",
        nodeCount: this.nodeCount,
        count: this.count,
        bits: this.bits,
      };
    return {
      encoding: "ranks-u32",
      nodeCount: this.nodeCount,
      count: this.count,
      ranks: Uint32Array.from([...this.sparse!].sort((a, b) => a - b)),
    };
  }
}

function popcount(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    let value = byte;
    while (value) {
      value &= value - 1;
      count++;
    }
  }
  return count;
}

export function validateQueryHighlights(value: unknown): QueryHighlights {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid query highlights");
  const candidate = value as Partial<QueryHighlights>;
  const validHeader = Number.isSafeInteger(candidate.nodeCount) &&
    (candidate.nodeCount ?? -1) >= 0 &&
    (candidate.nodeCount ?? Number.POSITIVE_INFINITY) <= 0xffffffff &&
    Number.isSafeInteger(candidate.count) &&
    (candidate.count ?? -1) >= 0 &&
    (candidate.count ?? Number.POSITIVE_INFINITY) <= (candidate.nodeCount ?? -1);
  if (!validHeader) throw new TypeError("invalid query highlights");
  const nodeCount = candidate.nodeCount as number;
  const count = candidate.count as number;
  if (candidate.encoding === "ranks-u32") {
    const ranks = (candidate as Partial<Extract<QueryHighlights, {
      encoding: "ranks-u32";
    }>>).ranks;
    if (!(ranks instanceof Uint32Array) || ranks.length !== count)
      throw new TypeError("invalid query highlights");
    let previous = -1;
    for (const rank of ranks) {
      if (rank <= previous || rank >= nodeCount)
        throw new TypeError("invalid query highlights");
      previous = rank;
    }
    return candidate as QueryHighlights;
  }
  if (candidate.encoding === "rank-bitset") {
    const bits = (candidate as Partial<Extract<QueryHighlights, {
      encoding: "rank-bitset";
    }>>).bits;
    if (!(bits instanceof Uint8Array) || bits.byteLength !== bitsetBytes(nodeCount))
      throw new TypeError("invalid query highlights");
    for (let rank = nodeCount; rank < bits.byteLength * 8; rank++)
      if ((bits[rank >> 3]! & (1 << (rank & 7))) !== 0)
        throw new TypeError("invalid query highlights");
    if (popcount(bits) !== count)
      throw new TypeError("invalid query highlights");
    return candidate as QueryHighlights;
  }
  throw new TypeError("invalid query highlights");
}

export function queryHighlightRanks(highlights: QueryHighlights): Uint32Array {
  if (highlights.encoding === "ranks-u32") return highlights.ranks;
  const ranks = new Uint32Array(highlights.count);
  let index = 0;
  for (let rank = 0; rank < highlights.nodeCount; rank++)
    if ((highlights.bits[rank >> 3]! & (1 << (rank & 7))) !== 0)
      ranks[index++] = rank;
  return ranks;
}

export function mergeQueryHighlights(
  highlights: readonly QueryHighlights[],
): Uint32Array {
  if (!highlights.length) return new Uint32Array();
  for (const item of highlights) validateQueryHighlights(item);
  if (highlights.length === 1)
    return queryHighlightRanks(highlights[0] as QueryHighlights);
  const nodeCount = highlights[0]!.nodeCount;
  if (highlights.some((item) => item.nodeCount !== nodeCount))
    throw new TypeError("query highlight releases do not match");
  const bits = new Uint8Array(bitsetBytes(nodeCount));
  for (const item of highlights) {
    if (item.encoding === "rank-bitset") {
      for (let index = 0; index < bits.length; index++)
        bits[index] = bits[index]! | item.bits[index]!;
    } else {
      for (const rank of item.ranks)
        bits[rank >> 3] = bits[rank >> 3]! | (1 << (rank & 7));
    }
  }
  const count = popcount(bits);
  return queryHighlightRanks({
    encoding: "rank-bitset",
    nodeCount,
    count,
    bits,
  });
}

export function queryHighlightTransferables(
  highlights: QueryHighlights,
): Transferable[] {
  return [
    highlights.encoding === "ranks-u32"
      ? highlights.ranks.buffer
      : highlights.bits.buffer,
  ];
}
