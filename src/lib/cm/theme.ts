/**
 * 编辑器外观：IDEA 新 UI 的岛状编辑区——行号右对齐、当前行整条染色（含行号槽）、
 * 行号槽与正文之间一条发丝线、括号对高亮。颜色一律走 tokens.css 的变量，深浅色只有一份来源，
 * 组件不再像 Monaco 那样把 CSS 变量读成十六进制再喂给引擎。
 *
 * 字号与行高不进主题对象：编辑器宿主在自己的元素上写 `--editor-font-size` /
 * `--editor-line-height`，改设置只换两个自定义属性，不重建主题。
 */
import { EditorView } from "@codemirror/view";

export const forgeTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg-editor, var(--bg-primary))",
    color: "var(--fg-editor, var(--text-primary))",
    "--editor-line-number": "var(--fg-line-number, var(--text-muted))",
    "--editor-line-number-current": "var(--fg-line-number-current)",
    "--editor-gutter-border": "var(--border-gutter, var(--border-color))",
    "--editor-caret-row": "var(--bg-editor-current-line)",
    "--editor-selection": "var(--bg-editor-selection, var(--selection-bg))",
    "--editor-selection-inactive": "var(--bg-editor-selection-inactive, var(--selection-bg))",
    "--editor-search": "var(--accent-amber-bg)",
    "--editor-search-current": "var(--accent-yellow)",
    "--editor-brace": "color-mix(in srgb, var(--accent-blue) 22%, transparent)",
    "--editor-fold-chip": "color-mix(in srgb, var(--text-muted) 14%, transparent)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    // 工作台整体用箭头光标，只有正文区要 I 型光标（末行之后也算正文）。
    cursor: "text",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--editor-font-size, 13px)",
    lineHeight: "var(--editor-line-height, 20px)",
    fontVariantLigatures: "none",
    overscrollBehavior: "contain",
  },
  ".cm-content": {
    // 上下留白照原来 Monaco 那版（padding top 10 / bottom 12），换了引擎不该把这一眼看得出的间距改掉。
    padding: "10px 0 12px 0",
    caretColor: "var(--caret, var(--text-primary))",
  },
  ".cm-line": { padding: "0 16px 0 6px" },
  // 缩进参考线：一条重复渐变铺在行的缩进区背景上，层数与步长由 lib/cm/indentGuides.ts 写在行上。
  // 起点 6px 是 .cm-line 的左内边距，`1ch` 在这套等宽字体里正好是一个字符宽。
  ".cm-indent-guide": {
    backgroundImage:
      "repeating-linear-gradient(to right, var(--editor-indent-guide, var(--border-color)) 0 1px, transparent 1px calc(var(--forge-guide-step) * 1ch))",
    backgroundSize: "calc(var(--forge-guide-levels) * var(--forge-guide-step) * 1ch) 100%",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "6px 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--caret, var(--text-primary))",
    marginLeft: "-1px",
  },
  ".cm-selectionBackground": { background: "var(--editor-selection-inactive)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--editor-selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--editor-caret-row)" },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--fg-editor, var(--text-primary)) 9%, transparent)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--editor-brace)",
    color: "inherit",
    borderRadius: "1px",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    color: "var(--accent-red)",
    backgroundColor: "color-mix(in srgb, var(--accent-red) 14%, transparent)",
  },
  ".cm-specialChar": { color: "var(--accent-red)" },

  // 行号槽：行号 | 改动标记 | 折叠扣 | 发丝线
  ".cm-gutters": {
    cursor: "default",
    backgroundColor: "var(--bg-editor-gutter, var(--bg-editor, var(--bg-primary)))",
    color: "var(--editor-line-number)",
    border: "none",
    borderRight: "1px solid var(--editor-gutter-border)",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "32px",
    padding: "0 8px 0 10px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--editor-caret-row)" },
  ".cm-lineNumbers .cm-activeLineGutter": { color: "var(--editor-line-number-current)" },
  // 改动色带：行号与折叠扣之间单开一条 4px 的槽，条走左缘 3px，正好是 IDEA 那根。
  ".cm-change-lane": { width: "4px" },
  ".cm-change-lane .cm-gutterElement": { padding: "0", position: "relative" },
  ".change-lane-bar": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "3px",
    borderRadius: "0 1px 1px 0",
    background: "var(--lane-color)",
  },
  ".change-lane-wedge": {
    position: "absolute",
    left: "0",
    bottom: "-3px",
    width: "0",
    height: "0",
    borderTop: "3px solid transparent",
    borderBottom: "3px solid transparent",
    borderLeft: "6px solid var(--accent-red)",
    zIndex: "1",
  },
  ".change-lane-wedge.is-before": { bottom: "auto", top: "-3px" },
  ".cm-foldGutter": { width: "16px" },
  ".cm-foldGutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-tertiary)",
    cursor: "pointer",
    transition: "opacity 120ms ease",
  },
  // 展开的扣平时收着，鼠标进装订线才亮（IDEA 新 UI 的做法，正文边上不挂一片箭头）。
  ".cm-foldGutter .cm-fold-open": { opacity: "0", display: "inline-flex" },
  ".cm-foldGutter .cm-fold-closed": { display: "inline-flex" },
  ".cm-gutters:hover .cm-foldGutter .cm-fold-open": { opacity: "1" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--text-primary)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--editor-fold-chip)",
    border: "none",
    color: "var(--text-muted)",
    borderRadius: "var(--radius-sm)",
    padding: "0 5px",
    margin: "0 2px",
    cursor: "pointer",
  },
  ".cm-foldPlaceholder:hover": {
    backgroundColor: "color-mix(in srgb, var(--text-muted) 24%, transparent)",
  },

  // 浮层：悬停文档、补全列表、行内提示，统一用应用的实心浮层底色（不允许透出正文）。
  ".cm-tooltip": {
    backgroundColor: "var(--surface-island)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-light)",
    borderRadius: "var(--radius-sm)",
    boxShadow: "var(--island-shadow)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent-blue-bg)",
    color: "var(--accent-blue-text)",
  },
  ".cm-completionDetail": { color: "var(--text-tertiary)", opacity: "1" },
  ".cm-diagnostic": { marginLeft: "4px" },
  ".cm-tooltip-section:not(:first-child)": { borderTop: "1px solid var(--border-color)" },
  ".cm-panels": {
    backgroundColor: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    fontSize: "12px",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-color)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border-color)" },
  ".cm-panel input": {
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-light)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-panel button": {
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-light)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-panel button:hover": { backgroundColor: "var(--bg-hover)" },

  // 查找命中：IDEA 把非当前项涂成浅黄、当前项描一圈边。
  ".cm-searchMatch": {
    backgroundColor: "var(--editor-search)",
    outline: "1px solid color-mix(in srgb, var(--accent-amber-text) 40%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--editor-search-current)",
  },

  // 诊断波浪线：颜色由 tokens.css 那两档方案色决定，深浅色各一套。
  ".cm-lintRange-error": { textDecoration: "var(--editor-error-decoration, underline wavy)" },
  ".cm-lintRange-warning": {
    textDecoration: "var(--editor-warning-decoration, underline wavy)",
    backgroundColor: "var(--editor-warning-background, transparent)",
  },
  ".cm-lintRange-information, .cm-lintRange-hint": { textDecoration: "none" },

  // 滚动条：沿用应用的滚动条变量，宽度对齐原来 Monaco 那档。
  ".cm-scroller::-webkit-scrollbar": { width: "20px", height: "11px" },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    backgroundColor: "var(--scrollbar-thumb)",
    border: "6px solid transparent",
    backgroundClip: "padding-box",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": { backgroundColor: "var(--scrollbar-thumb-hover)" },
  ".cm-scroller::-webkit-scrollbar-corner": { backgroundColor: "transparent" },

  // 右侧改动色带（cm/overview.ts）：叠在滚动条那一列，点了跳到那一行。
  // 只让色条自己吃指针，空白处留给滚动条拖动。
  ".cm-overview": {
    position: "absolute",
    top: "0",
    right: "0",
    bottom: "0",
    width: "20px",
    pointerEvents: "none",
    zIndex: "3",
  },
  ".cm-overviewMark": {
    position: "absolute",
    left: "7px",
    width: "6px",
    minHeight: "3px",
    borderRadius: "2px",
    pointerEvents: "auto",
    cursor: "pointer",
  },
  ".cm-overviewMark-thin": { left: "8px", width: "4px", minHeight: "2px" },
});
