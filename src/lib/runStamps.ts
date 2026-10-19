/**
 * 运行输出的行首时间戳（字节层面）。
 *
 * 构建工具大多不给自己打时钟，「这一段卡在哪会儿」从日志里读不出来。这里在写进终端之前
 * 给每一行行首补一个 `HH:mm:ss.SSS`；本来就带时间的行（Spring Boot 这类）原样放过，不叠两个钟。
 *
 * 必须在字节上做：一块的边界可能落在 UTF-8 多字节字符或转义序列中间，按字符解码会把那半个字打散。
 * `\r`(0x0D)、`\n`(0x0A)、ESC(0x1B) 这些控制字节不会出现在 UTF-8 多字节序列内部，按字节找行首是安全的。
 *
 * 只在「确定是新起一行」的位置盖章：上一块恰好停在换行符上，这一行的开头才是行开头。
 */

/** 行首已有的时钟写法：`10:12:33`、`2026-08-08T10:12:33.123`、ISO 的空格分隔变体。 */
const LEADING_TIME = /^\s*(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}/;

const CR = 13;
const LF = 10;
const ESC = 27;

/** 跨块的盖章状态。`atLineStart`：下一个字节落不落在行首。新会话、整屏重放后置回 true。 */
export interface StampState {
  atLineStart: boolean;
}

/** `Date` → `HH:mm:ss.SSS`（本地时区，定宽）。 */
export function formatStamp(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3,
  )}`;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * 给一块字节里新起头且没有自带时间的行补时间戳。
 *
 * 不动的情况：行首是 ESC（颜色 / 控制序列，戳进去会把序列劈开）、空行、行首已有时钟。
 * `\r`（进度条原地重写）也算新行开始：盖在同一行上，后一个戳顶掉前一个。
 * 一处都不用盖时原样返回同一个数组，不复制。
 */
export function stampBytes(data: Uint8Array, state: StampState, stamp: string): Uint8Array {
  if (data.length === 0) return data;
  const stampBytes = TEXT_ENCODER.encode(`${stamp} `);
  const inserts: number[] = [];
  let atStart = state.atLineStart;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (atStart && byte !== LF && byte !== CR && byte !== ESC && !hasLeadingTimeAt(data, i)) {
      inserts.push(i);
    }
    if (byte === LF || byte === CR) {
      atStart = true;
    } else if (atStart) {
      // 这一行已经开口，行中不再算行首。
      atStart = false;
    }
  }
  state.atLineStart = atStart;
  if (inserts.length === 0) return data;
  const out = new Uint8Array(data.length + inserts.length * stampBytes.length);
  let cursor = 0;
  let written = 0;
  for (const at of inserts) {
    out.set(data.subarray(cursor, at), written);
    written += at - cursor;
    out.set(stampBytes, written);
    written += stampBytes.length;
    cursor = at;
  }
  out.set(data.subarray(cursor), written);
  return out;
}

/**
 * 从 `from`（保证是行首）起，这一行是不是已经带时钟。
 * 只扫行首一小截 ASCII；撞上多字节、转义或换行就收——那几种写法都排不出时钟。
 */
function hasLeadingTimeAt(data: Uint8Array, from: number): boolean {
  let end = from;
  const limit = Math.min(data.length, from + 40);
  while (end < limit) {
    const byte = data[end];
    if (byte === LF || byte === CR || byte === ESC || byte >= 0x80) break;
    end += 1;
  }
  if (end === from) return false;
  let text = "";
  for (let i = from; i < end; i += 1) text += String.fromCharCode(data[i]);
  return LEADING_TIME.test(text);
}
