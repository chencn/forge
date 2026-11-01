/**
 * 虚拟文档的 URI 与编辑器内部键。
 *
 * URI 只能作为身份保存，不能直接交给文件系统、路径归一化或写盘接口。内部键明确
 * 带 `virtual:` 前缀，并把完整 URI 编码进去；这样现有页签和 CodeMirror 仍可用字符串
 * 键工作，同时不会把 `untitled:`、`inmemory:` 等协议误当成本地路径。
 */

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
const VIRTUAL_PREFIX = "virtual:lsp/";

/** 返回 URI 的 scheme；无 scheme 的值不是可注册的虚拟 URI。 */
export function uriScheme(uri: string): string | null {
  const match = URI_SCHEME.exec(uri);
  return match ? match[0].slice(0, -1).toLowerCase() : null;
}

/** `file:` URI 属于磁盘文档，不能进入虚拟文档容器。 */
export function isFileUri(uri: string): boolean {
  return uriScheme(uri) === "file";
}

/** 只有带 scheme 且不是 `file:` 的 URI 才能注册为虚拟文档。 */
export function isVirtualUri(uri: string): boolean {
  return uri.length > 0 && !WINDOWS_PATH.test(uri) && uriScheme(uri) !== null && !isFileUri(uri);
}

/** 把虚拟 URI 映射为稳定的内部键；非法或磁盘 URI 返回 null。 */
export function virtualDocumentKey(uri: string): string | null {
  if (!isVirtualUri(uri)) return null;
  return `${VIRTUAL_PREFIX}${encodeURIComponent(uri)}`;
}

/** 只认本模块生成的键，避免把普通的 `virtual:` 伪路径当成可还原 URI。 */
export function isVirtualDocumentKey(path: string): boolean {
  return path.startsWith(VIRTUAL_PREFIX);
}

