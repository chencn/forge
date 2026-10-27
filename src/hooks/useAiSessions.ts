import { useCallback, useEffect, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { aiSessionStorageKey, parseAiSessions, reduceAiSessions } from "../lib/aiSessions";
import type { AiSessionAction, AiSessionState } from "../lib/aiSessions";
import { clearAiSessionStorage } from "../lib/aiDrafts";
import { ensureAiRuntimeListener, refreshAiSessionActivity } from "../lib/aiRuntime";

/** 一个工作区缓存下来的会话状态。 */
interface Snapshot {
  /** 会话列表与已打开标签。 */
  state: AiSessionState;
  /** localStorage 是否读写失败；失败只影响持久化，界面照常可用。 */
  storageError: boolean;
}
/** 按存储键缓存，切回同一项目时不必重新解析。 */
const stores = new Map<string, Snapshot>();
/** 已打开过的工程继续更新任务状态，切换前台不能冻结后台工程的运行灯。 */
const activityWorkspaces = new Map<string, string>();
const listeners = new Set<() => void>();
/** 已删除的会话 id（带存储键前缀）。后端历史里仍有记录，靠它挡住重新导入。 */
const deleted = new Set<string>();
/** 各挂载实例注册的刷新函数，供工具栏「检测」按钮一次性触发全部。 */
const refreshers = new Set<() => Promise<void>>();
/** 通知所有挂载中的会话面板去后端拉一次历史。 */
export async function refreshAiSessionHistory() {
  await Promise.allSettled([...refreshers].map((refresh) => refresh()));
}
/** 工程从工作区列表真正关闭后停止轮询；普通切换不能调用，否则后台运行态会被冻结。 */
export function forgetAiSessionWorkspace(root: string) {
  activityWorkspaces.delete(aiSessionStorageKey(root));
}
/** 读缓存；首次访问才解析 localStorage，解析异常降级为空状态并标记存储错误。 */
function get(key: string): Snapshot {
  let value = stores.get(key);
  if (!value) {
    try {
      value = { state: parseAiSessions(localStorage.getItem(key)), storageError: false };
    } catch {
      value = { state: parseAiSessions(null), storageError: true };
    }
    stores.set(key, value);
  }
  return value;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 功能关闭时的固定快照。用常量保证引用稳定，避免无谓重渲染。 */
const DISABLED_SNAPSHOT: Snapshot = { state: parseAiSessions(null), storageError: false };

/**
 * 某个工作区下的会话列表。
 *
 * 数据有两个来源：本地存储（用户建过、改过名的会话）和后端持久化记录。
 * 启动时先读本地，再把后端里有、本地没有的补进来——这样换机器或清过缓存后仍能看到历史，
 * 而用户主动删掉的记录靠 `deleted` 集合挡住，不会被重新导入。
 * `enabled` 为假时返回空快照且不注册任何副作用，功能关闭后不该再访问后端。
 */
export function useAiSessions(root: string | null, enabled = true) {
  const key = aiSessionStorageKey(root);
  const snapshot = useSyncExternalStore(subscribe, () => enabled ? get(key) : DISABLED_SNAPSHOT);
  useEffect(() => {
    if (!enabled || !root || !isTauri()) return;
    activityWorkspaces.set(key, root);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 不扫描聊天正文；每轮完成后再计时，慢机器也不会积压查询。
    const poll = async () => {
      await Promise.allSettled([...activityWorkspaces].map(([workspaceKey, workspace]) =>
        refreshAiSessionActivity(workspace, get(workspaceKey).state.sessions.map((session) => session.id))));
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void ensureAiRuntimeListener().catch(() => {});
    void poll();
    return () => {
      cancelled = true; clearTimeout(timer);
      // 切换前台工程不等于关闭该工程：保留登记，让新工程的轮询继续覆盖所有已打开过的项目。
      // 后端队列另有进程级监控，因此 WebView 刷新期间也不会冻结 waitingExternal。
    };
  }, [key, root, enabled]);
  useEffect(() => {
    if (!enabled || !root || !isTauri()) return;
    let cancelled = false;
    let pending: Promise<void> | null = null;
    let refreshAgain = false;
    // 单飞：窗口重新聚焦可能连着触发几次，上一轮没回来就不再发新的。
    const refresh = (): Promise<void> => {
      if (cancelled) return Promise.resolve();
      // 在途列表可能读到旧标题；把重复通知并入同一 Promise，调用方 await 后看到的是最后一轮结果。
      if (pending) { refreshAgain = true; return pending; }
      pending = (async () => {
        do {
          refreshAgain = false;
          try {
            const records = await invoke<unknown[]>("ai_runtime_list", { workspace: root });
            if (cancelled) return;
            const persisted = parseAiSessions(JSON.stringify({ sessions: records, openIds: [] })).sessions;
            const current = get(key);
            // CLI 原生列表是 ID 与标题的权威来源；localStorage 只保留打开标签。
            const sessions = persisted.filter((session) => !deleted.has(`${key}:${session.id}`)).sort((a, b) => b.createdAt - a.createdAt);
            const ids = new Set(sessions.map((session) => session.id));
            const openIds = current.state.openIds.filter((id) => ids.has(id));
            // CLI 列表是身份权威；活动标签若已不存在，回退到最后一个仍打开的标签。
            const activeId = current.state.activeId && ids.has(current.state.activeId) && openIds.includes(current.state.activeId)
              ? current.state.activeId : openIds.at(-1) ?? null;
            const state = { sessions, openIds, activeId };
            if (JSON.stringify(state) !== JSON.stringify(current.state)) {
              let storageError = false;
              try { localStorage.setItem(key, JSON.stringify(state)); } catch { storageError = true; }
              stores.set(key, { state, storageError });
              listeners.forEach((listener) => listener());
            }
          } catch {
            if (cancelled) return;
            stores.set(key, { ...get(key), storageError: true });
            listeners.forEach((listener) => listener());
          }
        } while (refreshAgain && !cancelled);
      })().finally(() => { pending = null; });
      return pending;
    };
    void refresh(); refreshers.add(refresh);
    window.addEventListener("focus", refresh);
    // 首次发送改变持久化标题，不能等窗口重新聚焦才刷新标签。
    window.addEventListener("ai-session-metadata", refresh);
    return () => { cancelled = true; refreshers.delete(refresh); window.removeEventListener("focus", refresh); window.removeEventListener("ai-session-metadata", refresh); };
  }, [key, root, enabled]);
  /** 写回 localStorage 并通知订阅者。写失败只降级成「本次不持久化」，不阻断界面。 */
  const dispatch = useCallback((action: AiSessionAction): boolean => {
    if (!enabled) return false;
    // 删会话带走全部会话级缓存；发送历史和引擎默认项按工程/引擎共享，继续保留。
    if (action.type === "delete") {
      // 子代理的记录与草稿跟着父一起清：后端已经把它们的目录删了，本地留着就是没人认的死键。
      const doomed = [action.id, ...get(key).state.sessions.filter((item) => item.parentSessionId === action.id).map((item) => item.id)];
      for (const id of doomed) {
        deleted.add(`${key}:${id}`);
        clearAiSessionStorage(root, id);
      }
    }
    const current = get(key);
    const state = reduceAiSessions(current.state, action);
    // open 的返回值是导航边界：未知会话不能让 App 切到一个没有内容的标签。
    if (state === current.state) return action.type === "open" && current.state.sessions.some((session) => session.id === action.id);
    let storageError = false;
    try { localStorage.setItem(key, JSON.stringify(state)); }
    catch { storageError = true; }
    stores.set(key, { state, storageError });
    listeners.forEach((listener) => listener());
    return true;
  }, [key, root, enabled]);
  return { ...snapshot.state, storageError: snapshot.storageError, dispatch };
}
