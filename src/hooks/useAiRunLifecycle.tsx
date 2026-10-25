import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { archiveAiRuntimeSession, pinAiRuntimeSession, deleteAiRuntimeSession } from "../lib/aiRuntime";
import type { AiSessionAction } from "../lib/aiSessions";

/**
 * 关闭/删除 AI 标签时的处理。
 *
 * 关闭运行中的会话**默认后台继续**：只关标签，任务留着跑，不弹确认框——真要停，
 * 在会话里点停止（那里有完整的队列与状态）。删除仍走 `deleteAiRuntimeSession`，
 * 由后端先停运行再删记录，不会留下孤儿任务。
 */
export function useAiRunLifecycle(reportError: (message: string) => void) {
  /**
   * 请求关闭一个会话标签：直接关。运行中的任务由全局运行时继续推进，
   * 重开会话即可看到后续进度（侧栏状态点/旋转标记同步指示）。
   */
  const closeSession = useCallback((_id: string, close: () => void) => {
    close();
  }, []);
  /**
   * 重命名/归档/删除的统一入口：先动后端（删除还要停运行、删记录），成功后再改本地状态。
   * 后端失败就不动本地，避免两边记录对不上。
   *
   * 归档不需要先停运行：它只是从默认列表里收起来，任务照旧在跑，标签也还在。
   */
  const act = useCallback(async (action: AiSessionAction, workspace: string | null, dispatch: (action: AiSessionAction) => void) => {
    try {
      if (action.type === "delete" && workspace) await deleteAiRuntimeSession(action.id, workspace);
      if (action.type === "rename" && workspace) await invoke("ai_runtime_rename", { sessionId: action.id, workspace, title: action.title });
      if (action.type === "archive" && workspace) await archiveAiRuntimeSession(action.id, workspace, action.archived);
      if (action.type === "pin" && workspace) await pinAiRuntimeSession(action.id, workspace, action.pinned);
      dispatch(action);
    } catch (error) { reportError(String(error)); }
  }, [reportError]);
  return { closeSession, act };
}
