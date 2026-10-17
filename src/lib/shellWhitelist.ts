/** 用户追加的扩展名：去掉空白和前导点，小写，只留字母数字和 _ + -。 */
export function canonicalExtension(raw: string): string | null {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("*.")
    ? trimmed.slice(2)
    : trimmed.startsWith(".")
      ? trimmed.slice(1)
      : trimmed;
  const text = stripped.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_+-]{0,31}$/.test(text)) return null;
  return text;
}

/**
 * 往用户名单末尾追加一条。
 *
 * 内置格式和已经追加过的都不改原名单，重复添加等于没发生。
 */
export function appendExtraExtension(
  extras: string[],
  raw: string,
  builtin: readonly string[]
): string[] {
  const ext = canonicalExtension(raw);
  if (!ext) return extras;
  if (builtin.some((item) => item.toLowerCase() === ext)) return extras;
  if (extras.some((item) => item.toLowerCase() === ext)) return extras;
  return [...extras, ext];
}

/** 把一份用户名单收干净：非法的丢掉，内置的丢掉，重复的只留第一次。 */
export function normalizeExtraExtensions(
  raw: readonly string[] | undefined,
  builtin: readonly string[] = []
): string[] {
  let extras: string[] = [];
  for (const item of raw ?? []) {
    extras = appendExtraExtension(extras, String(item), builtin);
  }
  return extras;
}
