import { useEffect, useSyncExternalStore } from "react";
import { mavenScan } from "../lib/maven";
import type { MavenProject } from "../lib/maven";

/** Maven 工程探测的当前阶段：未开始 / 扫描中 / 就绪 / 非 Maven 工程 / 扫描失败。 */
export type MavenStatus = "idle" | "loading" | "ready" | "absent" | "failed";

/** Maven 探测的外部 store 状态。 */
interface MavenStore {
  root: string | null;
  status: MavenStatus;
  project: MavenProject | null;
  error: string | null;
  open: boolean;
}

/** 空状态：未选工作区时的初始/复位值。 */
const EMPTY: MavenStore = {
  root: null,
  status: "idle",
  project: null,
  error: null,
  open: false,
};

/** 当前 store（模块级单例）。 */
let store: MavenStore = EMPTY;
/** useSyncExternalStore 订阅者集合。 */
const listeners = new Set<() => void>();
/** 扫描票号：换工作区或重扫时递增，旧扫描的迟到结果按票丢弃。 */
let seq = 0;
/** 首屏让位用的 setTimeout 句柄。 */
let timer = 0;
/** 空闲回调句柄（浏览器不支持 requestIdleCallback 时为 0）。 */
let idleId = 0;

/** 视为「工程真的扫坏了」的错误码集合；命令不在等环境问题归为 absent。 */
const SCAN_ERRORS = new Set(["MAVEN_READ", "MAVEN_POM", "MAVEN_TOO_LARGE", "MAVEN_CYCLE"]);

/** 提交新状态并通知订阅者。 */
function emit(next: MavenStore) {
  store = next;
  for (const listener of listeners) listener();
}

/** 取消还没触发的延迟扫描（timer 与 idle 回调一起清）。 */
function cancelPending() {
  window.clearTimeout(timer);
  timer = 0;
  if (idleId !== 0 && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(idleId);
  }
  idleId = 0;
}

/** useSyncExternalStore 的订阅入口。 */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore 的快照。 */
function snapshot() {
  return store;
}

/** 执行一次 Maven 项目扫描；ticket 过期时丢弃结果。 */
async function runScan(root: string, ticket: number) {
  try {
    const project = await mavenScan(root);
    if (ticket !== seq) return;
    if (!project) {
      emit({ root, status: "absent", project: null, error: null, open: false });
      return;
    }
    emit({ root, status: "ready", project, error: null, open: store.open });
  } catch (error: unknown) {
    if (ticket !== seq) return;
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
    // 命令本身不在（浏览器预览、还没编过后端）不当成「这是个坏掉的 Maven 工程」。
    if (!SCAN_ERRORS.has(message)) {
      emit({ root, status: "absent", project: null, error: null, open: false });
      return;
    }
    emit({
      root,
      status: "failed",
      project: store.project,
      error: message,
      open: store.open,
    });
  }
}

/**
 * 工程已经进了窗口之后再扫。
 * 先让出首屏，再等一次空闲，避免和打开文件夹抢同一轮读盘。
 */
export function watchMaven(root: string | null): () => void {
  cancelPending();
  const ticket = ++seq;
  if (!root) {
    emit(EMPTY);
    return cancelPending;
  }
  const same = store.root === root;
  emit({
    root,
    status: same && store.project ? "loading" : "idle",
    project: same ? store.project : null,
    error: null,
    open: same ? store.open : false,
  });
  const kick = () => {
    if (ticket !== seq) return;
    void runScan(root, ticket);
  };
  timer = window.setTimeout(() => {
    timer = 0;
    if (ticket !== seq) return;
    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(
        () => {
          idleId = 0;
          kick();
        },
        { timeout: 2000 },
      );
    } else {
      kick();
    }
  }, 400);
  return cancelPending;
}

/** 重新扫一遍当前工作区（pom 或依赖变了时手动/自动触发）。 */
export function reloadMaven() {
  const root = store.root;
  if (!root) return;
  cancelPending();
  const ticket = ++seq;
  emit({ ...store, status: "loading", error: null });
  void runScan(root, ticket);
}

/** 展开/收起 Maven 面板；探测没出结果时开关无效。 */
export function toggleMavenOpen() {
  if (!store.project && store.status !== "failed") return;
  emit({ ...store, open: !store.open });
}

/** 收起 Maven 面板（不丢扫描结果）。 */
export function closeMaven() {
  if (!store.open) return;
  emit({ ...store, open: false });
}

/** 订阅 Maven 探测状态的 React 入口。 */
export function useMavenProject() {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * 把 Maven 扫描绑定到工作区生命周期。入口位置可以调整，但扫描所有权必须留在
 * 常驻的 App 层；否则依赖检测结果才会挂载的 Maven 面板永远没有机会启动检测。
 */
export function useMavenDetection(workspace: string | null) {
  useEffect(() => watchMaven(workspace), [workspace]);
}

/** 探测还没结束、或者这个文件夹不是 Maven 工程时，右侧活动栏不显示 Maven 入口。 */
export function mavenIconVisible(current: MavenStore, workspace: string | null): boolean {
  if (!workspace || current.root !== workspace) return false;
  if (current.project) return true;
  return current.status === "failed";
}
