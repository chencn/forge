import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { termClose, termOpen, termWrite } from "./term";
import type { TermChunk, TermExit, TermSessionId } from "./term";
import { samePath } from "./format";

/**
 * 一条终端会话：后端 PTY 的 id，外加一份界面收起时也不丢的输出缓冲。
 *
 * 会话故意放在模块级而不是组件里——面板最小化、在底部和选项卡之间来回切，
 * 都不该把 shell 一起带走；任务要继续跑，回来还得看见之前打印的东西。
 * 多条会话并存，页签按 `sessions` 的顺序排，`activeId` 是当前看着的那条。
 * 多工作区常驻时，每个工作区根各自维护一组会话与自己的激活会话 id，切根时不杀后台终端。
 */
export interface TermSession {
  id: TermSessionId;
  /** 起始终点，换工作区时据此判断这条会话归属哪个根。 */
  cwd: string | null;
  /** 这条会话用的 shell 路径；页签上的名字按它取。 */
  shell: string;
  /** base64 片段，按到达顺序存；重挂界面时原样喂回 xterm。 */
  chunks: string[];
  /** shell 自己退出了，界面据此决定要不要另起一条。 */
  exited: boolean;
}

type Watcher = () => void;

/** 单条会话最多保留多少段输出缓冲，防住无限膨胀内存泄漏（500 段 * ~32KB 约 16MB 滚屏记录）。 */
const MAX_SESSION_CHUNKS = 500;

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
}

function notifyAll() {
  notifySession();
  notifyTabs();
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
  const list = sessions.filter((item) => sameCwd(item.cwd, cwd));
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

/** 返回指定工作区根下当前激活的那条会话。 */
export function termSessionFor(cwd: string | null): TermSession | null {
  const { sessions: list, activeId: id } = termSessionsFor(cwd);
  return list.find((item) => item.id === id) ?? null;
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
  if (activeId === id && prev === id) return;
  activeId = id;
  notifyAll();
}

/** 已关闭会话的登记簿。listen 要一次 IPC 往返才 resolve，登记（关闭）可能赶在
 * 订阅返回之前——resolve 时查这张表，命中的监听当场解绑，不留成收不走的孤儿。 */
const closed = new Set<TermSessionId>();

/** 起一条新会话，返回它。起完自动切成激活。 */
async function open(cwd: string | null, shell: string, cols: number, rows: number): Promise<TermSession> {
  const id = await termOpen(cwd, shell, cols, rows);
  const created: TermSession = { id, cwd, shell, chunks: [], exited: false };
  sessions = [...sessions, created];
  activeId = id;
  activeIdByRoot.set(rootKey(cwd), id);
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
    const target = sessions.find((item) => item.id === id);
    if (!target) return;
    // 超过上限淘汰旧块，截断内存占用
    if (target.chunks.length >= MAX_SESSION_CHUNKS) {
      target.chunks.splice(0, target.chunks.length - MAX_SESSION_CHUNKS + 1);
    }
    target.chunks.push(event.payload.data);
    // 只通知终端屏幕渲染，不触发页签栏等纯结构组件
    notifySession();
  }).then(adopt);
  void listen<TermExit>("term://exit", (event) => {
    if (event.payload.id !== id) return;
    const target = sessions.find((item) => item.id === id);
    if (!target) return;
    target.exited = true;
    notifyAll();
  }).then(adopt);
  unlisten.set(id, offs);
  notifyAll();
  return created;
}

/** 新建一条会话（终端头部那颗 `+` 走这里）。 */
export async function openTerm(
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number
): Promise<TermSession> {
  return open(cwd, shell, cols, rows);
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
    (item) => !item.exited && sameCwd(item.cwd, cwd) && item.shell === shell
  );
  const session = reused ?? (await open(cwd, shell, DEFAULT_COLS, DEFAULT_ROWS));
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
  const sameRootList = sessions.filter((item) => sameCwd(item.cwd, target.cwd));
  const rootIndex = sameRootList.indexOf(target);
  const restSameRoot = sameRootList.filter((item) => item.id !== id);
  const index = sessions.indexOf(target);
  sessions = sessions.filter((item) => item.id !== id);
  // 先登记再解绑：还挂在 IPC 往返上的订阅 resolve 时会查到这张表。
  closed.add(id);
  for (const off of unlisten.get(id) ?? []) off();
  unlisten.delete(id);
  if (activeIdByRoot.get(key) === id) {
    const fallbackRoot = restSameRoot[rootIndex] ?? restSameRoot[rootIndex - 1] ?? null;
    if (fallbackRoot) activeIdByRoot.set(key, fallbackRoot.id);
    else activeIdByRoot.delete(key);
  }
  if (activeId === id) {
    const fallback = sessions[index] ?? sessions[index - 1] ?? null;
    activeId = fallback ? fallback.id : null;
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
  const doomedIds = new Set(doomed.map((item) => item.id));
  sessions = sessions.filter((item) => !doomedIds.has(item.id));
  for (const item of doomed) {
    closed.add(item.id);
    for (const off of unlisten.get(item.id) ?? []) off();
    unlisten.delete(item.id);
  }
  if (activeId !== null && doomedIds.has(activeId)) {
    activeId = sessions[sessions.length - 1]?.id ?? null;
  }
  notifyAll();
  await Promise.all(doomed.map((item) => termClose(item.id).catch(() => {})));
}

/** 收掉全部会话：退出应用或关闭全部工程时走这里。 */
export async function dropTermSession(): Promise<void> {
  const all = sessions;
  sessions = [];
  activeId = null;
  activeIdByRoot.clear();
  for (const item of all) closed.add(item.id);
  for (const [, offs] of unlisten) for (const off of offs) off();
  unlisten.clear();
  notifyAll();
  await Promise.all(all.map((item) => termClose(item.id).catch(() => {})));
}

/**
 * 面板挂上来时要的那条会话：当前根下激活那条能留就留（后台还在跑）。
 * 一条都没有（或激活的 shell 已退出）时补一条，保证面板上有东西可看。
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
  return open(cwd, shell, cols, rows);
}

/** 终端里那颗「重开会话」：把指定会话收掉再原地起一条新的。 */
export async function restartTermSession(
  id: TermSessionId,
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number
): Promise<TermSession> {
  await closeTerm(id);
  return open(cwd, shell, cols, rows);
}
