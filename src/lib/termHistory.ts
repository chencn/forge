/** `CSI 3 J`：擦掉全部滚屏。ConPTY 重画视口时会带上它，滚出屏幕的行就没了。 */
const ERASE_SCROLLBACK = [0x1b, 0x5b, 0x33, 0x4a];

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

/**
 * 从 PTY 字节里拿掉擦滚屏序列。
 *
 * 序列可能被切在两包之间，所以用 `carry` 记住上一包末尾那截前缀。
 * 其余字节原样留下，清屏按钮走 `term.clear()`，不经过这里。
 */
export function stripEraseScrollback(carry: Uint8Array, chunk: Uint8Array): StripResult {
  const combined =
    carry.byteLength === 0 ? chunk : concatBytes(carry, chunk);
  const kept: number[] = [];
  let removed = false;
  let index = 0;
  while (index < combined.length) {
    if (combined[index] === ERASE_SCROLLBACK[0]) {
      if (isMarker(combined, index)) {
        removed = true;
        index += ERASE_SCROLLBACK.length;
        continue;
      }
      if (isMarkerPrefix(combined, index)) {
        return { carry: combined.slice(index), data: Uint8Array.from(kept) };
      }
    }
    kept.push(combined[index]);
    index += 1;
  }
  if (!removed && carry.byteLength === 0) {
    return { carry: new Uint8Array(0), data: chunk };
  }
  return { carry: new Uint8Array(0), data: Uint8Array.from(kept) };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}
