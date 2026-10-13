import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  crcSignature,
  depSyncProbe,
  detectInstalledEcosystem,
  isBuildWatchFile,
  sameFilesCrc,
} from "../lib/depSync";
import type { DepSyncItem, DepSyncPrompt, InstalledEcosystem } from "../lib/depSync";
import type { ProcSessionId } from "../lib/proc";
import type { RunController } from "./useRunSessions";

/** 首屏渲染后延迟多久才在后台静默建立 CRC32 基线，确保首屏绝对零卡顿。 */
const INITIAL_PROBE_DELAY_MS = 800;
/** 构建文件保存或分支切换时的防抖时间（参照 IDEA `autoimport` 合并窗口）。 */
const CHANGE_DEBOUNCE_MS = 600;
/** 外部终端包安装写入安装目录标记后的收尾宽限窗口（防止尾随落盘的 lockfile 被误判为未同步修改）。 */
const ARTIFACT_GRACE_MS = 3500;
/** 用户点击「不再询问」时的永久静默标记（当前工作区会话内不再对该构建单元弹窗，切分支往返亦保持）。 */
const PERMANENT_MUTE_SIG = "*";

/** 归一化工作区根键（斜杠与大小写不敏感）。 */
function normalizeRootKey(root: string | null | undefined): string {
  return root ? root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() : "";
}

/**
 * 构建依赖自动检测与变更同步状态机（IDEA `externalSystem.autoimport` 风格）。
 *
 * 核心流转：
 * 1. 首屏延迟 800ms 静默采样 `filesCrc` 存入内存 `baselineRef`；仅当本地依赖目录缺失（如无 `node_modules`）
 *    且本机具备对应构建工具时，才提示 `"missing"`。
 * 2. 当 `noteDiskChange` 命中受控构建文件白名单时，防抖 600ms 后重采 `depSyncProbe`：
 *    - 若 `filesCrc` 偏离基线（或通过 `git checkout` / `git pull` 新拉取了新模块），加入待同步提示列表（`reason: "modified"`）；
 *    - 若用户通过 `Ctrl+Z` 撤销或 `git checkout` 将文件还原回基线，且 `!missingInstalled`，
 *      提示自动从界面消隐（Auto-Expire）。
 * 3. 点击「运行 '...'」后复用 `run.start(item.installConfig, item.root)` 在底部运行面板执行：
 *    执行期间自抑制该项变动，待会话以 `status === "done"`（`exit === 0`）结束后，
 *    自动重采最新 `filesCrc` 晋升为新基线。
 */
export function useDepSync(
  workspaceRoot: string | null,
  watchedRoots: string[],
  run: RunController,
  onFocusRunPane: () => void
) {
  /** 每个工作区根下各构建单元已知同步时的语义 CRC32 基线：rootKey -> (itemId -> filesCrc)。 */
  const baselineRef = useRef(new Map<string, Map<string, Record<string, number>>>());
  /** 用户点击关闭（记 `signature`）或「不再询问」（记 `"*"`）：rootKey -> (itemId -> signature | "*")。 */
  const dismissedRef = useRef(new Map<string, Map<string, string>>());
  /** 已经完成过首次基线采样的工作区根集合。 */
  const initializedRootsRef = useRef(new Set<string>());
  /** 各工作区根的首屏 800ms 基线定时器（按根隔离，避免切换/新增项目或运行状态变化打断其它根的采样）。 */
  const initTimersRef = useRef(new Map<string, number>());
  /** 正在执行同步命令的会话状态追踪：sessionId -> { root, itemId }。 */
  const trackedSessionsRef = useRef(new Map<ProcSessionId, { root: string; itemId: string }>());
  /** 各工作区根的防抖定时器。 */
  const debounceTimersRef = useRef(new Map<string, number>());
  /** 各工作区根在防抖窗口内观测到的本地依赖安装生态集合：rootKey -> Set<InstalledEcosystem>。 */
  const pendingArtifactByRootRef = useRef(new Map<string, Set<InstalledEcosystem>>());
  /** 各工作区根各生态最近一次观测到本地依赖安装标记的时间戳：rootKey -> Map<InstalledEcosystem, timestamp>。 */
  const lastArtifactAtByRootRef = useRef(new Map<string, Map<InstalledEcosystem, number>>());
  /** 各工作区根的单调递增请求序号，防止并发 `depSyncProbe` 乱序返回覆盖新状态。 */
  const probeSeqRef = useRef(new Map<string, number>());
  /** 挂起的全量基线晋升意图（确保并发请求被取代时基线晋升信号不丢失）。 */
  const pendingBaselineRootsRef = useRef(new Set<string>());
  /** 挂起的按生态基线晋升意图：rootKey -> Set<InstalledEcosystem>。 */
  const pendingArtifactPromoteRef = useRef(new Map<string, Set<InstalledEcosystem>>());
  /** 挂起的单项基线晋升意图：rootKey -> Set<itemId>。 */
  const pendingSyncedItemsRef = useRef(new Map<string, Set<string>>());

  const workspaceRootRef = useRef(workspaceRoot);
  workspaceRootRef.current = workspaceRoot;
  const runSessionsRef = useRef(run.allSessions);
  runSessionsRef.current = run.allSessions;
  const runStartRef = useRef(run.start);
  runStartRef.current = run.start;
  const focusRunPaneRef = useRef(onFocusRunPane);
  focusRunPaneRef.current = onFocusRunPane;

  /** 按工作区根键存放的待同步提示列表。 */
  const [promptsByRoot, setPromptsByRoot] = useState<Record<string, DepSyncPrompt[]>>({});

  /** 判断某个工作区下的某个构建单元当前是否有正在运行的同步会话（通过 ref 读取以保持恒定引用）。 */
  const isItemSyncing = useCallback((rootKey: string, itemId: string): boolean => {
    const configId = `dep-sync::${itemId}`;
    return runSessionsRef.current.some(
      (s) =>
        normalizeRootKey(s.root) === rootKey &&
        s.config.id === configId &&
        s.status === "running"
    );
  }, []);

  /**
   * 对指定工作区执行一次探测并对齐内存基线与提示列表。
   * - `mode === "baseline"`：首次打开工作区，以当前磁盘 CRC32 作为基线。
   * - `mode === "check"`：磁盘构建文件变动、外部安装完成或同步命令结束，按生态/单项晋升或与已有基线比对。
   */
  const evaluateRoot = useCallback(
    async (
      root: string,
      mode: "baseline" | "check",
      syncedItemId?: string,
      artifactEcosystems?: Iterable<InstalledEcosystem>
    ) => {
      const key = normalizeRootKey(root);
      if (!key) return;

      // 先登记基线晋升意图，即便当前请求被后续并发请求取代，意图也会由最新一轮请求消费
      if (mode === "baseline") {
        pendingBaselineRootsRef.current.add(key);
      }
      if (syncedItemId) {
        let set = pendingSyncedItemsRef.current.get(key);
        if (!set) {
          set = new Set();
          pendingSyncedItemsRef.current.set(key, set);
        }
        set.add(syncedItemId);
      }
      if (artifactEcosystems) {
        let ecoSet = pendingArtifactPromoteRef.current.get(key);
        if (!ecoSet) {
          ecoSet = new Set();
          pendingArtifactPromoteRef.current.set(key, ecoSet);
        }
        for (const eco of artifactEcosystems) ecoSet.add(eco);
      }

      const seq = (probeSeqRef.current.get(key) ?? 0) + 1;
      probeSeqRef.current.set(key, seq);

      let items: DepSyncItem[];
      try {
        items = await depSyncProbe(root);
      } catch {
        return;
      }

      // 若在等待后端返回期间又有更新的探测发起，丢弃本次过期结果
      if (probeSeqRef.current.get(key) !== seq) {
        return;
      }

      const promoteAll = pendingBaselineRootsRef.current.delete(key);
      const syncedSet = pendingSyncedItemsRef.current.get(key);
      pendingSyncedItemsRef.current.delete(key);
      const artifactEcoSet = pendingArtifactPromoteRef.current.get(key);
      pendingArtifactPromoteRef.current.delete(key);
      const recentArtifacts = lastArtifactAtByRootRef.current.get(key);
      const now = Date.now();

      let baseMap = baselineRef.current.get(key);
      if (!baseMap) {
        baseMap = new Map();
        baselineRef.current.set(key, baseMap);
      }
      let dismissMap = dismissedRef.current.get(key);
      if (!dismissMap) {
        dismissMap = new Map();
        dismissedRef.current.set(key, dismissMap);
      }

      const nextPrompts: DepSyncPrompt[] = [];
      for (const item of items) {
        const sig = crcSignature(item.filesCrc);
        const existingBase = baseMap.get(item.id);
        const itemEco =
          item.kind === "npm" || item.kind === "python" || item.kind === "php" || item.kind === "dart"
            ? item.kind
            : null;
        const withinArtifactGrace =
          itemEco !== null &&
          recentArtifacts !== undefined &&
          now - (recentArtifacts.get(itemEco) ?? 0) <= ARTIFACT_GRACE_MS;
        const matchedArtifactPromote =
          itemEco !== null && (artifactEcoSet?.has(itemEco) === true || withinArtifactGrace);

        // 首次建基线、该生态刚在外部完成本地依赖安装、或指定的同步项刚刚成功跑完：将其最新 CRC32 晋升为基线。
        // 若是在运行期（!promoteAll）通过 git checkout / git pull 新拉取或用户新建的模块（!existingBase），
        // 基线记为空对象 {}，从而能正常识别为新增构建单元并提示同步。
        if (promoteAll || syncedSet?.has(item.id) || matchedArtifactPromote) {
          baseMap.set(item.id, item.filesCrc);
        } else if (!existingBase) {
          baseMap.set(item.id, {});
        }

        // 本机缺少对应构建工具时不弹无意义的同步提示
        if (item.installConfig.unavailable) {
          continue;
        }

        // 正在同步中的单元自抑制，不因同步过程中的中间文件写入再次弹窗
        if (isItemSyncing(key, item.id)) {
          continue;
        }

        const currentBase = baseMap.get(item.id) ?? item.filesCrc;
        const crcChanged = !sameFilesCrc(currentBase, item.filesCrc);
        const dismissedState = dismissMap.get(item.id);

        // 用户已点击「不再询问」的构建单元，在当前工作区会话内保持静默
        if (dismissedState === PERMANENT_MUTE_SIG) {
          continue;
        }

        if (item.missingInstalled) {
          const dismissSig = `missing|${sig}`;
          if (dismissedState !== dismissSig) {
            nextPrompts.push({ ...item, root, reason: "missing", signature: dismissSig });
          }
        } else if (crcChanged) {
          const dismissSig = `modified|${sig}`;
          if (dismissedState !== dismissSig) {
            nextPrompts.push({ ...item, root, reason: "modified", signature: dismissSig });
          }
        } else {
          // Auto-Expire：当文件被 Ctrl+Z 或 git checkout 还原回基线且本地依赖目录已就绪时，清除单次关闭记录并不再提示
          dismissMap.delete(item.id);
        }
      }

      setPromptsByRoot((prev) => {
        const current = prev[key] ?? [];
        if (
          current.length === nextPrompts.length &&
          current.every(
            (p, idx) =>
              p.id === nextPrompts[idx].id &&
              p.reason === nextPrompts[idx].reason &&
              p.signature === nextPrompts[idx].signature
          )
        ) {
          return prev;
        }
        return { ...prev, [key]: nextPrompts };
      });
    },
    [isItemSyncing]
  );

  // 为所有打开的工作区在首屏渲染 800ms 后静默建立语义 CRC32 基线；关闭的工作区清理内存与残留气泡。
  useEffect(() => {
    const activeKeys = new Set(watchedRoots.map(normalizeRootKey).filter(Boolean));

    // 清理已关闭工作区的未触发首屏定时器
    for (const [timerKey, timerId] of [...initTimersRef.current.entries()]) {
      if (!activeKeys.has(timerKey)) {
        window.clearTimeout(timerId);
        initTimersRef.current.delete(timerKey);
      }
    }

    const removedKeys: string[] = [];
    for (const oldKey of [...initializedRootsRef.current]) {
      if (!activeKeys.has(oldKey)) {
        removedKeys.push(oldKey);
        initializedRootsRef.current.delete(oldKey);
        baselineRef.current.delete(oldKey);
        dismissedRef.current.delete(oldKey);
        probeSeqRef.current.delete(oldKey);
        pendingBaselineRootsRef.current.delete(oldKey);
        pendingArtifactPromoteRef.current.delete(oldKey);
        pendingSyncedItemsRef.current.delete(oldKey);
        pendingArtifactByRootRef.current.delete(oldKey);
        lastArtifactAtByRootRef.current.delete(oldKey);
        const timer = debounceTimersRef.current.get(oldKey);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          debounceTimersRef.current.delete(oldKey);
        }
      }
    }

    if (removedKeys.length > 0) {
      setPromptsByRoot((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of removedKeys) {
          if (k in next) {
            delete next[k];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    for (const root of watchedRoots) {
      const k = normalizeRootKey(root);
      if (!k || initializedRootsRef.current.has(k) || initTimersRef.current.has(k)) {
        continue;
      }
      const timerId = window.setTimeout(() => {
        initTimersRef.current.delete(k);
        if (!initializedRootsRef.current.has(k)) {
          initializedRootsRef.current.add(k);
          void evaluateRoot(root, "baseline");
        }
      }, INITIAL_PROBE_DELAY_MS);
      initTimersRef.current.set(k, timerId);
    }
  }, [evaluateRoot, watchedRoots]);

  // 监听同步运行会话的生命周期：当 dep-sync 会话以 exit === 0 完成时，自动晋升该单元 CRC32 基线。
  useEffect(() => {
    for (const session of run.allSessions) {
      if (!session.config.id.startsWith("dep-sync::")) continue;
      const itemId = session.config.id.slice("dep-sync::".length);
      if (session.status === "running") {
        trackedSessionsRef.current.set(session.id, { root: session.root, itemId });
      } else {
        const tracked = trackedSessionsRef.current.get(session.id);
        if (tracked) {
          trackedSessionsRef.current.delete(session.id);
          if (session.status === "done" && session.exit === 0) {
            void evaluateRoot(tracked.root, "check", tracked.itemId);
          } else {
            void evaluateRoot(tracked.root, "check");
          }
        }
      }
    }
  }, [evaluateRoot, run.allSessions]);

  // 组件卸载时清理所有定时器
  useEffect(() => {
    const debounceTimers = debounceTimersRef.current;
    const initTimers = initTimersRef.current;
    return () => {
      for (const timer of debounceTimers.values()) window.clearTimeout(timer);
      debounceTimers.clear();
      for (const timer of initTimers.values()) window.clearTimeout(timer);
      initTimers.clear();
    };
  }, []);

  /**
   * 磁盘文件变更入口：先用 `isBuildWatchFile` 在内存做 $O(1)$ 过滤，
   * 只有命中受控构建清单或依赖目录标记时才启动 600ms 防抖探测。
   */
  const noteDiskChange = useCallback(
    (changedRoot: string, paths: string[]) => {
      if (!changedRoot || paths.length === 0) return;
      const hit = paths.some((p) => isBuildWatchFile(p, changedRoot));
      if (!hit) return;

      const key = normalizeRootKey(changedRoot);
      if (!key) return;

      // 若本批变更包含某个语言生态的本地依赖安装标记（如 pnpm add 更新了 node_modules/.modules.yaml），按生态记录并刷新宽限窗口
      const now = Date.now();
      for (const p of paths) {
        const eco = detectInstalledEcosystem(p, changedRoot);
        if (eco) {
          let pendingEco = pendingArtifactByRootRef.current.get(key);
          if (!pendingEco) {
            pendingEco = new Set();
            pendingArtifactByRootRef.current.set(key, pendingEco);
          }
          pendingEco.add(eco);

          let lastMap = lastArtifactAtByRootRef.current.get(key);
          if (!lastMap) {
            lastMap = new Map();
            lastArtifactAtByRootRef.current.set(key, lastMap);
          }
          lastMap.set(eco, now);
        }
      }

      const prevTimer = debounceTimersRef.current.get(key);
      if (prevTimer !== undefined) window.clearTimeout(prevTimer);

      debounceTimersRef.current.set(
        key,
        window.setTimeout(() => {
          debounceTimersRef.current.delete(key);
          const pendingEcos = pendingArtifactByRootRef.current.get(key);
          pendingArtifactByRootRef.current.delete(key);

          const initialized = initializedRootsRef.current.has(key);
          if (!initialized) {
            const initTimer = initTimersRef.current.get(key);
            if (initTimer !== undefined) {
              window.clearTimeout(initTimer);
              initTimersRef.current.delete(key);
            }
            initializedRootsRef.current.add(key);
            void evaluateRoot(changedRoot, "baseline");
          } else {
            void evaluateRoot(changedRoot, "check", undefined, pendingEcos);
          }
        }, CHANGE_DEBOUNCE_MS)
      );
    },
    [evaluateRoot]
  );

  /** 用户点击「运行 '...'」：隐藏当前提示卡片，唤起底部运行面板并启动安装配置。 */
  const syncItem = useCallback((item: DepSyncPrompt) => {
    const targetRoot = item.root || workspaceRootRef.current;
    if (!targetRoot) return;
    const key = normalizeRootKey(targetRoot);
    setPromptsByRoot((prev) => ({
      ...prev,
      [key]: (prev[key] ?? []).filter((p) => p.id !== item.id),
    }));
    runStartRef.current(item.installConfig, targetRoot);
    focusRunPaneRef.current();
  }, []);

  /**
   * 用户点击关闭按钮（`permanent = false`）或「不再询问」（`permanent = true`）：
   * - 关闭按钮：仅记下当前 CRC 签名，若撤销回原状或再次实质修改仍可提示；
   * - 不再询问：记下 `"*"` 永久静默标记，在当前工作区会话内不再对该构建单元弹窗（切分支往返亦不复弹）。
   */
  const dismissItem = useCallback((itemId: string, permanent: boolean = false) => {
    const targetRoot = workspaceRootRef.current;
    if (!targetRoot) return;
    const key = normalizeRootKey(targetRoot);
    setPromptsByRoot((prev) => {
      const list = prev[key] ?? [];
      const target = list.find((p) => p.id === itemId);
      if (target) {
        let dismissMap = dismissedRef.current.get(key);
        if (!dismissMap) {
          dismissMap = new Map();
          dismissedRef.current.set(key, dismissMap);
        }
        dismissMap.set(itemId, permanent ? PERMANENT_MUTE_SIG : target.signature);
      }
      return {
        ...prev,
        [key]: list.filter((p) => p.id !== itemId),
      };
    });
  }, []);

  const activeKey = normalizeRootKey(workspaceRoot);
  const items = useMemo(
    () => (activeKey ? (promptsByRoot[activeKey] ?? []) : []),
    [activeKey, promptsByRoot]
  );

  return useMemo(
    () => ({
      items,
      noteDiskChange,
      syncItem,
      dismissItem,
    }),
    [dismissItem, items, noteDiskChange, syncItem]
  );
}
