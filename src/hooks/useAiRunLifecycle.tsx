import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { archiveAiRuntimeSession, pinAiRuntimeSession, deleteAiRuntimeSession, getAiRunId, isAiSessionRunning, stopAiRun } from "../lib/aiRuntime";
import type { AiSessionAction } from "../lib/aiSessions";

/** 一次等待用户决定的关闭请求。 */
interface CloseRequest {
  /** 会话 id，用于去重（同一会话只排一次）与取当前运行 id。 */
  id: string;
  /** 用户选「后台继续」或「停止并关闭」后真正执行的关闭动作。 */
  close: () => void;
}

/**
 * 关闭/删除 AI 标签时的生命周期处理。
 *
 * 关闭运行中的会话必须先问用户：后台继续（只是关标签，进程留着）还是停止并关闭。
 * 批量关闭会一次涌来多个请求，所以排队逐个问，而不是让后一个对话框覆盖前一个的决定。
 */
export function useAiRunLifecycle(reportError: (message: string) => void) {
  const { t } = useI18n();
  /** 排队中的关闭请求；只渲染队首那个，处理完自动出队。 */
  const [requests, setRequests] = useState<CloseRequest[]>([]);
  /** 是否正在执行「停止」；期间禁用三个按钮，防止重复点击。 */
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = requests[0];
  useEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);
  /**
   * 请求关闭一个会话标签。没在跑就直接关；在跑则入队，等用户在对话框里选。
   * 同一会话重复请求只保留一次，避免连点关出两个对话框。
   */
  const closeSession = useCallback((id: string, close: () => void) => {
    if (!isAiSessionRunning(id)) { close(); return; }
    setRequests((items) => items.some((item) => item.id === id) ? items : [...items, { id, close }]);
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
  /** 处理队首请求：`stop` 为真时先停运行再关，否则只关标签、任务留在后台。 */
  const choose = async (stop: boolean) => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (stop) { const id = getAiRunId(pending.id); if (id) await stopAiRun(id); }
      pending.close(); setRequests((items) => items.slice(1));
    } catch (error) { reportError(String(error)); }
    finally { setBusy(false); }
  };
  return { closeSession, act, dialog: <dialog ref={dialog} className="dialog ai-action-dialog"
    aria-label={t("ai.lifecycle.closeTitle")} onCancel={(event) => { event.preventDefault(); if (!busy) setRequests((items) => items.slice(1)); }}>
    <h2 className="dialog-title">{t("ai.lifecycle.closeTitle")}</h2>
    <p className="dialog-body">{t("ai.lifecycle.closeHint")}</p>
    <div className="dialog-actions">
      <button className="button" disabled={busy} onClick={() => setRequests((items) => items.slice(1))}>{t("dialog.cancel")}</button>
      <button className="button" disabled={busy} onClick={() => void choose(false)}>{t("ai.lifecycle.background")}</button>
      <button className="button is-danger" disabled={busy} onClick={() => void choose(true)}>{t("ai.lifecycle.stopClose")}</button>
    </div>
  </dialog> };
}
