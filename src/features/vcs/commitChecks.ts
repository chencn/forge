/** Windows 保留设备名，做提交路径校验用。 */
const WINDOWS_RESERVED = new Set(
  ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"],
);

/** Windows 文件名的非法字符（含控制字符）。 */
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001f]/;

/** 这次提交新加进来的路径。已跟踪文件的名字不是这次提交引入的。 */
export function isNewCommitPath(change: { untracked: boolean; indexStatus: string } | undefined): boolean {
  if (!change) return false;
  if (change.untracked) return true;
  const index = change.indexStatus.trim();
  return index === "A" || index === "R" || index === "C";
}

/**
 * Windows 拒绝的路径段。保留名看去掉扩展名后的主干，非法字符看每一段。

 */
export function badCommitNames(paths: readonly string[]): { reserved: string[]; invalid: string[] } {
  const reserved: string[] = [];
  const invalid: string[] = [];
  for (const path of paths) {
    let reservedHit = false;
    let invalidHit = false;
    for (const name of path.split(/[\\/]/)) {
      if (!name || name === "." || name === "..") continue;
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      if (WINDOWS_RESERVED.has(stem.toUpperCase())) reservedHit = true;
      else if (WINDOWS_INVALID.test(name)) invalidHit = true;
    }
    if (reservedHit) reserved.push(path);
    else if (invalidHit) invalid.push(path);
  }
  return { reserved, invalid };
}
