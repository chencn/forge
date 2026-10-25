import type { AiProvider } from "./aiCli";
import { aiSessionStorageKey } from "./aiSessions";
import { loadAiOptions, saveAiOptions } from "./aiOptions";

/**
 * 「新建会话」草稿页的前后端桥。
 *
 * 参考实现的流程是：点「新建会话」只开一个草稿标签，第一条消息发出时才真正创建会话。
 * forge 沿用这一流程：草稿页把选中的工具与首条消息（含附件沙箱路径）交给上层，
 * 上层创建会话、切换标签，再把这份载荷通过 `setAiDraftHandoff` 交给挂载后的会话页自动发出。
 */

/** 等待会话页接手的首条消息。附件已经是后端沙箱里的路径，可直接随消息发送。 */
export interface AiDraftHandoff {
  text: string;
  images: string[];
}

const handoffs = new Map<string, AiDraftHandoff>();

/** 草稿页没有会话 id，只按引擎保存；创建会话时必须从同一个键复制，不能回退到其他会话改写的全局默认。 */
export function aiDraftOptionsKey(provider: AiProvider) {
  return `forge:ai-draft-options:v1:${provider}`;
}

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

export function saveAiDraftProvider(root: string | null, provider: AiProvider) {
  try { localStorage.setItem(`${aiSessionStorageKey(root)}:draft-provider`, provider); } catch { /* 记不住只影响下次默认选中 */ }
}

/** 草稿页配置的模型/强度/权限跟着会话走：创建时原样种到新会话的选项键下。 */
export function seedAiSessionOptions(root: string | null, sessionId: string, provider: AiProvider) {
  const draft = loadAiOptions(aiDraftOptionsKey(provider), provider);
  saveAiOptions(`${aiSessionStorageKey(root)}:options:${sessionId}`, provider, draft);
}
