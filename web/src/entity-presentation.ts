/** User-facing projections of the complete structural entity contract.
 * Raw values stay intact in Data; this module only gives them readable order
 * and labels for the dossier. */

import { parse2 } from "@bgm38/wiki";

import type { Fact, SubjectEntity } from "./types";

export interface CountDatum {
  label: string;
  count: number;
}

const COLLECTION_LABELS: Readonly<Record<number, readonly string[]>> = {
  1: ["想读", "读过", "在读", "搁置", "抛弃"],
  2: ["想看", "看过", "在看", "搁置", "抛弃"],
  3: ["想听", "听过", "在听", "搁置", "抛弃"],
  4: ["想玩", "玩过", "在玩", "搁置", "抛弃"],
  6: ["想看", "看过", "在看", "搁置", "抛弃"],
};

export function collectionBreakdown(entity: SubjectEntity): CountDatum[] {
  const labels = COLLECTION_LABELS[entity.type] ?? COLLECTION_LABELS[2] ?? [];
  return entity.favorite.map((count, index) => ({
    label: labels[index] ?? `状态 ${index + 1}`,
    count,
  }));
}

export interface ScoreDatum {
  score: number;
  count: number;
}

export function scoreBreakdown(details: readonly number[]): ScoreDatum[] {
  return Array.from({ length: 10 }, (_, index) => ({
    score: 10 - index,
    count: details[9 - index] ?? 0,
  }));
}

export function tagGroups(entity: SubjectEntity): {
  meta: string[];
  community: CountDatum[];
} {
  return {
    meta: entity.metaTags.filter(Boolean),
    community: entity.tags
      .filter(([label]) => Boolean(label))
      .map(([label, count]) => ({ label, count })),
  };
}

export interface InfoboxListItem {
  label?: string;
  value: string;
}

export type ParsedInfoboxField =
  | { label: string; kind: "text"; value: string }
  | { label: string; kind: "list"; items: InfoboxListItem[] };

export interface ParsedInfobox {
  template: string;
  fields: ParsedInfoboxField[];
  issue?: { line: number };
}

/** Interpret the archived source with Bangumi's official Infobox parser.
 * The source remains authoritative and is always retained by the caller. */
export function parseInfobox(source: string): ParsedInfobox {
  const [error, wiki] = parse2(source);
  if (error)
    return {
      template: "",
      fields: [],
      issue: { line: error.lino },
    };

  return {
    template: wiki.type,
    fields: wiki.data.map((field): ParsedInfoboxField =>
      field.array
        ? {
            label: field.key,
            kind: "list",
            items: (field.values ?? []).map((item) => ({
              ...(item.k ? { label: item.k } : {}),
              value: item.v ?? "",
            })),
          }
        : { label: field.key, kind: "text", value: field.value ?? "" },
    ),
  };
}

export type RelationshipSectionId =
  | "works"
  | "credits"
  | "cast"
  | "voices"
  | "people"
  | "characters";

export interface RelationshipSection {
  id: RelationshipSectionId;
  label: string;
}

export function relationshipSection(fact: Fact): RelationshipSection {
  switch (fact.kind) {
    case "RELATES_TO":
      return { id: "works", label: "作品谱系" };
    case "WORKED_ON":
      return { id: "credits", label: "创作者与制作" };
    case "APPEARS_IN":
      return { id: "cast", label: "角色与出演" };
    case "VOICE_CREDIT":
      return { id: "voices", label: "配音关联" };
    case "PERSON_REL":
      return { id: "people", label: "人物关系" };
    case "CHARACTER_REL":
      return { id: "characters", label: "角色关系" };
  }
}
