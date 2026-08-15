/** 转义模板:渲染 Bangumi 来源字符串的唯一合法通道(防 XSS)。 */

import siteContract from "../../scripts/site-contract.json";

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Bangumi 的旧文本字段偶尔保留 HTML 字符引用。权威数据继续保存
 * 原文，展示与搜索使用同一投影；未知的站点自定义写法保持原样。
 * 此投影有固定深度且不是幂等操作，只能用于尚未投影的归档文本。
 */
const displayEntityMap = Object.freeze(
  siteContract.display_text.named_references,
) as Readonly<Record<string, string>>;
const displayDecodePasses = siteContract.display_text.decode_passes;

function decodeDisplayTextPass(text: string): string {
  return text.replace(
    /&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z][A-Za-z0-9]+);/g,
    (reference, body: string) => {
      if (!body.startsWith("#"))
        return Object.hasOwn(displayEntityMap, body)
          ? displayEntityMap[body]!
          : reference;
      const hex = body[1]?.toLowerCase() === "x";
      const digits = body.slice(hex ? 2 : 1);
      const codePoint = Number.parseInt(digits, hex ? 16 : 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) return reference;
      return String.fromCodePoint(codePoint);
    },
  );
}

export function decodeDisplayText(text: unknown): string {
  let decoded = String(text ?? "");
  // Archive 中同时存在一层和双层编码；固定上限避免畸形来源制造
  // 与嵌套深度线性相关的工作量。最终调用方仍必须经 html/esc 转义。
  for (let pass = 0; pass < displayDecodePasses; pass++) {
    const next = decodeDisplayTextPass(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

export function esc(text: unknown): string {
  return String(text ?? "").replace(/[&<>"']/g, (c) => escapeMap[c] ?? c);
}

/** html`<b>${用户数据}</b>`——插值自动转义;嵌入已构建片段用 raw()。 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      out += v instanceof Raw ? v.text : esc(v);
    }
  });
  return out;
}

class Raw {
  constructor(public text: string) {}
}

export function raw(text: string): Raw {
  return new Raw(text);
}
