import { parseEntityRef, parseFactRef } from "./contract";
import type { ParameterType, ParameterValues } from "./document";

export interface InferredQueryParameters {
  types: Record<string, ParameterType>;
  values: ParameterValues;
}

/** Parse the query editor's JSON parameters without allowing structured values. */
export function inferQueryParameters(source: string): InferredQueryParameters {
  const parsed: unknown = source.trim() ? JSON.parse(source) : {};
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("参数必须是 JSON 对象");
  const types: Record<string, ParameterType> = {};
  const values: ParameterValues = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new TypeError(`参数名 ${name} 无效`);
    if (typeof value === "string") {
      try {
        types[name] = `entity:${parseEntityRef(value).owner}`;
      } catch {
        try {
          parseFactRef(value);
          types[name] = "fact-ref";
        } catch {
          types[name] = "string";
        }
      }
    } else if (typeof value === "number" && Number.isFinite(value))
      types[name] = Number.isSafeInteger(value) ? "integer" : "number";
    else if (typeof value === "boolean") types[name] = "boolean";
    else
      throw new TypeError(`参数 ${name} 只接受有限数字、字符串、布尔值或稳定实体身份`);
    values[name] = value;
  }
  return { types, values };
}

/** 仅供旧 `ac` 分享链接迁移。 */
export const inferCypherParameters = inferQueryParameters;
export type InferredCypherParameters = InferredQueryParameters;
