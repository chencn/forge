import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { decodeChunk, termClose, termLayoutLoad, termLayoutSave, termOpen, termWrite } from "./term";
import type { TermChunk, TermExit, TermLaunch, TermSessionId } from "./term";
import { samePath } from "./format";
import { stripEraseScrollback } from "./termHistory";

/**
 * 一条终端会话：后端 PTY 的 id。
 *
 * 会话故意放在模块级而不是组件里——面板最小化、在底部和选项卡之间来回切，
 * 都不该把 shell 一起带走。画面留在各自的 xterm 里，同时按会话留一份原始输出：
 * xterm 被拆掉或滚屏被擦掉之后，新实例还能把已经滚出视线的日志写回去。
 * 多条会话并存，页签按 `termSessionsFor` 排好的顺序画，`activeId` 是当前看着的那条。
 * 多工作区常驻时，每个工作区根各自维护一组会话与自己的激活会话 id，切根时不杀后台终端。
 *
 * 分屏：同一 `group` 的会话一起画在面板里，页签上挨着；激活哪一条就显示它所在的那一组。
 */
export interface TermSession {
  id: TermSessionId;
  /** 所属工作区根，换工作区时据此判断这条会话归属哪个根。 */
  cwd: string | null;
  /** 这条会话用的 shell（`ShellInfo.id`，多数就是路径）；页签上的名字按它取。 */
  shell: string;
  /** 实际起始目录；null 就是工作区根。重开、再开一个、跨重启恢复都按它。 */
  dir: string | null;
  /** 从哪个配置档起的；null 是直接选的 shell。 */
  profile: string | null;
  /** 配置档带来的参数与环境变量，重开时原样带上。 */
  launch: TermLaunch | null;
  /** shell 自己退出了，界面据此决定要不要另起一条。 */
  exited: boolean;
  /** 退出码；没退出或取不到时为 null。 */
  exitCode: number | null;
  /** 程序用 OSC 0/2 报上来的标题，页签优先显示它。 */
  title: string | null;
  /** shell 用 OSC 7 报上来的当前目录；`cd` 之后相对路径链接按它解析。 */
  currentDir: string | null;
  /** 用户起的页签名；null 时跟着标题和 shell 名走。 */
  name: string | null;
  /** 固定的页签排在最前，中键、「关闭其他」「关闭右侧」「全部关闭」都跳过它。整组一起固定。 */
  pinned: boolean;
  /** 不在前台时来了新输出，页签上画个点；切过去就清掉。 */
  unread: boolean;
  /** 程序响过铃，页签上挂个铃铛；切过去就清掉。 */
  bell: boolean;
  /** 分屏组号；同号的一起显示。 */
  group: number;
}

export type SplitDirection = "row" | "column";

/** 起一条会话要的东西。`dir` 为空就落在工作区根。 */
export interface TermSpec {
  shell: string;
  dir?: string | null;
  profile?: string | null;
  launch?: TermLaunch | null;
  /** shell 第一次有输出后自动敲进去，带回车。 */
  command?: string;
}

type Watcher = () => void;
type TermSink = (data: Uint8Array) => void;

let sessions: TermSession[] = [];
let activeId: TermSessionId | null = null;
/** 每个工作区根各自记住当前选中的终端标签 id。 */
const activeIdByRoot = new Map<string, TermSessionId>();
/** 终端画面观察者：数据块追加、会话切换时通知。 */
const sessionWatchers = new Set<Watcher>();
/** 页签栏观察者：只在会话增删、激活切换、进程退出时通知，不受输出数据块干扰。 */
const tabWatchers = new Set<Watcher>();
/** 输出与退出的事件订阅，一条会话一对；关会话时按 id 摘掉。 */
const unlisten = new Map<TermSessionId, UnlistenFn[]>();
/** 每条会话当前的画面入口。 */
const sinks = new Map<TermSessionId, TermSink>();
/** 分屏组的排列方向；没登记的是左右排。 */
const directions = new Map<number, SplitDirection>();
let nextGroup = 1;
/** 等 shell 第一次出声再敲的启动命令。 */
const startupCommands = new Map<TermSessionId, string>();
/** 每条会话的原始输出。xterm 重建时整段重放，滚出视线的行还在。
 *
 * 表顺序就是「最近有输出」的顺序：每次追加把该会话挪到表尾，挤预算时从表头开始。
 */
const history = new Map<TermSessionId, Uint8Array[]>();
const historyBytes = new Map<TermSessionId, number>();
/** 擦滚屏序列被切在两包之间时，记住没判断完的前缀。 */
const eraseCarry = new Map<TermSessionId, Uint8Array>();
/** 一份历史大约够撑满 xterm 的滚屏。再老的从头部丢掉。 */
const HISTORY_LIMIT = 8_000_000;
/**
 * 全部会话合计的回放预算。
 *
 * 单条封顶挡不住多项目：每个工作区根各留一条会话、每条各留 8MB，常驻工程一多，
 * 这部分就跟着会话数线性涨。合计再封一道之后，超出时按轮转从各条最老的块开始丢，
 * 每条都留个大致均等的份额——而不是把某一条整个清空，切回去时那一屏还得在。
 */
const HISTORY_TOTAL_LIMIT = 24_000_000;
/** 当前全部会话合计留着的字节数。 */
let historyTotal = 0;

/** 合计超出预算时轮转丢块：每轮各条丢一块，直到回到预算内。 */
function trimHistoryTotal() {
  while (historyTotal > HISTORY_TOTAL_LIMIT) {
    let dropped = false;
    for (const [id, queued] of history) {
      if (historyTotal <= HISTORY_TOTAL_LIMIT) return;
      // 至少留一块：刚到的输出不能被自己挤掉，重放也得有个开头。
      if (queued.length <= 1) continue;
      const chunk = queued.shift();
      if (!chunk) continue;
      historyTotal -= chunk.byteLength;
      historyBytes.set(id, (historyBytes.get(id) ?? 0) - chunk.byteLength);
      dropped = true;
    }
    if (!dropped) return;
  }
}

function pushHistory(id: TermSessionId, data: Uint8Array) {
  const queued = history.get(id) ?? [];
  // 挪到表尾：Map 的顺序即「最近有输出」的顺序，挤预算时从表头那条开始。
  history.delete(id);
  history.set(id, queued);
  const before = historyBytes.get(id) ?? 0;
  queued.push(data.slice());
  let total = before + data.byteLength;
  while (queued.length > 1 && total > HISTORY_LIMIT) {
    total -= queued.shift()?.byteLength ?? 0;
  }
  historyBytes.set(id, total);
  historyTotal += total - before;
  trimHistoryTotal();
}

/** 全部会话当前留着的回放字节数（诊断与测试用）。 */
export function termHistoryBytes(): number {
  return historyTotal;
}

function deliver(id: TermSessionId, data: Uint8Array) {
  const stripped = stripEraseScrollback(eraseCarry.get(id) ?? new Uint8Array(0), data);
  eraseCarry.set(id, stripped.carry);
  if (stripped.data.byteLength === 0) return;
  pushHistory(id, stripped.data);
  sinks.get(id)?.(stripped.data);
  markUnread(id);
  sendStartupCommand(id, 120);
}

/** 提示符出来之前写进去的字会被 PowerShell / ConPTY 吞掉，所以等第一包输出之后再敲。 */
function sendStartupCommand(id: TermSessionId, delay: number) {
  const command = startupCommands.get(id);
  if (command === undefined) return;
  startupCommands.delete(id);
  setTimeout(() => {
    if (sessions.some((item) => item.id === id && !item.exited)) {
      void termWrite(id, `${command}\r`).catch(() => {});
    }
  }, delay);
}

function markUnread(id: TermSessionId) {
  const target = sessions.find((item) => item.id === id);
  if (!target || target.unread || target.exited) return;
  if (activeIdByRoot.get(rootKey(target.cwd)) === id) return;
  target.unread = true;
  notifyTabs();
}

function markRead(id: TermSessionId): boolean {
  const target = sessions.find((item) => item.id === id);
  if (!target || (!target.unread && !target.bell)) return false;
  target.unread = false;
  target.bell = false;
  return true;
}

function forgetOutput(id: TermSessionId) {
  sinks.delete(id);
  startupCommands.delete(id);
  historyTotal -= historyBytes.get(id) ?? 0;
  if (historyTotal < 0) historyTotal = 0;
  history.delete(id);
  historyBytes.delete(id);
  eraseCarry.delete(id);
}

/** 往一条会话的输出末尾补一段本地文字（退出提示之类），和 shell 的输出一样留进历史。 */
export function appendTermNotice(id: TermSessionId, text: string): void {
  if (!sessions.some((item) => item.id === id)) return;
  const data = new TextEncoder().encode(text);
  pushHistory(id, data);
  sinks.get(id)?.(data);
}

/** 程序报上来的标题。和原来一样就不通知，免得每个提示符都刷一遍页签栏。 */
export function setTermTitle(id: TermSessionId, title: string | null): void {
  const target = sessions.find((item) => item.id === id);
  if (!target || target.title === title) return;
  target.title = title;
  notifyTabs();
}

/** shell 报上来的当前目录。只给链接解析和布局存盘用，页签不跟着变。 */
export function setTermCurrentDir(id: TermSessionId, dir: string): void {
  const target = sessions.find((item) => item.id === id);
  if (!target || target.currentDir === dir) return;
  target.currentDir = dir;
  schedulePersist();
}

/** 程序响铃。前台那条不挂铃铛，界面上闪一下就够了。 */
export function ringTermBell(id: TermSessionId): void {
  const target = sessions.find((item) => item.id === id);
  if (!target || target.bell) return;
  if (activeIdByRoot.get(rootKey(target.cwd)) === id) return;
  target.bell = true;
  notifyTabs();
}

/** 清屏按钮：把留着的原始输出也清掉，避免下次重放把刚清掉的日志写回来。 */
export function clearTermHistory(id: TermSessionId): void {
  historyTotal -= historyBytes.get(id) ?? 0;
  if (historyTotal < 0) historyTotal = 0;
  history.delete(id);
  historyBytes.delete(id);
  eraseCarry.delete(id);
}

/**
 * 把一条会话的输出接到画面上。
 *
 * 挂上时先把已经留下的整段历史写进这个 xterm，滚出视线的行跟着回到滚屏里。
 * 返回的函数只摘掉入口，历史还留着，下一次挂上继续重放。
 */
export function attachTermOutput(id: TermSessionId, sink: TermSink): () => void {
  const snapshot = (history.get(id) ?? []).slice();
  sinks.set(id, sink);
  for (const chunk of snapshot) sink(chunk);
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

/** 归一化工作区根键，大小写与斜杠不敏感。 */
function rootKey(cwd: string | null): string {
  return cwd ? cwd.replaceAll("\\", "/").toLocaleLowerCase() : "";
}

/** 判定两个 cwd 是否指向同一工作区根。 */
function sameCwd(a: string | null, b: string | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return samePath(a, b);
}

function notifySession() {
  for (const watch of sessionWatchers) watch();
}

function notifyTabs() {
  for (const watch of tabWatchers) watch();
  schedulePersist();
}

function notifyAll() {
  notifySession();
  notifyTabs();
}

/** 页签顺序：固定的在前；同组的挨在一起，组的位置按组里最靠前那条算。 */
function arrange(list: TermSession[]): TermSession[] {
  const cluster = (items: TermSession[]) => {
    const out: TermSession[] = [];
    const placed = new Set<number>();
    for (const item of items) {
      if (placed.has(item.group)) continue;
      placed.add(item.group);
      out.push(...items.filter((other) => other.group === item.group));
    }
    return out;
  };
  return [...cluster(list.filter((item) => item.pinned)), ...cluster(list.filter((item) => !item.pinned))];
}

/** 当前全部会话（按页签顺序），以及哪一条是激活的。 */
export function termSessions(): { sessions: TermSession[]; activeId: TermSessionId | null } {
  return { sessions, activeId };
}

/** 读指定工作区根下的会话列表与该根的激活 id。 */
export function termSessionsFor(cwd: string | null): {
  sessions: TermSession[];
  activeId: TermSessionId | null;
} {
  const list = arrange(sessions.filter((item) => sameCwd(item.cwd, cwd)));
  const held = activeIdByRoot.get(rootKey(cwd)) ?? null;
  const resolved =
    held && list.some((item) => item.id === held)
      ? held
      : (list[list.length - 1]?.id ?? null);
  return { sessions: list, activeId: resolved };
}

/** 当前激活的那条会话，没有则 null。 */
export function termSession(): TermSession | null {
  return sessions.find((item) => item.id === activeId) ?? null;
}

/** 按 id 取一条会话；会话已经关掉时返回 null。 */
export function termSessionById(id: TermSessionId): TermSession | null {
  return sessions.find((item) => item.id === id) ?? null;
}

/** 返回指定工作区根下当前激活的那条会话。 */
export function termSessionFor(cwd: string | null): TermSession | null {
  const { sessions: list, activeId: id } = termSessionsFor(cwd);
  return list.find((item) => item.id === id) ?? null;
}

/** 一条会话所在的分屏组（按页签顺序）和排列方向。 */
export function termGroupOf(id: TermSessionId): { members: TermSession[]; direction: SplitDirection } {
  const target = sessions.find((item) => item.id === id);
  if (!target) return { members: [], direction: "row" };
  return {
    members: termSessionsFor(target.cwd).sessions.filter((item) => item.group === target.group),
    direction: directions.get(target.group) ?? "row",
  };
}

/** 指定工作区根下是否存在尚未退出的终端会话（供顶栏工程切换器的后台运行绿点判定）。 */
export function hasAliveTermsForRoot(cwd: string | null): boolean {
  if (!cwd) return false;
  return sessions.some((item) => !item.exited && sameCwd(item.cwd, cwd));
}

/**
 * 订阅当前终端画面的内容变动（供 TerminalPane 内部消费）。
 */
export function watchTermSession(watch: Watcher): () => void {
  sessionWatchers.add(watch);
  watch();
  return () => {
    sessionWatchers.delete(watch);
  };
}

/**
 * 仅订阅终端页签的元数据变动（新增、关闭、激活切换、进程退出），不受高频数据输出干扰。
 */
export function watchTermTabs(watch: Watcher): () => void {
  tabWatchers.add(watch);
  watch();
  return () => {
    tabWatchers.delete(watch);
  };
}

/** 切到某条会话。 */
export function setActiveTerm(id: TermSessionId): void {
  const target = sessions.find((item) => item.id === id);
  if (target) activeIdByRoot.set(rootKey(target.cwd), id);
  markRead(id);
  if (activeId === id) {
    notifyAll();
    return;
  }
  activeId = id;
  notifyAll();
}

/** 在指定工作区根下切到某条会话。 */
export function setActiveTermFor(cwd: string | null, id: TermSessionId): void {
  const key = rootKey(cwd);
  const prev = activeIdByRoot.get(key);
  activeIdByRoot.set(key, id);
  const changed = markRead(id);
  if (activeId === id && prev === id) {
    if (changed) notifyTabs();
    return;
  }
  activeId = id;
  notifyAll();
}

/** 改页签名；空白表示恢复成自动取名。 */
export function renameTerm(id: TermSessionId, name: string): void {
  const target = sessions.find((item) => item.id === id);
  if (!target) return;
  const next = name.trim() || null;
  if (target.name === next) return;
  target.name = next;
  notifyTabs();
}

/** 同根同组的会话，按页签顺序。 */
function groupMembers(target: TermSession): TermSession[] {
  return arrange(sessions.filter((item) => sameCwd(item.cwd, target.cwd) && item.group === target.group));
}

/** 整组一起固定 / 取消。新固定的排到固定区末尾，取消固定的排到普通区开头。 */
export function toggleTermPin(id: TermSessionId): void {
  const target = sessions.find((item) => item.id === id);
  if (!target) return;
  const block = groupMembers(target);
  const pinned = !target.pinned;
  for (const item of block) item.pinned = pinned;
  const rest = sessions.filter((item) => !block.includes(item));
  const same = rest.filter((item) => sameCwd(item.cwd, target.cwd));
  const anchor = pinned ? same.filter((item) => item.pinned).pop() : same.find((item) => !item.pinned);
  const at = anchor ? rest.indexOf(anchor) + (pinned ? 1 : 0) : rest.length;
  rest.splice(at, 0, ...block);
  sessions = rest;
  notifyAll();
}

/**
 * 拖拽排序：把 `id` 挪到 `targetId` 前面（`after` 时挪到后面）。
 *
 * 同组里挪的是这一条；跨组挪的是整组，落在目标那组的前面或后面。
 * 只在同一个根、同一区（固定 / 普通）里挪；跨区的放下不生效。
 */
export function moveTerm(id: TermSessionId, targetId: TermSessionId, after: boolean): void {
  if (id === targetId) return;
  const moving = sessions.find((item) => item.id === id);
  const target = sessions.find((item) => item.id === targetId);
  if (!moving || !target || moving.pinned !== target.pinned || !sameCwd(moving.cwd, target.cwd)) {
    return;
  }
  if (moving.group === target.group) {
    const rest = sessions.filter((item) => item.id !== id);
    rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, moving);
    sessions = rest;
  } else {
    const block = groupMembers(moving);
    const rest = sessions.filter((item) => !block.includes(item));
    const targets = groupMembers(target);
    const edge = after ? targets[targets.length - 1] : targets[0];
    rest.splice(rest.indexOf(edge) + (after ? 1 : 0), 0, ...block);
    sessions = rest;
  }
  notifyAll();
}

/** 按页签顺序取同根的会话，批量关闭时用。 */
function rootTabs(id: TermSessionId): TermSession[] {
  const target = sessions.find((item) => item.id === id);
  return target ? termSessionsFor(target.cwd).sessions : [];
}

export async function closeOtherTerms(id: TermSessionId): Promise<void> {
  const doomed = rootTabs(id).filter((item) => item.id !== id && !item.pinned);
  await Promise.all(doomed.map((item) => closeTerm(item.id)));
}

export async function closeTermsToRight(id: TermSessionId): Promise<void> {
  const tabs = rootTabs(id);
  const doomed = tabs.slice(tabs.findIndex((item) => item.id === id) + 1).filter((item) => !item.pinned);
  await Promise.all(doomed.map((item) => closeTerm(item.id)));
}

/** 关掉一个根下全部没固定的页签。 */
export async function closeUnpinnedTerms(cwd: string | null): Promise<void> {
  const doomed = termSessionsFor(cwd).sessions.filter((item) => !item.pinned);
  await Promise.all(doomed.map((item) => closeTerm(item.id)));
}

/** 再开一条同样的：同 shell、同配置档，落在它现在 `cd` 到的目录，放在原页签那组后面。 */
export async function duplicateTerm(id: TermSessionId, cols: number, rows: number): Promise<TermSession | null> {
  const source = sessions.find((item) => item.id === id);
  if (!source) return null;
  const created = await open(source.cwd, specOf(source), cols, rows);
  if (source.pinned) toggleTermPin(created.id);
  moveTerm(created.id, source.id, true);
  return created;
}

/** 在旁边拆一条出来，同 shell、同目录，和它同组显示。 */
export async function splitTerm(
  id: TermSessionId,
  direction: SplitDirection,
  cols: number,
  rows: number
): Promise<TermSession | null> {
  const source = sessions.find((item) => item.id === id);
  if (!source) return null;
  const block = groupMembers(source);
  if (block.length === 1) directions.set(source.group, direction);
  const created = await open(source.cwd, specOf(source), cols, rows, source.group);
  created.pinned = source.pinned;
  const rest = sessions.filter((item) => item.id !== created.id);
  const live = groupMembers(source).filter((item) => item.id !== created.id);
  const last = live[live.length - 1];
  rest.splice(last ? rest.indexOf(last) + 1 : rest.length, 0, created);
  sessions = rest;
  notifyAll();
  return created;
}

/** 把一条从分屏里拿出来，自成一个页签，放在原来那组后面。 */
export function unsplitTerm(id: TermSessionId): void {
  const target = sessions.find((item) => item.id === id);
  if (!target) return;
  const block = groupMembers(target);
  if (block.length < 2) return;
  const last = block[block.length - 1];
  target.group = nextGroup++;
  const rest = sessions.filter((item) => item.id !== id);
  rest.splice(rest.indexOf(last === target ? block[block.length - 2] : last) + 1, 0, target);
  sessions = rest;
  notifyAll();
}

export function setSplitDirection(id: TermSessionId, direction: SplitDirection): void {
  const target = sessions.find((item) => item.id === id);
  if (!target || directions.get(target.group) === direction) return;
  directions.set(target.group, direction);
  notifyAll();
}

/** 重开、再开一个用的起法：目录取 shell 现在所在的那个。不再跑启动命令。 */
function specOf(source: TermSession): TermSpec {
  return {
    shell: source.shell,
    dir: source.currentDir ?? source.dir,
    profile: source.profile,
    launch: source.launch,
  };
}

/** 已关闭会话的登记簿。listen 要一次 IPC 往返才 resolve，登记（关闭）可能赶在
 * 订阅返回之前——resolve 时查这张表，命中的监听当场解绑，不留成收不走的孤儿。
 *
 * 会话 id 单调递增、不会复用，所以老条目本身没有用处；常驻久了开关几十次终端就攒下一串。
 * 留最近 256 个足够覆盖往返窗口（毫秒级），更早的整批丢掉。 */
const closed = new Set<TermSessionId>();
const CLOSED_LIMIT = 256;

function markClosed(id: TermSessionId) {
  closed.add(id);
  if (closed.size <= CLOSED_LIMIT) return;
  for (const stale of [...closed].slice(0, closed.size - CLOSED_LIMIT)) closed.delete(stale);
}

/** 同一个根上正在开的那一条。面板挂载会被跑两遍，不能因此起两个 shell。 */
const opening = new Map<string, Promise<TermSession>>();

/**
 * 起一条新会话，返回它。起完自动切成激活。
 * 指定的起始目录起不来（目录被删了之类）就退回工作区根再试一次。
 */
async function open(
  cwd: string | null,
  spec: TermSpec,
  cols: number,
  rows: number,
  group?: number
): Promise<TermSession> {
  const dir = spec.dir && !sameCwd(spec.dir, cwd) ? spec.dir : null;
  const launch = spec.launch ?? undefined;
  let id: TermSessionId;
  let startedIn = dir;
  try {
    id = await termOpen(dir ?? cwd, spec.shell, cols, rows, launch);
  } catch (cause) {
    if (!dir) throw cause;
    startedIn = null;
    id = await termOpen(cwd, spec.shell, cols, rows, launch);
  }
  const created: TermSession = {
    id,
    cwd,
    shell: spec.shell,
    dir: startedIn,
    profile: spec.profile ?? null,
    launch: spec.launch ?? null,
    exited: false,
    exitCode: null,
    title: null,
    currentDir: null,
    name: null,
    pinned: false,
    unread: false,
    bell: false,
    group: group ?? nextGroup++,
  };
  sessions = [...sessions, created];
  activeId = id;
  activeIdByRoot.set(rootKey(cwd), id);
  restored.add(rootKey(cwd));
  if (spec.command?.trim()) {
    startupCommands.set(id, spec.command);
    // 有的 shell 起来一声不吭（`-NoLogo` 加空提示符），等不到第一包也得敲。
    setTimeout(() => sendStartupCommand(id, 0), 2000);
  }
  const offs: UnlistenFn[] = [];
  const adopt = (off: UnlistenFn) => {
    if (closed.has(id)) {
      // 往返期间会话已被关掉：监听器当场解绑，不能推进没人认领的数组。
      off();
      return;
    }
    offs.push(off);
  };
  void listen<TermChunk>("term://output", (event) => {
    if (event.payload.id !== id) return;
    if (!sessions.some((item) => item.id === id)) return;
    deliver(id, decodeChunk(event.payload.data));
  }).then(adopt);
  void listen<TermExit>("term://exit", (event) => {
    if (event.payload.id !== id) return;
    const target = sessions.find((item) => item.id === id);
    if (!target) return;
    target.exited = true;
    target.exitCode = event.payload.code;
    startupCommands.delete(id);
    // 敲 exit 正常退出就把页签收掉；非零退出留着最后一屏，让人看得见出了什么错。
    if (event.payload.code === 0) {
      void closeTerm(id);
      return;
    }
    notifyAll();
  }).then(adopt);
  unlisten.set(id, offs);
  notifyAll();
  return created;
}

/** 新建一条会话（终端头部那颗 `+` 和配置档菜单走这里）。 */
export async function openTerm(
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number,
  extra?: Omit<TermSpec, "shell">
): Promise<TermSession> {
  return open(cwd, { ...extra, shell }, cols, rows);
}

/** 起终端的初始尺寸；面板挂上来之后会自己 fit 成真实尺寸。 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * 在终端里跑一条命令：找一条同 shell、同起始目录且还活着的会话复用它，没有就新开一条。
 *
 * 不复用 `needTermSession`：那个只看 `cwd`，会把一个 cmd 会话错当成能跑 `.ps1` 的去用，
 * 于是命令落进了不对的 shell。命令末尾补 `\r`——PTY 的行编辑由 shell 自己做，回车得自己带。
 *
 * `onOpened` 在会话进表、成为激活之后、写命令之前调用：调用方借此把终端面板拉起，
 * 面板挂载时 `needTermSession` 才认得出「已经有一条了」而不另开一条空的。
 */
export async function runInTerminal(
  shell: string,
  cwd: string | null,
  command: string,
  onOpened?: () => void
): Promise<void> {
  const reused = sessions.find(
    (item) => !item.exited && sameCwd(item.cwd, cwd) && item.shell === shell && !item.profile
  );
  const session = reused ?? (await open(cwd, { shell }, DEFAULT_COLS, DEFAULT_ROWS));
  setActiveTermFor(cwd, session.id);
  onOpened?.();
  if (!reused) {
    // 新启动的终端子进程（特别是 Windows PowerShell/ConPTY）需要等待环境初始化，避免过早写入导致字符被丢弃
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await termWrite(session.id, `${command}\r`);
}

/** 关掉一条会话：摘订阅、收 PTY、从列表里去掉；关的是激活那条就把激活位挪给同根邻居。 */
export async function closeTerm(id: TermSessionId): Promise<void> {
  const target = sessions.find((item) => item.id === id);
  if (!target) return;
  const key = rootKey(target.cwd);
  const sameRootList = termSessionsFor(target.cwd).sessions;
  const rootIndex = sameRootList.indexOf(target);
  // 分屏里关掉一条，焦点留在同组；同组没了再找相邻页签。
  const sameGroup = sameRootList.filter((item) => item.group === target.group && item.id !== id);
  const restSameRoot = sameRootList.filter((item) => item.id !== id);
  const index = sessions.indexOf(target);
  sessions = sessions.filter((item) => item.id !== id);
  // 先登记再解绑：还挂在 IPC 往返上的订阅 resolve 时会查到这张表。
  markClosed(id);
  forgetOutput(id);
  for (const off of unlisten.get(id) ?? []) off();
  unlisten.delete(id);
  if (restSameRoot.length === 0) forgottenRoots.add(key);
  if (activeIdByRoot.get(key) === id) {
    const fallbackRoot =
      sameGroup[0] ?? restSameRoot[rootIndex] ?? restSameRoot[rootIndex - 1] ?? null;
    if (fallbackRoot) activeIdByRoot.set(key, fallbackRoot.id);
    else activeIdByRoot.delete(key);
  }
  if (activeId === id) {
    const fallback = activeIdByRoot.get(key) ?? sessions[index]?.id ?? sessions[index - 1]?.id ?? null;
    activeId = fallback;
  }
  notifyAll();
  await termClose(id).catch(() => {});
}

/** 只收掉指定工作区根下的全部终端会话：关闭某个文件夹时走这里，不伤其它常驻根的终端。 */
export async function closeTermsForRoot(cwd: string | null): Promise<void> {
  if (!cwd) return;
  const doomed = sessions.filter((item) => sameCwd(item.cwd, cwd));
  activeIdByRoot.delete(rootKey(cwd));
  if (doomed.length === 0) return;
  // 存盘的布局留着：下次再打开这个文件夹按它恢复。
  await flushPersist();
  const doomedIds = new Set(doomed.map((item) => item.id));
  sessions = sessions.filter((item) => !doomedIds.has(item.id));
  restored.delete(rootKey(cwd));
  for (const item of doomed) {
    markClosed(item.id);
    forgetOutput(item.id);
    for (const off of unlisten.get(item.id) ?? []) off();
    unlisten.delete(item.id);
  }
  if (activeId !== null && doomedIds.has(activeId)) {
    activeId = sessions[sessions.length - 1]?.id ?? null;
  }
  notifyAll();
  await Promise.all(doomed.map((item) => termClose(item.id).catch(() => {})));
}

/** 收掉全部会话：退出应用或关闭全部工程时走这里。布局先落盘，下次启动照着恢复。 */
export async function dropTermSession(): Promise<void> {
  await flushPersist();
  const all = sessions;
  sessions = [];
  activeId = null;
  activeIdByRoot.clear();
  restored.clear();
  for (const item of all) {
    markClosed(item.id);
    forgetOutput(item.id);
  }
  for (const [, offs] of unlisten) for (const off of offs) off();
  unlisten.clear();
  notifyAll();
  await Promise.all(all.map((item) => termClose(item.id).catch(() => {})));
}

/**
 * 面板挂上来时要的那条会话：当前根下激活那条能留就留（后台还在跑）。
 * 一条都没有时先看存盘的布局，有就整组恢复；没有（或激活的 shell 已退出）才补一条默认的。
 */
export async function needTermSession(
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number
): Promise<TermSession> {
  const current = termSessionFor(cwd);
  if (current && !current.exited) {
    activeId = current.id;
    activeIdByRoot.set(rootKey(cwd), current.id);
    return current;
  }
  // 激活那条 shell 退出了：换同根下一条没退的；都没有就新开。
  const alive = sessions.find((item) => !item.exited && sameCwd(item.cwd, cwd));
  if (alive) {
    activeId = alive.id;
    activeIdByRoot.set(rootKey(cwd), alive.id);
    notifyAll();
    return alive;
  }
  const key = rootKey(cwd);
  const pending = opening.get(key);
  if (pending) return pending;
  const fresh = !restored.has(key) && !sessions.some((item) => sameCwd(item.cwd, cwd));
  const created = (async () => {
    if (fresh) {
      restored.add(key);
      const back = await restoreRoot(cwd, cols, rows);
      if (back) return back;
    }
    return open(cwd, { shell }, cols, rows);
  })().finally(() => {
    if (opening.get(key) === created) opening.delete(key);
  });
  opening.set(key, created);
  return created;
}

/**
 * 重开会话：同根、同 shell、同目录起一条新的顶替它，页签位置、名字、固定、分屏组都留着。
 * 会话已经不在了返回 null。
 */
export async function restartTerm(
  id: TermSessionId,
  cols: number = DEFAULT_COLS,
  rows: number = DEFAULT_ROWS
): Promise<TermSession | null> {
  const old = sessions.find((item) => item.id === id);
  if (!old) return null;
  const neighbor = sessions[sessions.indexOf(old) + 1] ?? null;
  const spec = { ...specOf(old), dir: old.dir };
  await closeTerm(id);
  const created = await open(old.cwd, spec, cols, rows, old.group);
  created.name = old.name;
  created.pinned = old.pinned;
  const rest = sessions.filter((item) => item.id !== created.id);
  const at = neighbor ? rest.indexOf(neighbor) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, created);
  sessions = rest;
  notifyAll();
  return created;
}

// ---- 页签布局存盘 ----

interface SavedTab {
  shell: string;
  dir: string | null;
  name: string | null;
  pinned: boolean;
  group: number;
  profile: string | null;
}

interface SavedRoot {
  /** 原始的根路径，键是归一化过的。 */
  cwd: string | null;
  tabs: SavedTab[];
  active: number;
  directions: Record<string, SplitDirection>;
}

/** 配置档改过之后，恢复出来的页签按最新的配置档起；配置档删了就只按 shell 起。 */
type ProfileResolver = (profile: string) => Omit<TermSpec, "command" | "dir"> | null;
let resolveProfile: ProfileResolver = () => null;

export function setTermProfileResolver(resolver: ProfileResolver): void {
  resolveProfile = resolver;
}

/** 这一轮已经恢复过（或已经有会话）的根。全关掉之后再打开面板，不再恢复第二遍。 */
const restored = new Set<string>();
/** 页签全被用户关掉的根：存盘时把它的布局也删掉。 */
const forgottenRoots = new Set<string>();
let savedLayouts: Promise<Record<string, SavedRoot>> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DELAY = 600;

function asSavedRoot(raw: unknown): SavedRoot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<SavedRoot>;
  if (!Array.isArray(value.tabs)) return null;
  const tabs = value.tabs
    .filter((tab): tab is SavedTab => !!tab && typeof tab === "object" && typeof tab.shell === "string")
    .map((tab) => ({
      shell: tab.shell,
      dir: typeof tab.dir === "string" && tab.dir ? tab.dir : null,
      name: typeof tab.name === "string" && tab.name ? tab.name : null,
      pinned: tab.pinned === true,
      group: typeof tab.group === "number" ? tab.group : 0,
      profile: typeof tab.profile === "string" && tab.profile ? tab.profile : null,
    }));
  const directionsRaw = value.directions && typeof value.directions === "object" ? value.directions : {};
  const savedDirections: Record<string, SplitDirection> = {};
  for (const [group, direction] of Object.entries(directionsRaw)) {
    if (direction === "row" || direction === "column") savedDirections[group] = direction;
  }
  return {
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    tabs,
    active: typeof value.active === "number" ? value.active : tabs.length - 1,
    directions: savedDirections,
  };
}

function layouts(): Promise<Record<string, SavedRoot>> {
  savedLayouts ??= termLayoutLoad().then((raw) => {
    const out: Record<string, SavedRoot> = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        const root = asSavedRoot(value);
        if (root && root.tabs.length > 0) out[key] = root;
      }
    }
    return out;
  });
  return savedLayouts;
}

function snapshotRoot(cwd: string | null): SavedRoot {
  const { sessions: list, activeId: active } = termSessionsFor(cwd);
  const groupIndex = new Map<number, number>();
  const tabs = list.map((item) => {
    if (!groupIndex.has(item.group)) groupIndex.set(item.group, groupIndex.size);
    return {
      shell: item.shell,
      dir: item.currentDir ?? item.dir,
      name: item.name,
      pinned: item.pinned,
      group: groupIndex.get(item.group) ?? 0,
      profile: item.profile,
    };
  });
  const savedDirections: Record<string, SplitDirection> = {};
  for (const [group, index] of groupIndex) {
    const direction = directions.get(group);
    if (direction) savedDirections[String(index)] = direction;
  }
  return {
    cwd,
    tabs,
    active: Math.max(0, list.findIndex((item) => item.id === active)),
    directions: savedDirections,
  };
}

async function persistNow(): Promise<void> {
  const current = await layouts();
  const next: Record<string, SavedRoot> = { ...current };
  for (const key of forgottenRoots) delete next[key];
  forgottenRoots.clear();
  const roots = new Map<string, string | null>();
  for (const item of sessions) roots.set(rootKey(item.cwd), item.cwd);
  for (const [key, cwd] of roots) next[key] = snapshotRoot(cwd);
  savedLayouts = Promise.resolve(next);
  await termLayoutSave(next as unknown as Record<string, unknown>);
}

function schedulePersist() {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DELAY);
}

/** 马上把还没落盘的改动写掉；关文件夹、退出应用之前调。 */
export async function flushPersist(): Promise<void> {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  await persistNow();
}

/** 按存盘的布局把一个根的页签整组起回来，返回恢复后激活的那条；一条都起不来返回 null。 */
async function restoreRoot(cwd: string | null, cols: number, rows: number): Promise<TermSession | null> {
  const layout = (await layouts())[rootKey(cwd)];
  if (!layout || layout.tabs.length === 0) return null;
  const groups = new Map<number, number>();
  const opened: TermSession[] = [];
  for (const tab of layout.tabs) {
    const group = groups.get(tab.group) ?? nextGroup++;
    groups.set(tab.group, group);
    const profile = tab.profile ? resolveProfile(tab.profile) : null;
    try {
      const created = await open(
        cwd,
        { ...(profile ?? {}), shell: profile?.shell || tab.shell, dir: tab.dir, profile: tab.profile },
        cols,
        rows,
        group
      );
      created.name = tab.name;
      created.pinned = tab.pinned;
      opened.push(created);
    } catch {
      // 那个 shell 卸掉了之类：少一个页签，别的照常恢复。
    }
  }
  if (opened.length === 0) return null;
  for (const [saved, group] of groups) {
    const direction = layout.directions[String(saved)];
    if (direction) directions.set(group, direction);
  }
  const target = opened[Math.min(layout.active, opened.length - 1)] ?? opened[opened.length - 1];
  activeId = target.id;
  activeIdByRoot.set(rootKey(cwd), target.id);
  notifyAll();
  return target;
}
