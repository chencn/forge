import { invoke } from "@tauri-apps/api/core";
import type { FileContent } from "./fs";

/**
 * 历史按文档所属工作区持久化；读取失败与空历史必须分别呈现。
 */

/** 一条快照的元信息（不含正文），列清单用，对应 Rust `SnapshotInfo`。 */
export interface SnapshotInfo {
  /** 保存成功那刻的 unix 毫秒。 */
  savedAt: number;
  /** 那一版有多少个字符。 */
  chars: number;
  lineEnding: string;
  hasBom: boolean;
  encoding: string;
}

/** 一条完整快照（含正文、不含字数），取详情与记录时用，对应 Rust `Snapshot`。 */
export interface SnapshotFull {
  event?: string;
  savedAt: number;
  contents: string;
  lineEnding: string;
  hasBom: boolean;
  encoding: string;
}

/** 记录磁盘或编辑器版本；恢复前的保护快照失败时，调用方必须停止恢复。 */
export function recordSnapshot(
  root: string,
  path: string,
  snapshot: SnapshotFull
): Promise<void> {
  if (!root) return Promise.resolve();
  return invoke<void>("local_history_record", { root, path, snapshot });
}

/** 列一个文件的历史（最新在前，不含正文）。 */
export function listSnapshots(root: string, path: string): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>("local_history_list", { root, path });
}

/** 取某一条快照的完整正文；没有那条时回 null。 */
export function getSnapshot(
  root: string,
  path: string,
  savedAt: number
): Promise<SnapshotFull | null> {
  return invoke<SnapshotFull | null>("local_history_get", { root, path, savedAt });
}

/**
 * 把某一条快照写回那个文件（走保存那条原子写：认原行尾、原编码、原 BOM）。
 * 回写盘现状，调用方据此把编辑器文档刷成这一版。
 */
export function restoreSnapshot(
  root: string,
  path: string,
  savedAt: number,
  expectModifiedMs?: number,
): Promise<FileContent> {
  return invoke<FileContent>("local_history_restore", { root, path, savedAt, ...(expectModifiedMs === undefined ? {} : { expectModifiedMs }) });
}

/** 目录列表里的一条历史修订（快照或标签）。 */
export interface HistoryEntry {
  path: string;
  savedAt: number;
  chars: number;
  label: string;
  kind: "snapshot" | "label";
}

/** 一个目录的历史：修订列表 + 已删除的文件名。 */
export interface DirectoryHistory { entries: HistoryEntry[]; deleted: string[] }

/** 列一个目录的历史修订与已删除文件。 */
export function listDirectoryHistory(root: string, path: string): Promise<DirectoryHistory> {
  return invoke("local_history_list_dir", { root, path });
}

/** 按事件（保存/外部改动）抓一份当前快照。 */
export function captureHistory(root: string, path: string, event: string): Promise<void> {
  return invoke("local_history_capture", { root, path, event });
}

/** 给某次修订打标签；可附带把选中文件的同刻快照一起写进标签。 */
export function putHistoryLabel(root: string, path: string, label: string, snapshots: (SnapshotFull & { path: string })[] = []): Promise<void> {
  return invoke("local_history_put_label", { root, path, label, ...(snapshots.length ? { snapshots } : {}) });
}

/** 标签取时刻之前每个文件的最后修订；多选修订只允许在同一文件内比较。 */
export function snapshotsBefore(entries: HistoryEntry[], label: HistoryEntry, scope: string): HistoryEntry[] {
  const key = (path: string) => path.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  const scopeKey = key(scope);
  const labelKey = key(label.path);
  const versions = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    const path = key(entry.path);
    if (entry.kind !== "snapshot" || entry.savedAt >= label.savedAt || (path !== scopeKey && !path.startsWith(`${scopeKey}/`))) continue;
    if (path !== labelKey && !path.startsWith(`${labelKey}/`)) continue;
    const previous = versions.get(path);
    if (!previous || previous.savedAt < entry.savedAt) versions.set(path, entry);
  }
  return [...versions.values()];
}

/** 标签时刻之前（同一目录范围内）每个文件的最后一份快照。 */
export function revisionRange(entries: HistoryEntry[]): [HistoryEntry, HistoryEntry] | null {
  const snapshots = entries.filter((entry) => entry.kind === "snapshot").sort((a, b) => a.savedAt - b.savedAt);
  if (snapshots.length < 2 || snapshots.some((entry) => entry.path !== snapshots[0].path)) return null;
  return [snapshots[0], snapshots[snapshots.length - 1]];
}
