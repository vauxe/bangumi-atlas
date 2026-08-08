import { canonicalJson } from "./canonical";
import { normalizeBundle, type QueryBundle } from "./bundle";

const MAX_ENCODED_BUNDLE = 32_768;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function serializeBundle(bundle: QueryBundle): string {
  return base64Url(
    new TextEncoder().encode(canonicalJson(normalizeBundle(bundle))),
  );
}

export function encodeBundle(bundle: QueryBundle): string {
  const encoded = serializeBundle(bundle);
  if (encoded.length > MAX_ENCODED_BUNDLE)
    throw new TypeError("查询过长，无法写入分享链接");
  return encoded;
}

/** URL persistence is optional and must never become a query execution limit. */
export function encodeShareableBundle(bundle: QueryBundle): string | null {
  const encoded = serializeBundle(bundle);
  return encoded.length <= MAX_ENCODED_BUNDLE ? encoded : null;
}

export function decodeBundle(encoded: string): QueryBundle | null {
  if (!encoded || encoded.length > MAX_ENCODED_BUNDLE || !/^[\w-]+$/.test(encoded))
    return null;
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return normalizeBundle(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as QueryBundle);
  } catch {
    return null;
  }
}
