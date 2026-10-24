/**
 * 从一次粘贴事件里收集图片附件。
 *
 * WebView2 对同一张剪贴板图可能同时出现在 `files` 与 `items` 两路，且两路
 * File 对象的 name 并不一致（一路 image.png、一路空名）——按 name 去重会漏，
 * 于是粘贴一张图出现两个附件。所以这里：`files` 有图就只用 `files`，
 * `items` 只在 `files` 为空时回退；再用不含 name 的内容指纹兜底，
 * 同一次粘贴里的重复条目（同一底层 blob 的 size/type/lastModified 必然一致）
 * 合并成一张。跨次粘贴不算重复：每次粘贴是独立的附加意图。
 */
export function collectPastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const isImage = (file: File) => file.type.startsWith("image/");
  const fromFiles = Array.from(data.files).filter(isImage);
  const source = fromFiles.length
    ? fromFiles
    : Array.from(data.items).flatMap((item) =>
        item.kind === "file" && item.getAsFile() ? [item.getAsFile()!] : []
      ).filter(isImage);
  return [...new Map(source.map((file) => [`${file.size}:${file.type}:${file.lastModified}`, file])).values()];
}
