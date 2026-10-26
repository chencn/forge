import { useEffect, useSyncExternalStore } from "react";
import { mavenScan } from "../lib/maven";
import type { MavenProject } from "../lib/maven";

export type MavenStatus = "idle" | "loading" | "ready" | "absent" | "failed";

interface MavenStore {
  root: string | null;
  status: MavenStatus;
  project: MavenProject | null;
  error: string | null;
  open: boolean;
}

const EMPTY: MavenStore = {
  root: null,
  status: "idle",
  project: null,
  error: null,
  open: false,
};

let store: MavenStore = EMPTY;
const listeners = new Set<() => void>();
let seq = 0;
let timer = 0;
let idleId = 0;

const SCAN_ERRORS = new Set(["MAVEN_READ", "MAVEN_POM", "MAVEN_TOO_LARGE", "MAVEN_CYCLE"]);

function emit(next: MavenStore) {
  store = next;
  for (const listener of listeners) listener();
}

function cancelPending() {
  window.clearTimeout(timer);
  timer = 0;
  if (idleId !== 0 && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(idleId);
  }
  idleId = 0;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return store;
}

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

export function reloadMaven() {
  const root = store.root;
  if (!root) return;
  cancelPending();
  const ticket = ++seq;
  emit({ ...store, status: "loading", error: null });
  void runScan(root, ticket);
}

export function toggleMavenOpen() {
  if (!store.project && store.status !== "failed") return;
  emit({ ...store, open: !store.open });
}

export function closeMaven() {
  if (!store.open) return;
  emit({ ...store, open: false });
}

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
