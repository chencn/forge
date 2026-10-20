import { invoke } from "@tauri-apps/api/core";
import type { FileContent } from "./fs";

/**
 * 本地历史的前端封装，对应后端 `src-tauri/src/local_history.rs` 那四条命令。
 *
 * 只在「保存成功」那一刻打一条快照；列历史、比对、恢复各一条。快照按工作区分桶，
 * 所以每条命令都要带上工作区根与文件绝对路径两样。根为空（工程外打开的文件）时不记。
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
  savedAt: number;
  contents: string;
  lineEnding: string;
  hasBom: boolean;
  encoding: string;
}

/** 保存成功后打一条快照。失败静默：历史是兜底，不该因为它把保存这条主路报错。 */
export function recordSnapshot(
  root: string,
  path: string,
  snapshot: SnapshotFull
): Promise<void> {
  if (!root) return Promise.resolve();
  return invoke<void>("local_history_record", { root, path, snapshot }).catch(() => {});
}

/** 列一个文件的历史（最新在前，不含正文）。 */
export function listSnapshots(root: string, path: string): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>("local_history_list", { root, path }).catch(() => []);
}

/** 取某一条快照的完整正文；没有那条时回 null。 */
export function getSnapshot(
  root: string,
  path: string,
  savedAt: number
): Promise<SnapshotFull | null> {
  return invoke<SnapshotFull | null>("local_history_get", { root, path, savedAt }).catch(
    () => null
  );
}

/**
 * 把某一条快照写回那个文件（走保存那条原子写：认原行尾、原编码、原 BOM）。
 * 回写盘现状，调用方据此把编辑器文档刷成这一版。
 */
export function restoreSnapshot(
  root: string,
  path: string,
  savedAt: number
): Promise<FileContent> {
  return invoke<FileContent>("local_history_restore", { root, path, savedAt });
}
