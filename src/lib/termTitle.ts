/** 标题里混进半截控制序列时的样子：转义被切断，只剩下 `[?25h` 或 `]0;` 这样的尾巴。 */
const LEAKED_CSI = /\[(?:\?[0-9;]*|[0-9;]*)[JKhlm]/u;
const LEAKED_OSC = /\](?:0|1|2);/u;
/** ConPTY 把控制台标题报成可执行文件的全路径，cmd 跑命令时还会在后面接「 - 命令」。 */
const LEADING_EXE = /^(?:[A-Za-z]:)?[\\/](?:[^\\/]+[\\/])*([^\\/]+?)\.exe\b/iu;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

/**
 * 程序用 OSC 0/2 报上来的标题，整理成能放进页签的样子；不能用时返回 null，页签退回 shell 名。
 *
 * `C:\Windows\System32\cmd.exe - npm run dev` 只留 `cmd - npm run dev`：整条路径挤在页签上看不出是哪个。
 */
export function normalizeTermTitle(raw: string): string | null {
  const title = raw.trim();
  if (
    !title ||
    title.includes("\ufffd") ||
    hasControlCharacter(title) ||
    LEAKED_CSI.test(title) ||
    LEAKED_OSC.test(title)
  ) {
    return null;
  }
  return title.replace(LEADING_EXE, "$1");
}

const TAB_TITLE_LIMIT = 32;

/**
 * 标题够不够格上页签：太长的、`user@host: ~/dir` 那种、带路径的都不要，
 * 页签放不下也认不出是哪个，不如退回 shell 名。悬停提示里仍有完整标题。
 */
export function isTabWorthyTitle(title: string | null): title is string {
  if (!title) return false;
  if (title.length > TAB_TITLE_LIMIT) return false;
  return !/[@\\/]/u.test(title);
}
