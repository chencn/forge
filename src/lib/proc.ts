import { invoke } from "@tauri-apps/api/core";
import type { EnvVar } from "./runConfigs";

/** 后端分配的运行会话 id。 */
export type ProcSessionId = string;

/** 一段进程输出：`data` 是 base64 的原始字节。 */
export interface ProcChunk {
  id: ProcSessionId;
  data: string;
}

/** 进程结束事件。 */
export interface ProcExit {
  id: ProcSessionId;
  /** 退出码；被停止或取不到时为 null。 */
  code: number | null;
}

/**
 * 用系统 shell 跑一行命令，输出走 proc://output 事件。
 *
 * `env` 是这条配置自带的变量，叠在本进程环境之上；空数组就是完全继承。
 */
export function procStart(cwd: string, line: string, env: EnvVar[]): Promise<ProcSessionId> {
  return invoke<ProcSessionId>("proc_start", { cwd, line, env });
}

export function procKill(id: ProcSessionId): Promise<void> {
  return invoke<void>("proc_kill", { id });
}
