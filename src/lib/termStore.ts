import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { termClose, termOpen } from "./term";
import type { TermChunk, TermExit, TermSessionId } from "./term";

/**
 * 一条终端会话：后端 PTY 的 id，外加一份界面收起时也不丢的输出缓冲。
 *
 * 会话故意放在模块级而不是组件里——面板最小化、在底部和选项卡之间来回切，
 * 都不该把 shell 一起带走；任务要继续跑，回来还得看见之前打印的东西。
 * 多条会话并存，页签按 `sessions` 的顺序排，`activeId` 是当前看着的那条。
 */
export interface TermSession {
  id: TermSessionId;
  /** 起始终点，换工作区时据此判断这条会话还该不该留着。 */
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
/** 终端画面观察者：数据块追加、会话切换时通知。 */
const sessionWatchers = new Set<Watcher>();
/** 页签栏观察者：只在会话增删、激活切换、进程退出时通知，不受输出数据块干扰。 */
const tabWatchers = new Set<Watcher>();
/** 输出与退出的事件订阅，一条会话一对；关会话时按 id 摘掉。 */
const unlisten = new Map<TermSessionId, UnlistenFn[]>();

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

/** 当前激活的那条会话，没有则 null。 */
export function termSession(): TermSession | null {
  return sessions.find((item) => item.id === activeId) ?? null;
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
  if (activeId === id) return;
  activeId = id;
  notifyAll();
}

/** 起一条新会话，返回它。起完自动切成激活。 */
async function open(cwd: string | null, shell: string, cols: number, rows: number): Promise<TermSession> {
  const id = await termOpen(cwd, shell, cols, rows);
  const created: TermSession = { id, cwd, shell, chunks: [], exited: false };
  sessions = [...sessions, created];
  activeId = id;
  const offs: UnlistenFn[] = [];
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
  }).then((off) => offs.push(off));
  void listen<TermExit>("term://exit", (event) => {
    if (event.payload.id !== id) return;
    const target = sessions.find((item) => item.id === id);
    if (!target) return;
    target.exited = true;
    notifyAll();
  }).then((off) => offs.push(off));
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

/** 关掉一条会话：摘订阅、收 PTY、从列表里去掉；关的是激活那条就把激活位挪给邻居。 */
export async function closeTerm(id: TermSessionId): Promise<void> {
  const target = sessions.find((item) => item.id === id);
  if (!target) return;
  const index = sessions.indexOf(target);
  sessions = sessions.filter((item) => item.id !== id);
  for (const off of unlisten.get(id) ?? []) off();
  unlisten.delete(id);
  if (activeId === id) {
    const fallback = sessions[index] ?? sessions[index - 1] ?? null;
    activeId = fallback ? fallback.id : null;
  }
  notifyAll();
  await termClose(id).catch(() => {});
}

/** 收掉全部会话：换工作区、退出应用才走这里。 */
export async function dropTermSession(): Promise<void> {
  const all = sessions;
  sessions = [];
  activeId = null;
  for (const [, offs] of unlisten) for (const off of offs) off();
  unlisten.clear();
  notifyAll();
  await Promise.all(all.map((item) => termClose(item.id).catch(() => {})));
}

/**
 * 面板挂上来时要的那条会话：当前激活那条能留就留（后台还在跑）。
 * 一条都没有（或激活的 shell 已退出）时补一条，保证面板上有东西可看。
 */
export async function needTermSession(
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number
): Promise<TermSession> {
  const current = termSession();
  if (current && !current.exited && current.cwd === cwd) return current;
  // 激活那条 shell 退出了：换一条没退的；都没有就新开。
  const alive = sessions.find((item) => !item.exited && item.cwd === cwd);
  if (alive) {
    activeId = alive.id;
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
