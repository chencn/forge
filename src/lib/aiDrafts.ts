import { aiSessionStorageKey } from "./aiSessions";

/**
 * 聊天输入框的草稿与历史召回。
 *
 * 两类数据都挂在会话存储键下面：路径归一化只做一次，删会话时也知道该清哪一串。
 * 草稿按会话隔离（切标签不该看到别人的半截话），发送历史按工程共享（↑ 召回的是
 * 「我在这个项目里说过什么」，跟哪个标签无关）。
 */
const draftKey = (workspace: string | null, sessionId: string) => `${aiSessionStorageKey(workspace)}:draft:${sessionId}`;
const historyKey = (workspace: string | null) => `${aiSessionStorageKey(workspace)}:prompts`;
const dirsKey = (workspace: string | null, sessionId: string) => `${aiSessionStorageKey(workspace)}:dirs:${sessionId}`;

/** 草稿最多存这么多字符。整段日志粘进来时，超出的尾巴不留到下次重启。 */
const MAX_DRAFT = 20_000;
/** 每个工程记住最近这么多条已发送正文。 */
const MAX_HISTORY = 50;
/** 单条历史最多这么多字符：再长的是粘贴的物料，不是想复述的话。 */
const MAX_HISTORY_ITEM = 2_000;

export function loadDraft(workspace: string | null, sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(workspace, sessionId)) ?? "";
  } catch {
    // 读不到就当没有：草稿是可丢的缓存，不该因为存储坏了拦住聊天面板挂载。
    return "";
  }
}

/** 空草稿直接删键，免得每打空一个字都留一条值为 "" 的记录。 */
export function saveDraft(workspace: string | null, sessionId: string, text: string): void {
  const key = draftKey(workspace, sessionId);
  try {
    if (!text) localStorage.removeItem(key);
    else localStorage.setItem(key, text.slice(0, MAX_DRAFT));
  } catch {
    // 写失败只丢一次跨重启恢复，内存里的草稿照样能发出去，不值得弹错误。
  }
}

export function loadPromptHistory(workspace: string | null): string[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(historyKey(workspace)) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

/**
 * 记一条发出去的正文。斜杠命令不进历史：它当场就执行完了，↑ 召回一条 `/compact`
 * 只是让人再发一次已经跑过的指令。连续发同一条也只留一份。
 */
export function rememberPrompt(workspace: string | null, text: string): void {
  const value = text.trim();
  if (!value || value.startsWith("/")) return;
  const history = loadPromptHistory(workspace);
  const next = history[0] === value ? history : [value.slice(0, MAX_HISTORY_ITEM), ...history].slice(0, MAX_HISTORY);
  if (next === history) return;
  try {
    localStorage.setItem(historyKey(workspace), JSON.stringify(next));
  } catch {
    // 同上：召回历史丢了，最坏是 ↑ 没反应，不影响发送。
  }
}

export function clearDraft(workspace: string | null, sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(workspace, sessionId));
  } catch {
    // 删不掉无所谓：键已经不属于任何会话。
  }
}

/** 删除会话时清掉所有按会话隔离的本地状态；工程级发送历史和引擎默认项继续保留。 */
export function clearAiSessionStorage(workspace: string | null, sessionId: string): void {
  const prefix = aiSessionStorageKey(workspace);
  try {
    localStorage.removeItem(draftKey(workspace, sessionId));
    localStorage.removeItem(dirsKey(workspace, sessionId));
    localStorage.removeItem(`${prefix}:options:${sessionId}`);
  } catch {
    // 会话已经从列表删除；缓存清理失败不能阻止主状态迁移。
  }
}

/** 本会话已授权的额外目录。跨重启保留，但只影响这个会话的启动参数。 */
export function loadAdditionalDirs(workspace: string | null, sessionId: string): string[] {
  try {
    const items: unknown = JSON.parse(localStorage.getItem(dirsKey(workspace, sessionId)) ?? "[]");
    return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 16) : [];
  } catch { return []; }
}
export function saveAdditionalDirs(workspace: string | null, sessionId: string, dirs: string[]): void {
  try {
    if (!dirs.length) localStorage.removeItem(dirsKey(workspace, sessionId));
    else localStorage.setItem(dirsKey(workspace, sessionId), JSON.stringify(dirs.slice(0, 16)));
  } catch {
    // 存不下只影响下次启动；本轮发送仍带着内存里的列表。
  }
}

/** ↑↓ 在历史里的位置。`stash` 是离开历史时要还回去的那行——用户中途改的字也存在这里。 */
export type PromptBrowse = { index: number; stash: string };
export type DraftState = { text: string; browse: PromptBrowse | null };

/** 往上（更早）走一格；已经到最老一条就停在原地。 */
export function browseUp(history: readonly string[], draft: DraftState): DraftState {
  if (!history.length) return draft;
  const stash = draft.browse?.stash ?? draft.text;
  const index = Math.min((draft.browse?.index ?? -1) + 1, history.length - 1);
  return { text: history[index], browse: { index, stash } };
}

/** 往下（更新）走一格；越过最新一条就回到 `stash`。 */
export function browseDown(history: readonly string[], draft: DraftState): DraftState {
  if (!draft.browse) return draft;
  if (draft.browse.index > 0) {
    const index = draft.browse.index - 1;
    return { text: history[index] ?? draft.browse.stash, browse: { index, stash: draft.browse.stash } };
  }
  return { text: draft.browse.stash, browse: null };
}

/** 按 Esc 取消召回，回到 ↑ 之前（或用户改过）的那行。 */
export function browseCancel(draft: DraftState): DraftState {
  return draft.browse ? { text: draft.browse.stash, browse: null } : draft;
}

/**
 * 用户在被召回的那行上改了字。
 *
 * 位置留住，所以接着按 ↑ 是从原来那条继续往更早走；改动写进 `stash`，
 * 这样按 ↓ 走出历史时还回得到自己打的字，而不是召回前的原文。
 */
export function browseTyped(text: string, draft: DraftState): DraftState {
  return draft.browse ? { text, browse: { index: draft.browse.index, stash: text } } : { text, browse: null };
}

/** 光标在第几行决定 ↑↓ 归谁：多行文本里它们本来该移动光标。 */
export function caretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, Math.min(Math.max(caret, 0), text.length)).includes("\n");
}
export function caretOnLastLine(text: string, caret: number): boolean {
  return !text.slice(Math.min(Math.max(caret, 0), text.length)).includes("\n");
}
