export interface FocusableRuntime {
  focus(): void;
}

export interface LazyRuntimeOptions<Prepared, Runtime extends FocusableRuntime> {
  prepare(): Promise<Prepared>;
  install(prepared: Prepared): Runtime | Promise<Runtime>;
  onActivating?(): void;
  onReady?(runtime: Runtime): void;
  onError?(error: unknown): void;
}

export interface LazyRuntime<Prepared, Runtime extends FocusableRuntime> {
  prepare(): Promise<Prepared>;
  activate(options?: { focus?: boolean }): Promise<Runtime>;
}

/** Separates speculative download from user-visible installation. Both phases
 * are idempotent, while a failed download or install remains retryable. */
export function createLazyRuntime<Prepared, Runtime extends FocusableRuntime>(
  options: LazyRuntimeOptions<Prepared, Runtime>,
): LazyRuntime<Prepared, Runtime> {
  let preparation: Promise<Prepared> | null = null;
  let activation: Promise<Runtime> | null = null;
  let runtime: Runtime | null = null;
  let focusWhenReady = false;

  const prepare = (): Promise<Prepared> => {
    if (preparation) return preparation;
    const pending = options.prepare();
    const tracked = pending.catch((error: unknown) => {
      if (preparation === tracked) preparation = null;
      throw error;
    });
    preparation = tracked;
    return tracked;
  };

  const activate = (
    activateOptions: { focus?: boolean } = {},
  ): Promise<Runtime> => {
    if (runtime) {
      if (activateOptions.focus) runtime.focus();
      return Promise.resolve(runtime);
    }
    focusWhenReady ||= activateOptions.focus === true;
    if (activation) return activation;

    options.onActivating?.();
    const pending = (async () => {
      const installed = await options.install(await prepare());
      runtime = installed;
      if (focusWhenReady) installed.focus();
      focusWhenReady = false;
      options.onReady?.(installed);
      return installed;
    })();
    const tracked = pending.catch((error: unknown) => {
      if (activation === tracked) activation = null;
      focusWhenReady = false;
      options.onError?.(error);
      throw error;
    });
    activation = tracked;
    return tracked;
  };

  return { prepare, activate };
}
