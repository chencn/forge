/**
 * 运行输出的严重级别行标记。
 *
 * 照 Lithe-IDEA 的 `OutputTextView.severity`：整行按日志级别着色，在日志墙上划出可扫读的色带。
 * 但它直接改文本颜色，跟构建工具自己的 ANSI 颜色打架。这里改成不动文本，只在行左缘画一格
 * 色条、在滚动条旁的概览标尺上记一笔——工具的红字照旧是红字，色条只负责「这行值得回头看」。
 *
 * 级别认整词：`[ERROR]`、`ERROR:`、`WARN ...`，认不出 `src/main/java/Error.java` 里的 Error。
 */

export type RunSeverity = "error" | "warning";

/**
 * 级别词必须是独立的一段：行首、方括号或空白开头，紧跟 `]`、空白或冒号收尾。
 * 这样路径里的 `WARN`、`Error.java` 不会被当成错误行。
 */
const SEVERITY = /(?:^|\s|\[)(ERROR|SEVERE|FATAL|WARN(?:ING)?)(?:\]|\s|:)/;

/** 这一行是不是错误 / 警告级别；拿不准返回 null。 */
export function severityOfLine(line: string): RunSeverity | null {
  const match = SEVERITY.exec(line);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith("WARN")) return "warning";
  return "error";
}

/** xterm 的装饰颜色只认 #RRGGBB，取不了设计令牌。 */
export function severityStripe(severity: RunSeverity, dark: boolean): { cell: string; ruler: string } {
  if (severity === "error") {
    return dark ? { cell: "#e5534b", ruler: "#e5534b" } : { cell: "#cf222e", ruler: "#cf222e" };
  }
  return dark ? { cell: "#d19a4a", ruler: "#d19a4a" } : { cell: "#9a6700", ruler: "#9a6700" };
}

/**
 * 扫 `from`..`to`（绝对行号，含头尾）里的行，命中错误 / 警告就交出去。
 *
 * 纯函数、不碰 xterm：`getLine` 由调用方给（读缓冲的一行文本），`onHit` 里画色条。
 * 调用方自己记着看到第几行，每次只扫新滚进去的那一段。
 */
export function scanSeverityRange(
  from: number,
  to: number,
  getLine: (absoluteLine: number) => string | undefined,
  onHit: (absoluteLine: number, severity: RunSeverity) => void,
): void {
  for (let line = from; line <= to; line += 1) {
    const text = getLine(line);
    if (text === undefined) continue;
    const severity = severityOfLine(text);
    if (severity) onHit(line, severity);
  }
}
