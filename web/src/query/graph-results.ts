import { ENTITY_KIND_BY_OWNER } from "../types";
import { parseEntityRef } from "./contract";
import type { QueryGraphEntityRef } from "./engine";

export function queryGraphEntityKey(ref: QueryGraphEntityRef): number | null {
  const entity = parseEntityRef(ref);
  if (entity.owner === "episode" || entity.archiveId > 0xffffff) return null;
  const kind = ENTITY_KIND_BY_OWNER[entity.owner];
  return (kind << 24) | entity.archiveId;
}
