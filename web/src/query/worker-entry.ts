import { Data } from "../data";
import {
  ensureRankIndex,
  loadManifest,
  rankOfKey,
} from "../loader";
import { executeQuery } from "./engine";
import { QueryHighlightBuilder } from "./highlights";
import { queryGraphEntityKey } from "./graph-results";
import { SiteQueryDataSource } from "./site-source";
import { SiteQuerySearchIndex } from "./site-search";
import { createQueryWorkerRuntime } from "./worker-runtime";
import { QUERY_CONTRACT } from "./contract";
import { canonicalJson } from "./canonical";
import { SiteRuntimeError } from "../site-error";

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const REQUIRED_CAPABILITIES = [
  "atlas-query-v1",
  "fact-ref-v1",
  "full-text-v1",
] as const;

async function contractDigest(): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(QUERY_CONTRACT));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const runtimeSource = loadManifest().then(async (manifest) => {
  if (
    manifest.query?.schema !== "atlas-release-query-v1" ||
    manifest.query.contractDigest !== await contractDigest() ||
    REQUIRED_CAPABILITIES.some(
      (capability) => !manifest.query?.capabilities.includes(capability),
    )
  )
    throw new SiteRuntimeError(
      "UNSUPPORTED_QUERY",
      "当前 AtlasRelease 与查询客户端不兼容",
    );
  const data = new Data(manifest);
  return {
    manifest,
    source: new SiteQueryDataSource(
      data,
      new SiteQuerySearchIndex(data, manifest),
      manifest.version,
    ),
  };
});

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) signal.throwIfAborted();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const runtime = createQueryWorkerRuntime(async (request, signal) => {
  const { manifest, source } = await abortable(runtimeSource, signal);
  const highlights = request.includeHighlights
    ? new QueryHighlightBuilder(manifest.n_nodes)
    : null;
  if (highlights) await abortable(ensureRankIndex(), signal);
  const result = await executeQuery(
    request.document,
    request.parameters,
    source,
    {
      pageSize: request.pageSize,
      offset: request.offset,
      signal,
      ...(highlights
        ? {
            onResultEntities: (entities) => {
              for (const entity of entities) {
                if (!entity.graphRef) continue;
                const key = queryGraphEntityKey(entity.graphRef);
                const rank = key === null ? null : rankOfKey(key);
                if (rank !== null) highlights.add(rank);
              }
            },
          }
        : {}),
    },
  );
  return {
    result,
    ...(highlights ? { highlights: highlights.finish() } : {}),
  };
}, (response, transfer) => scope.postMessage(response, transfer));

scope.onmessage = (event) => runtime.receive(event.data);
