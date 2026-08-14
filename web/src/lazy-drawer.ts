export interface DrawerRuntime {
  show(rank: number, key: number, episodeId?: number): Promise<void>;
  hide(): void;
  syncState(): void;
}

export interface LazyDrawerRuntime extends DrawerRuntime {
  prepare(): Promise<DrawerRuntime>;
}

export function createLazyDrawerRuntime(
  load: () => Promise<DrawerRuntime>,
): LazyDrawerRuntime {
  let preparation: Promise<DrawerRuntime> | null = null;
  let runtime: DrawerRuntime | null = null;
  let viewEpoch = 0;

  const prepare = (): Promise<DrawerRuntime> => {
    if (runtime) return Promise.resolve(runtime);
    if (preparation) return preparation;

    let pending: Promise<DrawerRuntime>;
    try {
      pending = load();
    } catch (error) {
      pending = Promise.reject(error);
    }

    const tracked = pending.then(
      (loaded) => {
        runtime = loaded;
        return loaded;
      },
      (error) => {
        if (preparation === tracked) preparation = null;
        throw error;
      },
    );
    preparation = tracked;
    return tracked;
  };

  const show = async (
    rank: number,
    key: number,
    episodeId?: number,
  ): Promise<void> => {
    const epoch = ++viewEpoch;
    const loaded = await prepare();
    if (epoch !== viewEpoch) return;
    await loaded.show(rank, key, episodeId);
  };

  const hide = (): void => {
    viewEpoch++;
    runtime?.hide();
  };

  const syncState = (): void => runtime?.syncState();

  return { prepare, show, hide, syncState };
}
