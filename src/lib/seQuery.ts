/**
 * 弹窗输入的地点解析：`File.kt:42`、`File.kt:42:5`、贴进来的绝对路径、
 * `file://` 链接与 Windows 反斜杠路径都认（抄 openidea 的 common/query.ts）。
 * 输入的行列号 1 起；这边编辑器与后端命令同样吃 1 起，所以原样保留，
 * 只在交给 openidea 那套 0 起口径的地方时注意换算。
 */

export interface ParsedQuery {
  /** 去掉地点后缀后、真正拿去匹配的文本。 */
  text: string;
  /** 给了 `:行` 时的行号，1 起；没给为 null。 */
  line: number | null;
  /** 给了 `:行:列` 时的列号，1 起；没给为 null。 */
  col: number | null;
}

const LOCATION = /^(.*?)(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\)):?$/;

export function parseLocationQuery(raw: string, root?: string | null): ParsedQuery {
  let text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (/^file:\/\//i.test(text)) {
    text = text.replace(/^file:\/\//i, "");
    try {
      text = decodeURI(text);
    } catch {
      /* 解不开就原样留着 */
    }
  }
  if (/^[a-zA-Z]:\\/.test(text) || (text.includes("\\") && !text.includes("/"))) text = text.replace(/\\/g, "/");

  let line: number | null = null;
  let col: number | null = null;
  const m = LOCATION.exec(text);
  if (m && m[1] !== undefined && (m[2] ?? m[4])) {
    const l = Number(m[2] ?? m[4]);
    const c = m[3] ?? m[5];
    if (l > 0) {
      text = m[1];
      line = l;
      col = c !== undefined && Number(c) > 0 ? Number(c) : null;
    }
  }

  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalized = text;
    if (normalized === r) text = "";
    else if (normalized.startsWith(r + "/")) text = normalized.slice(r.length + 1);
  }
  return { text, line, col };
}
