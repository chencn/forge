/**
 * 终端 / 运行输出共用的查找与取文本工具。
 *
 * 运行窗口本质上就是一个只读的终端：查找高亮的配色、把整段滚屏读成纯文本这两件事，
 * 两边要是一模一样，否则同一个关键字在终端里是暖黄、在运行里变了颜色，看着就像坏了。
 * 所以从 `TerminalHost` 里挪出来放这一处，两边都引它。
 */

import type { Terminal } from "@xterm/xterm";

/** 查找高亮。xterm 只认 #RRGGBB，取不了设计令牌。 */
export function findDecorations(dark: boolean) {
  return dark
    ? {
        matchBackground: "#4a3a10",
        matchBorder: "#8a6d1e",
        matchOverviewRuler: "#8a6d1e",
        activeMatchBackground: "#b45309",
        activeMatchBorder: "#f59e0b",
        activeMatchColorOverviewRuler: "#f59e0b",
      }
    : {
        matchBackground: "#fde68a",
        matchBorder: "#f5c542",
        activeMatchBackground: "#f59e0b",
        activeMatchBorder: "#b45309",
        activeMatchColorOverviewRuler: "#b45309",
        matchOverviewRuler: "#f5c542",
      };
}

/** 整段缓冲转成纯文本；被软换行折开的行接回去，行尾空白去掉。 */
export function bufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.map((line) => line.trimEnd()).join("\n");
}
