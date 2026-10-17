import type { TranslationKey } from "../i18n/lang/zh";
import type { EntryKind } from "./fs";

export interface DropSplit {
  files: string[];
  folders: string[];
}

/** 拖进来的路径按类型拆开：文件夹进项目，其余都当文件暂时打开。 */
export function splitDrop(entries: readonly { path: string; kind: EntryKind }[]): DropSplit {
  const files: string[] = [];
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory") folders.push(entry.path);
    else files.push(entry.path);
  }
  return { files, folders };
}

/** 悬停提示用的文案键。还没分出类型，或一条都认不出时，先给一句笼统的。 */
export function dropHintKey(files: number, folders: number, pending: boolean): TranslationKey {
  if (pending || (files === 0 && folders === 0)) return "drop.pending";
  if (files > 0 && folders > 0) return "drop.mixed";
  if (folders > 1) return "drop.folders";
  if (folders === 1) return "drop.folder";
  if (files > 1) return "drop.files";
  return "drop.file";
}
