/**
 * 输入框的 @ 文件提及：触发检测、建议接受、时间线里的高亮切分。
 *
 * 提及的本体就是 prompt 里的一段 `@路径` 文本——Claude Code 原生把 @路径 当附件
 * 提示展开，Codex 的模型也能直接读懂路径。所以这边不需要任何传输协议，只要把
 * 选取的文件以 `@相对路径` 的形式拼进正文即可。
 */

export interface MentionSpan {
  start: number;
  query: string;
}

/**
 * 提及的引导字符（@ 前只许行首或这些字符）：空白与开括号/引号，中英文都算。
 * 触发检测与时间线高亮共用同一条定义——「提及从哪开始」两边判定不许各自漂移。
 */
const MENTION_LEAD = String.raw`[\s（【「(\[{>"']`;
/** 触发侧的 token 从宽：正在敲字时只让位给空白与 @，过滤交给建议菜单。 */
const MENTION_QUERY = String.raw`[^\s@]*`;
/** 渲染侧的 token 从严：不吃句读标点，行尾的 ）" 等留给普通片段。 */
const MENTION_TOKEN = /[^\s，。；、！？）】」"']+/;
const MENTION_AT_RE = new RegExp(`(?:^|${MENTION_LEAD})@(${MENTION_QUERY})$`);
const MENTION_SPLIT_SOURCE = `(^|${MENTION_LEAD})@(${MENTION_TOKEN.source})`;

/** 光标前紧邻的 @token：`@` 之前必须是开头或空白/开括号，避免命中邮箱里的 @。 */
export function mentionAt(text: string, caret: number): MentionSpan | null {
  const before = text.slice(0, caret);
  const match = MENTION_AT_RE.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/** 接受建议：把 `@query` 换成 `@路径` 并补一个空格（后面已有空白就不补），返回新文本与光标位置。 */
export function applyMention(text: string, caret: number, start: number, path: string): { text: string; caret: number } {
  const tail = text.slice(caret);
  const gap = tail.startsWith(" ") || tail.startsWith("\n") ? "" : " ";
  const next = `${text.slice(0, start)}@${path}${gap}${tail}`;
  return { text: next, caret: start + path.length + 1 + gap.length };
}

/** 绝对路径转相对引用：剥掉工作区前缀（Windows 不分大小写），统一正斜杠。 */
export function mentionPathOf(absolute: string, workspace: string): string {
  const normalized = absolute.replace(/\\/g, "/");
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  const rootLower = root.toLowerCase() + "/";
  if (lower.startsWith(rootLower)) return normalized.slice(root.length + 1);
  if (lower === root.toLowerCase()) return "";
  return normalized;
}

/** 时间线高亮用：把正文切成普通片段与 @提及 交替的序列。 */
export function splitMentionTokens(text: string): Array<{ text: string; mention: boolean }> {
  const out: Array<{ text: string; mention: boolean }> = [];
  // /g 正则带状态（lastIndex），每次调用现建，别复用模块级实例。
  const re = new RegExp(MENTION_SPLIT_SOURCE, "g");
  let last = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const lead = match[1];
    const at = match.index + lead.length;
    if (at > last) out.push({ text: text.slice(last, at), mention: false });
    const token = `@${match[2]}`;
    out.push({ text: token, mention: true });
    last = at + token.length;
    // token 本体只认 MENTION_TOKEN 集合里的字符：正则里已经排掉了常见标点，
    // 再从命中的尾巴上剥掉没吃进去的符号（如行尾的 `）`），把余下的还给普通片段。
    while (last < text.length && !MENTION_TOKEN.test(text[last]!) && text[last] !== " ") {
      out.push({ text: text[last]!, mention: false });
      last += 1;
    }
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}
