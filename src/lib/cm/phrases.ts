/**
 * CodeMirror 自带面板的文案换成本应用的语言。
 *
 * 查找/替换条、跳转行、折叠扣、问题面板这些界面里的字，在引擎源码里是写死的英文原串，
 * 唯一的翻译入口是 `EditorState.phrases` 这个 facet：按原串查表，查不到就原样显示。
 * Forge 是中文应用，这一层不接上就得到处看见英文——尤其那个查找条。
 *
 * 表里挂的是 getter 而不是字符串：换语言只改 i18n 那份镜像，常驻 state 不会重建，
 * 用快照的话没在屏幕上的那几页签会一直留着旧语言。
 */
import { translate } from "../../i18n";
import type { TranslationKey } from "../../i18n/lang/zh";

/** 键是 CodeMirror 源码里的原串，改一个字符就换不回译文了。 */
const PLAIN: Record<string, TranslationKey> = {
  Find: "editor.cm.find",
  Replace: "editor.cm.replace",
  "replace": "editor.cm.replace",
  "replace all": "editor.cm.replaceAll",
  all: "editor.cm.selectMatches",
  "match case": "search.option.case",
  regexp: "search.option.regex",
  "by word": "search.option.words",
  next: "editor.cm.next",
  previous: "editor.cm.previous",
  close: "editor.cm.close",
  "Go to line": "editor.cm.gotoLine",
  go: "editor.cm.gotoLine.go",
  "current match": "editor.cm.currentMatch",
  "on line": "editor.cm.onLine",
  Completions: "editor.cm.completions",
  "Control character": "editor.cm.controlChar",
  "Selection deleted": "editor.cm.selectionDeleted",
  Diagnostics: "editor.cm.diagnostics",
  "No diagnostics": "editor.cm.noDiagnostics",
  "folded code": "editor.cm.foldedCode",
  "Folded lines": "editor.cm.foldedLines",
  "Unfolded lines": "editor.cm.unfoldedLines",
  to: "editor.cm.foldTo",
  unfold: "editor.cm.unfold",
  "Fold line": "editor.cm.fold",
  "Unfold line": "editor.cm.unfold",
  Accept: "editor.cm.mergeAccept",
  Reject: "editor.cm.mergeReject",
  "Revert this chunk": "editor.cm.mergeRevert",
};

/**
 * 带数字的几条：`EditorState.phrase` 先查表、再把译文里的 `$` 换成真数，
 * 所以这里把 `{...}` 占位填成一个字面的 `$`，交给引擎去替换第二位。
 */
const NUMBERED: Record<string, [TranslationKey, string]> = {
  "replaced $ matches": ["editor.cm.replacedCount", "count"],
  "replaced match on line $": ["editor.cm.replacedOnLine", "line"],
  "$ unchanged lines": ["editor.cm.mergeUnchanged", "count"],
};

function phraseFor(source: string): string {
  const numbered = NUMBERED[source];
  if (numbered) return translate(numbered[0], { [numbered[1]]: "$" });
  const key = PLAIN[source];
  return key ? translate(key) : source;
}

const map: Record<string, string> = {};
for (const source of [...Object.keys(PLAIN), ...Object.keys(NUMBERED)]) {
  Object.defineProperty(map, source, {
    enumerable: true,
    configurable: true,
    get: () => phraseFor(source),
  });
}

/** 直接 `EditorState.phrases.of(cmPhrases)`；对象身份恒定，不需要随语言重配。 */
export const cmPhrases: Record<string, string> = map;

/**
 * 原串 → i18n 键的这张表本身。
 *
 * 导出只为让测试能逐条查：漏一句、键写错都不会报错，运行时只会得到一句英文，
 * 而那是只有打开查找面板才看得见的小毛病。
 */
export function cmPhraseKeys(): Array<[string, TranslationKey]> {
  return [
    ...Object.entries(PLAIN),
    ...Object.entries(NUMBERED).map(([source, item]) => [source, item[0]] as [string, TranslationKey]),
  ];
}
