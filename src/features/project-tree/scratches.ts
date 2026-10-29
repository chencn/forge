/**
 * Scratches 临时文件服务
 *
 * 临时文件保存在应用数据目录的 `scratches` 子目录下（如 <appData>/scratches）。
 * 支持独立于项目的快速试验、代码草稿与格式化演练，对齐 IntelliJ IDEA / openidea 的标准实现。
 */

import { appDataDir, homeDir } from "@tauri-apps/api/path";
import { createFolder, createFile, listDirectory, type FsEntry } from "../../lib/fs";

export interface ScratchLanguage {
  readonly id: string;
  readonly name: string;
  readonly ext: string;
}

/** 常用临时文件语言与对应扩展名 */
export const SCRATCH_LANGUAGES: readonly ScratchLanguage[] = [
  { id: "text", name: "Plain Text", ext: "txt" },
  { id: "markdown", name: "Markdown", ext: "md" },
  { id: "json", name: "JSON", ext: "json" },
  { id: "typescript", name: "TypeScript", ext: "ts" },
  { id: "javascript", name: "JavaScript", ext: "js" },
  { id: "rust", name: "Rust", ext: "rs" },
  { id: "python", name: "Python", ext: "py" },
  { id: "html", name: "HTML", ext: "html" },
  { id: "css", name: "CSS", ext: "css" },
  { id: "sql", name: "SQL", ext: "sql" },
  { id: "shell", name: "Shell Script", ext: "sh" },
  { id: "xml", name: "XML", ext: "xml" },
  { id: "yaml", name: "YAML", ext: "yaml" },
  { id: "toml", name: "TOML", ext: "toml" },
] as const;

let scratchesDirPathPromise: Promise<string> | null = null;

/**
 * 获取 Scratches 根目录绝对路径（首次调用会自动创建该文件夹）
 */
export async function getScratchesDir(): Promise<string> {
  if (scratchesDirPathPromise) {
    return scratchesDirPathPromise;
  }

  scratchesDirPathPromise = (async () => {
    let base: string;
    try {
      base = await appDataDir();
    } catch {
      try {
        base = await homeDir();
      } catch {
        base = typeof window !== "undefined" && window.location ? "/tmp" : "C:\\Users\\Default\\scratches";
      }
    }

    const cleanBase = base.replace(/[\\/]+$/, "");
    const scratchesPath = `${cleanBase}/scratches`.replaceAll("\\", "/");

    try {
      await createFolder(scratchesPath);
    } catch {
      // 目录已存在或忽略创建异常
    }

    return scratchesPath;
  })();

  scratchesDirPathPromise.catch(() => {
    scratchesDirPathPromise = null;
  });

  return scratchesDirPathPromise;
}

/**
 * 根据现有文件名列表，计算下一个可用的 scratch 文件名
 * 规则：`scratch.<ext>` -> `scratch_1.<ext>` -> `scratch_2.<ext>` ...
 */
export function getNextScratchName(existingNames: readonly string[], ext: string): string {
  const cleanExt = ext.replace(/^\./, "");
  const baseName = `scratch.${cleanExt}`.toLowerCase();
  const lowerExisting = new Set(existingNames.map((n) => n.toLowerCase()));

  if (!lowerExisting.has(baseName)) {
    return `scratch.${cleanExt}`;
  }

  let index = 1;
  while (index < 10000) {
    const candidate = `scratch_${index}.${cleanExt}`;
    if (!lowerExisting.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }

  return `scratch_${Date.now()}.${cleanExt}`;
}

/**
 * 创建一个新的 Scratch 临时文件
 * @param language 目标编程语言，默认 Plain Text
 * @returns 创建好的 FsEntry
 */
export async function createScratchFile(language: ScratchLanguage = SCRATCH_LANGUAGES[0]): Promise<FsEntry> {
  const dir = await getScratchesDir();
  let existingNames: string[] = [];

  try {
    const listing = await listDirectory(dir);
    existingNames = listing.entries.map((e) => e.name);
  } catch {
    existingNames = [];
  }

  const fileName = getNextScratchName(existingNames, language.ext);
  const fullPath = `${dir}/${fileName}`.replaceAll("\\", "/");

  return createFile(fullPath);
}
