import type { Owner, QueryFactKind } from "./contract";

export const OWNER_LABEL: Record<Owner, string> = {
  subject: "作品",
  person: "人物",
  character: "角色",
  episode: "分集",
};

export const FACT_LABEL: Record<QueryFactKind, string> = {
  RELATES_TO: "作品关系",
  WORKED_ON: "人物参与",
  APPEARS_IN: "角色登场",
  VOICE_CREDIT: "配音",
  PERSON_REL: "人物关系",
  CHARACTER_REL: "角色关系",
};
