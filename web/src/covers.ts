import { html } from "./html";
import { eid, etype } from "./types";

export type CoverSize = "small" | "grid" | "medium";

type CoverContext = "map" | "chip" | "drawer";

export const COVER_SIZES: Readonly<Record<CoverContext, CoverSize>> = {
  // WebGL texture uploads require CORS. Bangumi's resized `small` response
  // provides it across entity types; direct person/character `grid` images do not.
  map: "small",
  chip: "grid",
  drawer: "small",
};

const COVER_KINDS = ["", "subjects", "persons", "characters"] as const;

export function coverUrl(key: number, size: CoverSize): string | null {
  const type = etype(key);
  const id = eid(key);
  const kind = COVER_KINDS[type];
  if (!kind || id <= 0) return null;
  return `https://api.bgm.tv/v0/${kind}/${id}/image?type=${size}`;
}

/** The dot stays underneath the image, so a failed optional request has a
 * stable, type-colored fallback without shifting the chip text. */
export function chipCover(key: number): string {
  const url = coverUrl(key, COVER_SIZES.chip);
  if (!url) return "";
  const type = etype(key);
  return html`<span class="chip-media type-${type}" aria-hidden="true">
    <span class="chip-mark type-${type}"></span>
    <img
      class="chip-av"
      loading="lazy"
      decoding="async"
      src="${url}"
      alt=""
      onerror="this.remove()"
    >
  </span>`;
}

export function drawerCover(key: number): string {
  const url = coverUrl(key, COVER_SIZES.drawer);
  if (!url) return "";
  return html`<img
    class="cover"
    src="${url}"
    alt=""
    decoding="async"
    onerror="this.remove()"
  >`;
}

export interface CoverItem {
  rank: number;
  key: number;
  index: number;
}

/** Avoid invalid requests for not-yet-streamed keys and duplicate atlas
 * entries when one node appears under several relationship labels. */
export function coverItems(
  ranks: readonly number[],
  keys: ArrayLike<number>,
): CoverItem[] {
  const seen = new Set<number>();
  const items: CoverItem[] = [];
  ranks.forEach((rank, index) => {
    if (seen.has(rank)) return;
    const key = keys[rank] ?? 0;
    if (!coverUrl(key, COVER_SIZES.map)) return;
    seen.add(rank);
    items.push({ rank, key, index });
  });
  return items;
}
