/** Fail closed when a fixed-size published artifact is truncated or padded. */
export function assertByteLength(
  path: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected)
    throw new Error(`${path}: expected ${expected} bytes, received ${actual}`);
}

/** A 206 is trustworthy only when it describes the exact requested slice. */
export function assertContentRange(
  path: string,
  value: string | null,
  start: number,
  length: number,
  total: number,
): void {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  const actualStart = Number(match?.[1]);
  const actualEnd = Number(match?.[2]);
  const actualTotal = Number(match?.[3]);
  if (
    !match ||
    actualStart !== start ||
    actualEnd !== start + length - 1 ||
    actualTotal !== total
  )
    throw new Error(
      `${path}: invalid Content-Range ${JSON.stringify(value)}; expected ` +
        `bytes ${start}-${start + length - 1}/${total}`,
    );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
