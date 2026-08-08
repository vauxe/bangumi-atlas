export type SiteRuntimeErrorCode =
  | "UNSUPPORTED_QUERY"
  | "RELEASE_UNAVAILABLE"
  | "RELEASE_EVICTED"
  | "DATA_INTEGRITY"
  | "NETWORK";

/** A recoverable, user-actionable failure shared by the loader and query Worker. */
export class SiteRuntimeError extends Error {
  constructor(
    readonly code: SiteRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SiteRuntimeError";
  }
}
