/** Fail closed when a fixed-size published artifact is truncated or padded. */
export function assertByteLength(
  path: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected)
    throw new Error(`${path}: expected ${expected} bytes, received ${actual}`);
}

/** Browser-native SHA-256 in the same lowercase format as manifest.json. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
