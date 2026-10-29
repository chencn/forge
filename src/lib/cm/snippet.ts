/**
 * server 的 snippet 模板换成 CodeMirror 认的那种。
 *
 * 两边都写 `${1:文本}`，差在三处：
 * 一、LSP 允许把 `${1}` 简写成 `$1`，而 CodeMirror 的解析器只认带花括号的；
 * 二、LSP 的 choices（`${1|a,b|}`，在几个候选之间按 Tab 挑）CodeMirror 没有，取第一项当默认文本；
 * 三、LSP 里同一个停靠点可以再写一次（`$1`）当镜像，敲进去的内容几处一起变；
 *     CodeMirror 的 `${1}` 若不带默认文本就只留一个空位，那一处的文字就丢了——
 *     所以把第一次出现时那份默认文本补回去。
 *     （这一版 CodeMirror 就算同名的字段也只选中第一处，所以补的是「文字不丢」，
 *     几处一起改还做不到：那是引擎侧字段选择的行为。）
 */

/** choices 的 `${1|a,b|}`：留下第一项当默认文本。 */
const CHOICE = /\$\{(\d+)\|([^|]*)\|\}/g;

/** 一个停靠点：`$1`、`${1}` 或 `${1:文本}`；带 `|` 的 choices 已经在上一步归一成 `:` 那种。 */
const STOP = /\$\{(\d+)(?::([^{}]*))?\}|\$(\d+)/g;

/** 停靠点的默认文本里放不下这两样字符，CodeMirror 的解析器就是按它们分界的。 */
const UNSHAREABLE = /[{}]/;

export function cmSnippet(template: string): string {
  const normalized = template.replace(CHOICE, (_all, index: string, choices: string) => `\${${index}:${choices.split(",")[0]}}`);
  const defaults = new Map<string, string>();
  return normalized.replace(STOP, (all: string, braced?: string, text?: string, bare?: string) => {
    const index = braced ?? bare;
    if (!index) return all;
    if (text !== undefined) {
      if (index !== "0" && !defaults.has(index)) defaults.set(index, text);
      return all;
    }
    // `$0` 是「填完之后的光标位」，不是要人改的字段：补成 `${0}` 就够了，别塞默认文本。
    if (index === "0") return "${0}";
    const mirror = defaults.get(index);
    // 没见过带文本的那一次就原样留着：补一个空占位不如让人看见这里本来要填什么。
    return mirror && !UNSHAREABLE.test(mirror) ? `\${${index}:${mirror}}` : `\${${index}}`;
  });
}
