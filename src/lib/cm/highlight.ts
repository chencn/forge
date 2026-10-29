/**
 * 语法配色：Lezer tag → `--syn-*`。这份映射是编辑器、md 预览、聊天代码块共用的
 * 唯一一处颜色来源，换掉它等于同时换掉三处的观感。
 *
 * 每个 token 另外读 `-bold / -italic / -bg / -effect` 四个覆写变量，取不到就用括号里的
 * 默认值——现在还没有配色覆写界面，但注释斜体这类已经走 `--syn-comment-style`，
 * 以后接 Color Scheme 覆写不用再改这份表。
 */
import { HighlightStyle, type TagStyle } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";

function token(
  tag: Tag | Tag[],
  name: string,
  defaults: { italic?: string; bold?: string; effect?: string } = {}
): TagStyle {
  return {
    tag,
    color: `var(--syn-${name})`,
    fontStyle: `var(--syn-${name}-italic, ${defaults.italic ?? "inherit"})`,
    fontWeight: `var(--syn-${name}-bold, ${defaults.bold ?? "inherit"})`,
    backgroundColor: `var(--syn-${name}-bg, transparent)`,
    textDecoration: `var(--syn-${name}-effect, ${defaults.effect ?? "none"})`,
  };
}

export const forgeHighlightStyle = HighlightStyle.define([
  // Markdown 的 link / quote 是整段标签，排最前，好让里面的 URL、标题各自保色。
  token(t.link, "link", { effect: "underline" }),
  token(t.quote, "string"),
  token(
    [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.null,
      t.bool,
      t.unit,
    ],
    "keyword"
  ),
  token(t.self, "self"),
  token([t.string, t.special(t.string), t.character, t.attributeValue], "string"),
  token(t.docString, "docstring", { italic: "italic" }),
  token(t.escape, "escape"),
  token(t.regexp, "regexp"),
  token([t.number, t.integer, t.float], "number"),
  token([t.typeName, t.className, t.namespace, t.definition(t.typeName)], "type"),
  token([t.standard(t.typeName), t.standard(t.variableName), t.standard(t.function(t.variableName))], "builtin"),
  token([t.function(t.variableName), t.function(t.propertyName)], "function-call"),
  token(
    [
      t.function(t.definition(t.variableName)),
      t.definition(t.function(t.variableName)),
      t.function(t.definition(t.propertyName)),
    ],
    "function"
  ),
  token([t.comment, t.lineComment, t.blockComment], "comment", { italic: "var(--syn-comment-style)" }),
  token(t.docComment, "doc-comment", { italic: "italic" }),
  token([t.meta, t.annotation, t.macroName], "decorator"),
  // `<!doctype>` 挂在 meta 底下，但 PyCharm 把 XML 序言留成正文字色。
  { tag: t.documentMeta, color: "var(--fg-editor)" },
  token([t.constant(t.variableName), t.atom, t.special(t.variableName)], "constant", { italic: "italic" }),
  token(t.labelName, "constant"),
  token([t.variableName, t.definition(t.variableName), t.local(t.variableName)], "variable"),
  token([t.propertyName, t.definition(t.propertyName)], "property"),
  token(t.attributeName, "attribute"),
  token([t.tagName, t.angleBracket], "tag"),
  token([t.punctuation, t.bracket, t.separator, t.operator, t.derefOperator], "punct"),
  token(t.invalid, "invalid"),
  // 标记语言（Markdown、文档注释）
  token(t.heading, "markup-heading", { bold: "700" }),
  token(t.processingInstruction, "keyword"),
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // 对齐 IntelliJ：链接目标按静态方法上色，分隔线按关键字上色。
  token(t.url, "function", { italic: "italic" }),
  token(t.monospace, "markup-code"),
  token(t.contentSeparator, "keyword"),
  { tag: t.inserted, color: "var(--accent-green)" },
  { tag: t.deleted, color: "var(--accent-red)" },
  { tag: t.changed, color: "var(--accent-blue)" },
]);
