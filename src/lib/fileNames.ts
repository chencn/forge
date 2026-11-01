/**
 * 为复制操作生成一个不覆盖现有条目的名称。
 *
 * 名称比较按 Windows/IDEA 文件树的大小写不敏感口径处理；扩展名保持在副本后缀之后，
 * `.env` 这类点开头文件不把首个点误当扩展名。
 */
export function uniqueName(name: string, siblings: Iterable<string>): string {
  const occupied = new Set(Array.from(siblings, (item) => item.toLocaleLowerCase()));
  const key = (value: string) => value.toLocaleLowerCase();
  if (!occupied.has(key(name))) return name;

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let serial = 0;
  while (true) {
    serial += 1;
    const suffix = serial === 1 ? " copy" : ` copy ${serial}`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!occupied.has(key(candidate))) return candidate;
  }
}
