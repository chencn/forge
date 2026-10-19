/** 到这么多行就先问一句：多行粘贴进 shell，每一行都会被当成一条命令执行。 */
export const PASTE_CONFIRM_LINES = 5;
/** 一大段没有换行的文字同样先问：多半是复制错了东西。 */
export const PASTE_CONFIRM_CHARS = 1000;

/** 一段要粘贴的文字有几行。 */
export function pasteLineCount(text: string): number {
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

/** 这段粘贴要不要先让人确认。 */
export function pasteNeedsConfirm(text: string): boolean {
  return pasteLineCount(text) >= PASTE_CONFIRM_LINES || text.length >= PASTE_CONFIRM_CHARS;
}
