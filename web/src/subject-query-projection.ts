import {
  loadEntityRanksById,
  loadSubjectQueryColumns,
  openNames,
  type SubjectQueryColumns,
} from "./loader";
import type { Manifest, NameRow } from "./types";

const SUBJECT_QUERY_COLUMN_CAPABILITY = "subject-query-columns-v1";
const SUBJECT_QUERY_COLUMN_FIELDS = new Set([
  "ref",
  "id",
  "name",
  "nameCn",
  "type",
  "year",
  "score",
  "nsfw",
]);
const SUBJECT_NAME_BLOCK_BATCH = 16;
const SUBJECT_QUERY_ENTITY_BATCH = 4096;
const MISSING_RANK = 0xffffff;
const MISSING_ID = 0xffffffff;

type SubjectQueryField = string | number | boolean | null;

export interface SubjectQueryProjection {
  kind: "subject";
  key: number;
  fields: Record<string, SubjectQueryField>;
}

export function canProjectSubjectQueryColumns(
  manifest: Manifest,
  owner: "subject" | "person" | "character",
  access: "stream" | "whole",
  fields: readonly string[],
): boolean {
  return owner === "subject" &&
    access === "whole" &&
    manifest.query?.capabilities.includes(
      SUBJECT_QUERY_COLUMN_CAPABILITY,
    ) === true &&
    fields.every((field) => SUBJECT_QUERY_COLUMN_FIELDS.has(field));
}

/** @internal Exact decoding contract shared by the fast scan and tests. */
export function projectSubjectQueryEntity(
  id: number,
  rank: number,
  requested: ReadonlySet<string>,
  columns: SubjectQueryColumns,
  name: NameRow | null,
): SubjectQueryProjection {
  if (!Number.isSafeInteger(id) || id < 0 || id > 0xffffff)
    throw new TypeError("Subject query id is invalid");
  if (
    !Number.isSafeInteger(rank) ||
    rank < 0 ||
    rank >= columns.nodeCount
  ) throw new TypeError("Subject query rank columns are inconsistent");
  const needsName = requested.has("name") || requested.has("nameCn");
  if (needsName && (!name || name[2] !== 1))
    throw new TypeError("Subject query name row is missing or has the wrong kind");
  const fields: Record<string, SubjectQueryField> = {};
  if (requested.has("name")) fields.name = name![0];
  if (requested.has("nameCn")) fields.nameCn = name![1] ?? "";
  const flags = columns.flags?.[rank];
  if ((requested.has("type") || requested.has("nsfw")) && flags === undefined)
    throw new TypeError("Subject flags query column is missing");
  if (requested.has("type")) fields.type = (flags as number) >>> 2;
  if (requested.has("year")) {
    const year = columns.year?.[rank];
    if (year === undefined)
      throw new TypeError("Subject year query column is missing");
    fields.year = year === 0 ? null : year;
  }
  if (requested.has("score")) {
    const score = columns.score?.[rank];
    if (score === undefined)
      throw new TypeError("Subject score query column is missing");
    fields.score = score === 0 ? null : score / 10;
  }
  if (requested.has("nsfw")) fields.nsfw = Boolean((flags as number) & 1);
  return { kind: "subject", key: (1 << 24) | id, fields };
}

async function loadSubjectNamesById(
  manifest: Manifest,
  ranksById: Uint32Array,
  signal?: AbortSignal,
): Promise<{
  original: (string | undefined)[];
  chinese: (string | null | undefined)[];
}> {
  const names = openNames(manifest);
  if (!names.read)
    throw new TypeError("published identity names are unavailable");
  await names.prefetch?.(signal);
  const idsByRank = new Uint32Array(manifest.n_nodes);
  idsByRank.fill(MISSING_ID);
  let present = 0;
  for (let id = 0; id < ranksById.length; id++) {
    const rank = ranksById[id] as number;
    if (rank === MISSING_RANK) continue;
    idsByRank[rank] = id;
    present++;
  }
  if (present !== manifest.counts.entities.subject)
    throw new TypeError("Subject query rank count is inconsistent");
  const original = new Array<string | undefined>(ranksById.length);
  const chinese = new Array<string | null | undefined>(ranksById.length);
  // Bound transient decoded tuples while retaining block-level parallelism.
  const windowSize = manifest.name_block_size * SUBJECT_NAME_BLOCK_BATCH;
  for (let start = 0; start < manifest.n_nodes; start += windowSize) {
    signal?.throwIfAborted();
    const end = Math.min(manifest.n_nodes, start + windowSize);
    const ranks: number[] = [];
    for (let rank = start; rank < end; rank++)
      if (idsByRank[rank] !== MISSING_ID) ranks.push(rank);
    const rows = await names.read(ranks, signal);
    if (rows.size !== ranks.length)
      throw new TypeError("Subject query names omitted a rank");
    for (const rank of ranks) {
      const row = rows.get(rank);
      const id = idsByRank[rank] as number;
      if (!row || row[2] !== 1 || id === MISSING_ID)
        throw new TypeError("Subject query name rank is inconsistent");
      original[id] = row[0];
      chinese[id] = row[1];
    }
  }
  return { original, chinese };
}

/** Project verified fixed columns in bounded archive-id ordered batches. */
export async function* projectSubjectQueryEntityBatches(
  manifest: Manifest,
  fieldNames: readonly string[],
  signal?: AbortSignal,
): AsyncIterable<readonly SubjectQueryProjection[]> {
  const requested = new Set(fieldNames);
  const [ranksById, columns] = await Promise.all([
    loadEntityRanksById(1, signal),
    loadSubjectQueryColumns(fieldNames, signal),
  ]);
  const needsNames = requested.has("name") || requested.has("nameCn");
  const names = needsNames
    ? await loadSubjectNamesById(manifest, ranksById, signal)
    : null;
  try {
    let batch: SubjectQueryProjection[] = [];
    for (let id = 0; id < ranksById.length; id++) {
      signal?.throwIfAborted();
      const rank = ranksById[id] as number;
      if (rank === MISSING_RANK) continue;
      const original = names?.original[id];
      const chinese = names?.chinese[id];
      if (needsNames && (original === undefined || chinese === undefined))
        throw new TypeError("Subject query name is missing");
      batch.push(projectSubjectQueryEntity(
        id,
        rank,
        requested,
        columns,
        needsNames ? [original!, chinese!, 1] : null,
      ));
      if (batch.length === SUBJECT_QUERY_ENTITY_BATCH) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  } finally {
    names?.original.fill(undefined);
    names?.chinese.fill(undefined);
  }
}

/** Compatibility row stream over the same verified batched projection. */
export async function* projectSubjectQueryEntities(
  manifest: Manifest,
  fieldNames: readonly string[],
  signal?: AbortSignal,
): AsyncIterable<SubjectQueryProjection> {
  for await (const batch of projectSubjectQueryEntityBatches(
    manifest,
    fieldNames,
    signal,
  )) yield* batch;
}
