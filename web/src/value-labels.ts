import {
  MEDIA_NAMES,
  type EntityKind,
  type Mappings,
  type StructuralEntity,
} from "./types";
import type { ProjectedEntity } from "./data";

export const CAREER_VALUES: Readonly<Record<string, string>> = {
  actor: "演员",
  artist: "艺术家",
  illustrator: "插画家",
  mangaka: "漫画家",
  producer: "制作人",
  seiyu: "声优",
  writer: "作家",
};

export function careerValueLabel(value: string): string {
  return CAREER_VALUES[value] ?? value;
}

function compactUnique(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Extra context for otherwise indistinguishable name suggestions. */
export function entitySuggestionContext(
  entity: StructuralEntity,
  mappings: Mappings,
): string {
  if (entity.kind === "subject") {
    const year = /^\d{4}/.exec(entity.date)?.[0];
    return compactUnique([
      mappings.subject_type[String(entity.type)] ?? MEDIA_NAMES[entity.type],
      entity.platformCode === null
        ? null
        : mappings.platform[`${entity.type}:${entity.platformCode}`],
      year,
    ]).join(" · ");
  }
  if (entity.kind === "person") {
    return compactUnique([
      mappings.person_type[String(entity.type)],
      ...entity.career.map((career) => CAREER_VALUES[career]).filter(Boolean)
        .slice(0, 2),
    ]).join(" · ");
  }
  return mappings.character_role[String(entity.role)] ?? "";
}

/** Format the same label from a query projection without hydrating full entities. */
export function projectedEntitySuggestionContext(
  entity: ProjectedEntity,
  mappings: Mappings,
): string {
  const { fields } = entity;
  if (entity.kind === "subject") {
    const type = fields.type as number;
    const platformCode = fields.platformCode as number | null;
    return compactUnique([
      mappings.subject_type[String(type)] ?? MEDIA_NAMES[type],
      platformCode === null
        ? null
        : mappings.platform[`${type}:${platformCode}`],
      /^\d{4}/.exec(fields.date as string)?.[0],
    ]).join(" · ");
  }
  if (entity.kind === "person") {
    return compactUnique([
      mappings.person_type[String(fields.type)],
      ...(fields.career as string[]).map((value) => CAREER_VALUES[value])
        .filter(Boolean).slice(0, 2),
    ]).join(" · ");
  }
  return mappings.character_role[String(fields.role)] ?? "";
}

export function ambiguousNameSuggestionRanks(
  items: readonly {
    rank: number;
    display: string;
    entityKind: EntityKind;
  }[],
): Set<number> {
  const keyOf = (item: typeof items[number]): string =>
    `${item.entityKind}:${item.display.normalize("NFKC").trim().toLocaleLowerCase()}`;
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    items.filter((item) => (counts.get(keyOf(item)) ?? 0) > 1)
      .map((item) => item.rank),
  );
}
