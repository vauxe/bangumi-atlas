/** 转义模板:渲染 Bangumi 来源字符串的唯一合法通道(防 XSS)。 */

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

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
