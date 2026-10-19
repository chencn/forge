/**
 * OSC 7 报的当前目录：`file://主机/路径`，路径按 URL 编码。
 *
 * Windows 上的 shell 写成 `file://host/C:/Users/x`，盘符前那条斜杠要去掉。
 * 不是 `file://` 的、没有路径的，返回 null。
 */
export function parseOsc7(payload: string): string | null {
  if (!payload.toLowerCase().startsWith("file://")) return null;
  const pathStart = payload.indexOf("/", "file://".length);
  if (pathStart === -1) return null;
  let path = payload.slice(pathStart);
  try {
    path = decodeURIComponent(path);
  } catch {
    // 编码不全时按原样用，比丢掉强。
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) return path.slice(1).replaceAll("/", "\\");
  return path;
}
