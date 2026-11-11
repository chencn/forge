import type { AiProvider } from "./aiCli";
import { aiSessionStorageKey } from "./aiSessions";
import { loadAiDefaultOptions, loadAiOptions, saveAiOptions } from "./aiOptions";
import { loadAdditionalDirs, saveAdditionalDirs } from "./aiDrafts";

/**
 * 「新建会话」草稿页的前后端桥。
 *
 * 流程：点「新建会话」只开一个草稿标签，第一条消息发出时才真正创建会话。
 * 草稿页把选中的工具与首条消息（含附件沙箱路径）交给上层，
 * 上层创建会话、切换标签，再把这份载荷通过 `setAiDraftHandoff` 交给挂载后的会话页自动发出。
 */

/** 等待会话页接手的首条消息。附件已经是后端沙箱里的路径，可直接随消息发送。 */
export interface AiDraftHandoff {
  text: string;
  images: string[];
}

/** 各会话待移交的首条消息，键为会话 id。 */
const handoffs = new Map<string, AiDraftHandoff>();

/**
 * 定位工作区内某引擎的草稿选项，避免不同草稿互相覆盖。
 * @param provider - 草稿所属引擎
 * @param root - 草稿工作区；null 表示未打开工作区
 * @returns 草稿的独立存储键
 */
export function aiDraftOptionsKey(provider: AiProvider, root: string | null) {
  return `${aiSessionStorageKey(root)}:draft-options:${provider}`;
}

/**
 * 新开草稿时快照两个引擎的最新默认值；已打开草稿不得重复初始化。
 * @param root - 新草稿的工作区
 * @returns void；只写草稿快照，不改新会话默认值
 */
export function initializeAiDraftOptions(root: string | null): void {
  for (const provider of ["claude", "codex"] as const) {
    localStorage.setItem(aiDraftOptionsKey(provider, root), JSON.stringify(loadAiDefaultOptions(provider)));
  }
}

/** 登记待移交载荷；会话页挂载后由 {@link takeAiDraftHandoff} 取走。 */
export function setAiDraftHandoff(sessionId: string, payload: AiDraftHandoff) {
  handoffs.set(sessionId, payload);
}

/** 取走即清：会话页挂载时读一次，读不到的会话绝不自动发送。 */
export function takeAiDraftHandoff(sessionId: string): AiDraftHandoff | null {
  const payload = handoffs.get(sessionId) ?? null;
  handoffs.delete(sessionId);
  return payload;
}

/** 草稿页选中的工具按工作区记忆：下次新建会话直接落在同一个工具上。 */
export function loadAiDraftProvider(root: string | null): AiProvider | null {
  try {
    const value = localStorage.getItem(`${aiSessionStorageKey(root)}:draft-provider`);
    return value === "claude" || value === "codex" ? value : null;
  } catch {
    return null;
  }
}

/** 记住草稿页选中的工具；写失败只影响下次默认选中。 */
export function saveAiDraftProvider(root: string | null, provider: AiProvider) {
  try { localStorage.setItem(`${aiSessionStorageKey(root)}:draft-provider`, provider); } catch { /* 记不住只影响下次默认选中 */ }
}

/** 草稿页配置的模型/强度/权限跟着会话走：创建时原样种到新会话的选项键下。 */
export function seedAiSessionOptions(root: string | null, sessionId: string, provider: AiProvider) {
  /** 首条消息沿用草稿冻结的配置，不重新读取新会话默认值。 */
  const draft = loadAiOptions(aiDraftOptionsKey(provider, root), provider);
  saveAiOptions(`${aiSessionStorageKey(root)}:options:${sessionId}`, provider, draft);
  // 长元素上下文会转为临时附件；首条消息必须继承草稿的附件目录授权。
  saveAdditionalDirs(root, sessionId, loadAdditionalDirs(root, "draft"));
}
