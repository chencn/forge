import { invoke } from "@tauri-apps/api/core";
import { loadAdditionalDirs, loadDraft, saveAdditionalDirs, saveDraft } from "./aiDrafts";

export interface AiInputTarget {
  id: string;
  title: string;
}

export type AiInputPayload =
  | { kind: "text"; text: string; source?: string }
  | { kind: "file"; path: string; startLine: number; endLine?: number };

export interface AiInputDelivery {
  sessionId: string;
  text: string;
  additionalDir?: string;
}

export type AiTargetRoute =
  | { kind: "disabled" }
  | { kind: "direct"; target: AiInputTarget }
  | { kind: "choose"; targets: AiInputTarget[] };

interface SavedTextAttachment {
  path: string;
  directory: string;
}

const DELIVERY_EVENT = "forge:ai-input-delivery";
const pendingDeliveries = new Map<string, AiInputDelivery>();
/** 普通文本再长就不塞进草稿/localStorage；文件引用始终只传路径与行号。 */
export const INLINE_AI_TEXT_LIMIT = 12_000;

export function routeAiTargets(targets: readonly AiInputTarget[]): AiTargetRoute {
  if (targets.length === 0) return { kind: "disabled" };
  if (targets.length === 1) return { kind: "direct", target: targets[0] };
  return { kind: "choose", targets: [...targets] };
}

export function formatAiFileReference(path: string, startLine: number, endLine: number): string {
  const start = Math.max(1, Math.trunc(startLine));
  const end = Math.max(start, Math.trunc(endLine));
  return `${path}\n第 ${start} 行到第 ${end} 行`;
}

export function appendAiInputText(current: string, incoming: string): string {
  if (!incoming.trim()) return current;
  return current ? `${current}${current.endsWith("\n") ? "\n" : "\n\n"}${incoming}` : incoming;
}

async function prepareAiInput(payload: AiInputPayload, inlineLimit = INLINE_AI_TEXT_LIMIT): Promise<{ text: string; additionalDir?: string }> {
  if (payload.kind === "file") {
    const endLine = payload.endLine ?? await invoke<number>("ai_runtime_file_line_count", { path: payload.path });
    return { text: formatAiFileReference(payload.path, payload.startLine, endLine) };
  }
  const text = payload.text;
  if (text.length <= inlineLimit) {
    return { text: payload.source ? `${payload.source}\n${text}` : text };
  }
  const saved = await invoke<SavedTextAttachment>("ai_runtime_save_text_attachment", { text });
  const source = payload.source ? `${payload.source}\n` : "";
  return {
    text: `${source}内容较长，已保存到临时附件：${saved.path}\n请读取该文件。`,
    additionalDir: saved.directory,
  };
}

/**
 * 只向已经打开的目标会话写草稿。目标选择由调用方完成；本模块绝不创建或激活标签。
 * 当前挂载的输入框通过事件立即同步并聚焦，未挂载的标签下次打开时从草稿存储恢复。
 */
export async function deliverAiInput(
  workspace: string | null,
  target: AiInputTarget,
  payload: AiInputPayload,
): Promise<void> {
  const current = loadDraft(workspace, target.id);
  // 输入框上限是 16000；已有草稿占掉的空间也要算进去，不能追加后再被浏览器截断。
  const prepared = await prepareAiInput(payload, Math.max(0, Math.min(INLINE_AI_TEXT_LIMIT, 16_000 - current.length - 2)));
  const text = appendAiInputText(current, prepared.text);
  saveDraft(workspace, target.id, text);
  if (prepared.additionalDir) {
    const dirs = loadAdditionalDirs(workspace, target.id);
    if (!dirs.includes(prepared.additionalDir)) {
      // 临时附件目录必须进入后端最多 16 项的授权表；已满时淘汰最旧尾项。
      saveAdditionalDirs(workspace, target.id, [prepared.additionalDir, ...dirs].slice(0, 16));
    }
  }
  const delivery = { sessionId: target.id, text, additionalDir: prepared.additionalDir };
  // 目标标签刚被激活时组件可能还没挂载；保留一次待消费投递，避免焦点事件丢在 React 提交之前。
  pendingDeliveries.set(target.id, delivery);
  window.dispatchEvent(new CustomEvent<AiInputDelivery>(DELIVERY_EVENT, { detail: delivery }));
}

export function watchAiInputDelivery(sessionId: string, listener: (delivery: AiInputDelivery) => void): () => void {
  const receive = (event: Event) => {
    const delivery = (event as CustomEvent<AiInputDelivery>).detail;
    if (delivery?.sessionId === sessionId) {
      pendingDeliveries.delete(sessionId);
      listener(delivery);
    }
  };
  window.addEventListener(DELIVERY_EVENT, receive);
  const pending = pendingDeliveries.get(sessionId);
  if (pending) {
    pendingDeliveries.delete(sessionId);
    queueMicrotask(() => listener(pending));
  }
  return () => window.removeEventListener(DELIVERY_EVENT, receive);
}
