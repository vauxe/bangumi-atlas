import { canonicalJson } from "./canonical";
import { inferCypherParameters } from "./parameters";

export interface CypherQueryState {
  schema: "atlas-cypher-source-v1";
  source: string;
  parameters: Record<string, string | number | boolean>;
}

const MAX_ENCODED_LENGTH = 32_768;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function validateCypherState(value: CypherQueryState): void {
  if (
    value?.schema !== "atlas-cypher-source-v1" ||
    typeof value.source !== "string" ||
    value.source.length > 16_384 ||
    value.parameters === null ||
    typeof value.parameters !== "object" ||
    Array.isArray(value.parameters)
  )
    throw new TypeError("Atlas Cypher 分享状态无效");
  inferCypherParameters(canonicalJson(value.parameters));
}

export function encodeCypherState(value: CypherQueryState): string {
  validateCypherState(value);
  const encoded = base64Url(new TextEncoder().encode(canonicalJson(value)));
  if (encoded.length > MAX_ENCODED_LENGTH)
    throw new TypeError("Atlas Cypher 分享状态过长");
  return encoded;
}

export function decodeCypherState(encoded: string): CypherQueryState | null {
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH) return null;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as CypherQueryState;
    validateCypherState(value);
    return value;
  } catch {
    return null;
  }
}
