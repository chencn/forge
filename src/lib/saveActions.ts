/** 保存前的本地卫生动作；只接收编辑器里的 LF 文本，不碰磁盘编码与行尾。 */
export interface SaveActionOptions {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  /** 活动编辑器当前行（从 1 起）；该行不裁尾随空白，避免保存时光标所在行跳动。 */
  protectedLine?: number;
}

export interface SaveActionResult {
  text: string;
  changed: boolean;
}

/**
 * 应用不依赖编辑器引擎的保存动作。
 *
 * 顺序固定为先裁尾随空白、再补末尾换行。两项都只操作正文，CRLF/BOM/编码由文档保存链保留。
 */
export function applySaveActions(text: string, options: SaveActionOptions): SaveActionResult {
  let next = text;
  if (options.trimTrailingWhitespace) {
    const lines = next.split("\n");
    next = lines
      .map((line, index) => {
        const lineNumber = index + 1;
        return lineNumber === options.protectedLine ? line : line.replace(/[ \t]+$/u, "");
      })
      .join("\n");
  }
  if (options.insertFinalNewline && next.length > 0 && !next.endsWith("\n")) next += "\n";
  return { text: next, changed: next !== text };
}
