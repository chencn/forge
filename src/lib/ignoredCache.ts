/**
 * 忽略清单的共享缓存。
 *
 * `git status --ignored` 是全仓扫描，Windows 上仓库大了要走几百毫秒；此前目录树、
 * Git 面板、随处搜索各拉各的，保存风暴时同一趟扫描会被反复起进程。这里按仓库根
 * 合并成一份：防抖共享、在飞共享、新鲜期内直接回缓存不起进程。
 *
 * 时效折中：条目 `FRESH_MS` 内不再重扫，新被忽略的文件最晚下一次过期后的加载
 * 才会出现；`.gitignore` / exclude 变动走显式 invalidate，立刻重扫并广播。
 */
import { gitIgnored } from "./git";

/** 起进程前的合并窗口：风暴期间多次请求只落一趟扫描。 */
const REFRESH_DEBOUNCE_MS = 800;

/** 结果视为新鲜的时长。过期不主动重扫——下次有人要时才走一趟。 */
const FRESH_MS = 10_000;

interface Slot {
  list: string[] | null;
  fetchedAt: number;
  inFlight: Promise<string[]> | null;
  timer: number | null;
  /** 扫描在飞期间被作废过：这趟读的是改动前的规则，落定后得立刻补扫，不能当新鲜结果存。 */
  dirty: boolean;
}

const slots = new Map<string, Slot>();
const listeners = new Map<string, Set<(list: string[]) => void>>();

/** 同一仓库的各种写法归一个键（与 git_probe 缓存同因：D:\\ 与 d:/ 是同一个目录）。 */
function slotKey(repoRoot: string): string {
  return repoRoot.replaceAll("\\", "/").toLocaleLowerCase();
}

function getSlot(key: string): Slot {
  let slot = slots.get(key);
  if (!slot) {
    slot = { list: null, fetchedAt: 0, inFlight: null, timer: null, dirty: false };
    slots.set(key, slot);
  }
  return slot;
}

function notify(key: string, list: string[]): void {
  for (const listener of listeners.get(key) ?? []) listener(list);
}

/**
 * 取忽略清单：新鲜缓存立回；否则进入（或搭上已有的）防抖扫描。
 * 失败当空清单回（纯浏览器预览没有这条命令），但空手不记进缓存。
 */
export function loadIgnored(repoRoot: string): Promise<string[]> {
  const key = slotKey(repoRoot);
  const slot = getSlot(key);
  if (slot.list !== null && Date.now() - slot.fetchedAt < FRESH_MS) {
    return Promise.resolve(slot.list);
  }
  if (slot.inFlight) return slot.inFlight;
  slot.inFlight = new Promise<string[]>((resolve) => {
    slot.timer = window.setTimeout(() => {
      slot.timer = null;
      gitIgnored(repoRoot)
        .then((list) => {
          // 这趟是在飞期间被作废过的：读回来的是改动之前的规则，不能当新鲜结果存进缓存。
          if (!slot.dirty) {
            slot.list = list;
            slot.fetchedAt = Date.now();
          }
          notify(key, list);
          resolve(list);
        })
        .catch(() => {
          resolve(slot.list ?? []);
        })
        .finally(() => {
          slot.inFlight = null;
          if (slot.dirty) {
            slot.dirty = false;
            void loadIgnored(repoRoot);
          }
        });
    }, REFRESH_DEBOUNCE_MS);
  });
  return slot.inFlight;
}

/** 订阅后续扫描的结果（含本次已在飞的）。返回取消函数。 */
export function subscribeIgnored(
  repoRoot: string,
  listener: (list: string[]) => void
): () => void {
  const key = slotKey(repoRoot);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/** 忽略规则文件变了：作废条目并重扫，结果广播给所有订阅者。 */
export function invalidateIgnored(repoRoot: string): void {
  const key = slotKey(repoRoot);
  const slot = getSlot(key);
  slot.list = null;
  slot.fetchedAt = 0;
  if (slot.inFlight) {
    // 那一趟进程是改动之前起的，读回来必然是旧规则：标脏，它落定后马上补扫一趟，
    // 别让改前的名单顶着「新鲜」的标签留满 FRESH_MS。
    slot.dirty = true;
    return;
  }
  // 还排在防抖窗口里、没起进程的那趟不用管：它起的时候读到的已经是新规则了。
  if (slot.timer !== null) return;
  void loadIgnored(repoRoot);
}

/** 关掉的工作区根可能包住一个子仓库键：把落在它里面的条目一并回收（关掉的根自己也在这儿）。 */
export function forgetIgnoredUnder(dir: string): void {
  const prefix = slotKey(dir).replace(/\/+$/, "");
  for (const key of Array.from(slots.keys())) {
    if (key === prefix || key.startsWith(`${prefix}/`)) drop(key);
  }
}

function drop(key: string): void {
  const slot = slots.get(key);
  if (slot?.timer !== null && slot?.timer !== undefined) {
    window.clearTimeout(slot.timer);
  }
  slots.delete(key);
  listeners.delete(key);
}
