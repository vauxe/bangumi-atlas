/** Complete selected-fan EntityKey -> VisualRank resolution from main. */
export type ResolvedRelationRanks = ReadonlyMap<number, number>;
/** The Drawer may render node details while the complete relation fan resolves. */
export type RelationRankSource =
  | ResolvedRelationRanks
  | PromiseLike<ResolvedRelationRanks>;

export interface DrawerRuntime {
  show(
    rank: number,
    key: number,
    relationRanks: RelationRankSource,
    episodeId?: number,
  ): Promise<void>;
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
    relationRanks: RelationRankSource,
    episodeId?: number,
  ): Promise<void> => {
    const epoch = ++viewEpoch;
    // The relation task starts before the lazy chunk is ready. Attach an error
    // observer now so a fast transport failure cannot become an unhandled
    // rejection while module preparation is still in flight; Drawer still
    // consumes the original source and renders its visible error state.
    if (
      typeof (relationRanks as PromiseLike<ResolvedRelationRanks>).then ===
        "function"
    )
      void Promise.resolve(relationRanks).catch(() => undefined);
    const loaded = await prepare();
    if (epoch !== viewEpoch) return;
    await loaded.show(rank, key, relationRanks, episodeId);
  };

  const hide = (): void => {
    viewEpoch++;
    runtime?.hide();
  };

  const syncState = (): void => runtime?.syncState();

  return { prepare, show, hide, syncState };
}
