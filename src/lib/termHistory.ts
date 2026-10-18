/** `CSI 3 J`：擦掉全部滚屏。ConPTY 重画视口时会带上它，滚出屏幕的行就没了。 */
const ERASE_SCROLLBACK = [0x1b, 0x5b, 0x33, 0x4a];
const EMPTY = new Uint8Array(0);

export interface StripResult {
  /** 还没凑齐的标记前缀，下一包拼上再判断。 */
  carry: Uint8Array;
  /** 去掉擦滚屏标记之后的字节。 */
  data: Uint8Array;
}

function isMarkerPrefix(bytes: Uint8Array, start: number): boolean {
  const length = bytes.length - start;
  if (length <= 0 || length >= ERASE_SCROLLBACK.length) return false;
  for (let index = 0; index < length; index += 1) {
    if (bytes[start + index] !== ERASE_SCROLLBACK[index]) return false;
  }
  return true;
}

function isMarker(bytes: Uint8Array, start: number): boolean {
  if (start + ERASE_SCROLLBACK.length > bytes.length) return false;
  for (let index = 0; index < ERASE_SCROLLBACK.length; index += 1) {
    if (bytes[start + index] !== ERASE_SCROLLBACK[index]) return false;
  }
  return true;
}

/** 从 `from` 起找下一个完整标记的位置；没有返回 -1。 */
function indexOfMarker(bytes: Uint8Array, from: number): number {
  const last = bytes.length - ERASE_SCROLLBACK.length;
  for (let index = from; index <= last; index += 1) {
    if (bytes[index] !== ERASE_SCROLLBACK[0]) continue;
    if (isMarker(bytes, index)) return index;
  }
  return -1;
}

/** 末尾那截可能还没凑齐的标记从哪儿开始；没有返回 -1。 */
function tailMarkerStart(bytes: Uint8Array, from: number): number {
  for (let length = 1; length < ERASE_SCROLLBACK.length; length += 1) {
    const start = bytes.length - length;
    if (start < from) return -1;
    if (isMarkerPrefix(bytes, start)) return start;
  }
  return -1;
}

/** 把几段拼回一整块；只有一段时直接给那一段，不再拷一次。 */
function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return EMPTY;
  if (parts.length === 1) return parts[0];
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * 从 PTY 字节里拿掉擦滚屏序列。
 *
 * 序列可能被切在两包之间，所以用 `carry` 记住上一包末尾那截前缀。
 * 其余字节原样留下，清屏按钮走 `term.clear()`，不经过这里。
 *
 * 绝大多数包不含这个序列，这条路上一个字节都不该多拷：以前是逐字节往一个 JS 数字数组里塞
 * （每个数字占 8 字节），一条 32KB 的输出就产生 256KB 的临时垃圾，多开几个终端时 GC 全花在这儿。
 * 现在先按标记切段，切不出东西就把原包直接交出去。
 */
export function stripEraseScrollback(carry: Uint8Array, chunk: Uint8Array): StripResult {
  const combined = carry.byteLength === 0 ? chunk : concatBytes(carry, chunk);
  const parts: Uint8Array[] = [];
  let removed = false;
  let cursor = 0;
  for (;;) {
    const at = indexOfMarker(combined, cursor);
    if (at < 0) break;
    removed = true;
    if (at > cursor) parts.push(combined.subarray(cursor, at));
    cursor = at + ERASE_SCROLLBACK.length;
  }
  // 尾巴是半截标记：留着，下一包拼上再判；它前面那些字节先交出去。
  const tail = tailMarkerStart(combined, cursor);
  if (tail >= 0) {
    if (tail > cursor) parts.push(combined.subarray(cursor, tail));
    return { carry: combined.slice(tail), data: join(parts) };
  }
  if (!removed) {
    // 什么都没剥：带上来的前缀已确认不是标记，连同本包原样交出去，不拷。
    return { carry: EMPTY, data: carry.byteLength === 0 ? chunk : combined };
  }
  if (cursor < combined.length) parts.push(combined.subarray(cursor));
  return { carry: EMPTY, data: join(parts) };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}
