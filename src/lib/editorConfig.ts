import { readFile } from "./fs";
import { basenameOf, joinPath, parentPath, pathWithin, samePath } from "./format";

/** 文件级代码样式；未出现的字段交给全局设置。 */
export interface EditorConfig {
  tabSize?: number;
  insertSpaces?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  lineEnding?: "lf" | "crlf";
}

/** 一个 `[pattern]` 节的匹配模式与键值。 */
interface EditorConfigSection {
  pattern: string;
  values: Record<string, string>;
}

/** 解析结果：是否根配置 + 全部节。 */
interface ParsedEditorConfig {
  root: boolean;
  sections: EditorConfigSection[];
}

/** 文件解析与最终结果各自的缓存有效期。 */
const CACHE_TTL_MS = 1_000;
/** 路径 → 解析结果缓存（含 null，避免反复读不存在的文件）。 */
const fileCache = new Map<string, { at: number; value: ParsedEditorConfig | null }>();
/** 路径 → 生效配置缓存。 */
const resultCache = new Map<string, { at: number; value: EditorConfig }>();

/** 去掉行内 `;`/`#` 注释（跳过转义符）。 */
function stripComment(line: string): string {
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === ";" || char === "#") return line.slice(0, index);
  }
  return line;
}

/** 解析 EditorConfig 的常用语法；未知键保留在中间结果里但不会影响编辑器。 */
export function parseEditorConfig(text: string): ParsedEditorConfig {
  let section: EditorConfigSection | null = null;
  const sections: EditorConfigSection[] = [];
  let root = false;
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = { pattern: line.slice(1, -1).trim(), values: {} };
      if (section.pattern) sections.push(section);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (!section) {
      if (key === "root") root = value === "true";
      continue;
    }
    section.values[key] = value;
  }
  return { root, sections };
}

/** 展开 glob 里的 `{a,b}` 括号（支持嵌套）。 */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start < 0) return [pattern];
  const end = pattern.indexOf("}", start + 1);
  if (end < 0) return [pattern];
  const choices = pattern.slice(start + 1, end).split(",");
  return choices.flatMap((choice) => expandBraces(`${pattern.slice(0, start)}${choice}${pattern.slice(end + 1)}`));
}

/** 把一个 glob 折成等价的正则源码（`**`/`*`/`?`/字符类）。 */
function globSource(pattern: string): string {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end >= 0) {
        const body = pattern.slice(index + 1, end).replace(/[\\^]/gu, "\\$&");
        source += `[${body}]`;
        index = end;
      } else {
        source += "\\[";
      }
    } else {
      source += char.replace(/[\\^$+.|(){}]/gu, "\\$&");
    }
  }
  return source.slice(1);
}

/** 造 glob 的完整正则（含括号展开后的各分支）。 */
function globRegex(pattern: string): RegExp {
  const sources = expandBraces(pattern).map(globSource);
  return new RegExp(`^(?:${sources.join("|")})$`, "u");
}

/** 判定文件是否命中某节的模式；无 `/` 的模式只对文件名匹配。 */
function matches(pattern: string, configDir: string, file: string): boolean {
  const relative = pathWithin(configDir, file)
    ? file.slice(configDir.length).replace(/^[\\/]+/u, "").replaceAll("\\", "/")
    : "";
  if (!relative) return false;
  const target = pattern.includes("/") ? relative : basenameOf(file).replaceAll("\\", "/");
  return globRegex(pattern.replaceAll("\\", "/")).test(target);
}

/** 解析布尔键值；其他取值为 undefined。 */
function booleanValue(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** 解析数值键值（`tab` 与非正数为 undefined）。 */
function numberValue(value: string | undefined): number | undefined {
  if (!value || value === "tab") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** 将按层级合并后的键转成当前编辑器可消费的配置。 */
export function resolveEditorConfig(
  files: Array<{ directory: string; config: ParsedEditorConfig }>,
  file: string
): EditorConfig {
  const values: Record<string, string> = {};
  for (const item of files) {
    for (const section of item.config.sections) {
      if (!matches(section.pattern, item.directory, file)) continue;
      for (const [key, value] of Object.entries(section.values)) {
        if (value === "unset") delete values[key];
        else values[key] = value;
      }
    }
  }
  const tabWidth = numberValue(values.tab_width);
  const indentSize = values.indent_size === "tab" ? tabWidth : numberValue(values.indent_size);
  const result: EditorConfig = {};
  if (indentSize !== undefined) result.tabSize = indentSize;
  else if (tabWidth !== undefined) result.tabSize = tabWidth;
  if (values.indent_style === "space") result.insertSpaces = true;
  if (values.indent_style === "tab") result.insertSpaces = false;
  const trim = booleanValue(values.trim_trailing_whitespace);
  const finalNewline = booleanValue(values.insert_final_newline);
  if (trim !== undefined) result.trimTrailingWhitespace = trim;
  if (finalNewline !== undefined) result.insertFinalNewline = finalNewline;
  if (values.end_of_line === "lf") result.lineEnding = "lf";
  if (values.end_of_line === "crlf") result.lineEnding = "crlf";
  return result;
}

/** 读取并解析 .editorconfig，带 TTL 缓存；文件不存在返回 null。 */
async function readConfig(path: string): Promise<ParsedEditorConfig | null> {
  const key = path.toLowerCase();
  const cached = fileCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value: ParsedEditorConfig | null = null;
  try {
    value = parseEditorConfig((await readFile(path)).contents);
  } catch {
    value = null;
  }
  fileCache.set(key, { at: Date.now(), value });
  return value;
}

/** 从工作区根向当前文件逐层加载配置；最近层覆盖较远层，root=true 截断继续向上搜索。 */
export async function loadEditorConfig(root: string | null, file: string): Promise<EditorConfig> {
  if (!root || !pathWithin(root, file)) return {};
  const key = `${root.toLowerCase()}|${file.toLowerCase()}`;
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const layers: Array<{ directory: string; config: ParsedEditorConfig }> = [];
  let directory = parentPath(file);
  while (directory && pathWithin(root, directory)) {
    const configPath = joinPath(directory, ".editorconfig");
    const config = await readConfig(configPath);
    if (config) {
      layers.unshift({ directory, config });
      if (config.root) break;
    }
    if (samePath(directory, root)) break;
    directory = parentPath(directory);
  }
  const value = resolveEditorConfig(layers, file);
  resultCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 让配置文件发生外部变化时立即放弃旧结果。
 *
 * 这里只清缓存，不碰打开文档；文档状态由 useDocuments 在 watcher 事件中显式刷新，
 * 这样不会把配置更新偷偷变成正文重载，也不会改变 dirty 判定。
 */
export function clearEditorConfigCache(): void {
  fileCache.clear();
  resultCache.clear();
}
