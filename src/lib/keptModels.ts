import { samePath } from "./format";

/**
 * 同时留着的文件 model 数，含当前这篇。
 *
 * 再早的标签还在，正文仍在文档列表里；Monaco 那份（词法、撤销栈）关掉，
 * 切回来用文档正文重建。
 */
export const KEPT_FILE_MODELS = 8;

/** 最近看过、并且还开着的路径，当前这篇排最前，最多 `limit` 条。 */
export function nextKeptPaths(
  previous: readonly string[],
  activePath: string | null,
  openPaths: readonly string[],
  limit = KEPT_FILE_MODELS
): string[] {
  const open = (path: string) => openPaths.some((item) => samePath(item, path));
  const ordered =
    activePath && open(activePath)
      ? [activePath, ...previous.filter((path) => !samePath(path, activePath) && open(path))]
      : previous.filter(open);
  return ordered.slice(0, limit);
}
