import { invoke } from "@tauri-apps/api/core";
import { SendHorizontal } from "lucide-react";
import type { AiProvider } from "./aiCli";
import type { TranslationKey } from "../i18n/lang/zh";
import type { MenuItem } from "../components/ContextMenu";
import { loadAdditionalDirs, loadDraft, loadDraftImages, saveAdditionalDirs, saveDraft, updateDraftImages } from "./aiDrafts";
import { aiSessionStorageKey } from "./aiSessions";

export interface AiInputTarget {
  id: string;
  title: string;
}

export interface AiOngoingTargetCandidate {
  id: string;
  title: string;
  provider: AiProvider;
  parentSessionId?: string;
}

/**
 * 校验跨会话投递会话 ID 的合法性。
 * 铁律约束：仅同 Provider 互通（Claude -> Claude，Codex -> Codex），异构直接拒绝。
 */
export function validateAiSessionIdDelivery(
  sourceProvider: AiProvider,
  targetProvider: AiProvider,
): { allowed: boolean; reason?: TranslationKey } {
  if (sourceProvider !== targetProvider) {
    return { allowed: false, reason: "ai.sendSessionId.codexToClaudeBlocked" };
  }
  return { allowed: true };
}

/**
 * 筛选出可以接收会话 ID 的「正在进行的会话」列表（对齐发送到输入框逻辑）：
 * 1. 仅限已在标签栏打开（openIds）或运行中的会话；
 * 2. 排除源会话自身以及子代理；
 * 3. 严格同 Provider 过滤，非自身所属 Provider 彻底屏蔽。
 */
export function getOngoingAiSessionTargets<T extends AiOngoingTargetCandidate>(
  sessions: readonly T[],
  openIds: readonly string[],
  sourceSession: { id: string; provider?: AiProvider } | string,
  isRunning?: (id: string) => boolean,
  sourceProvider?: AiProvider,
): T[] {
  const sourceId = typeof sourceSession === "string" ? sourceSession : sourceSession.id;
  const provider = typeof sourceSession === "string" ? sourceProvider : sourceSession.provider;
  return sessions.filter((s) =>
    s.id !== sourceId &&
    !s.parentSessionId &&
    (!provider || s.provider === provider) &&
    (openIds.includes(s.id) || (isRunning ? isRunning(s.id) : false))
  );
}

/**
 * 将源会话的 ID 快捷发送到目标会话的输入草稿中，并激活/聚焦目标标签。
 * 校验失败（如 codex -> claude）时直接拒绝。
 */
export async function deliverAiSessionId(
  workspace: string | null,
  source: { id: string; provider: AiProvider },
  target: { id: string; title: string; provider: AiProvider },
  onOpen?: (id: string) => void,
): Promise<void> {
  const check = validateAiSessionIdDelivery(source.provider, target.provider);
  if (!check.allowed) {
    throw new Error(check.reason ?? "Codex 会话不能发送给 Claude 会话");
  }
  await deliverAiInput(workspace, { id: target.id, title: target.title }, { kind: "text", text: source.id });
  onOpen?.(target.id);
}

export interface BuildSendSessionIdMenuOptions<T extends AiOngoingTargetCandidate> {
  sourceSession: T;
  sessions: readonly T[];
  openIds: readonly string[];
  activeId?: string | null;
  workspace: string | null;
  onOpen?: (id: string) => void;
  isRunning?: (id: string) => boolean;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

/**
 * 构建「发送会话 ID 给正在进行的会话」的菜单项。
 * 集中封装目标选择、同 Provider 屏蔽与单目标/多目标菜单形态。
 * 若没有可用候选会话，返回 null（彻底不在菜单中展示，严禁出现灰色无用项）。
 */
export function buildSendSessionIdMenuItem<T extends AiOngoingTargetCandidate>({
  sourceSession,
  sessions,
  openIds,
  activeId,
  workspace,
  onOpen,
  isRunning,
  t,
}: BuildSendSessionIdMenuOptions<T>): MenuItem | null {
  const candidates = getOngoingAiSessionTargets(sessions, openIds, sourceSession, isRunning);

  // 无可用同 Provider 进行中会话时彻底隐藏，不生成无用的灰色菜单项
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    const target = candidates[0];
    const targetTitle = target.title || t("ai.untitledSession");
    return {
      icon: SendHorizontal,
      label: `${t("ai.sendSessionIdToOngoing")} (${targetTitle})`,
      onSelect: () => void deliverAiSessionId(workspace, sourceSession, target, onOpen),
    };
  }
  // 多个目标时展示子菜单；若有当前激活的标签排在首位
  const sorted = [...candidates].sort((a, b) => {
    const aActive = activeId === `ai|${a.id}` ? 2 : (openIds.includes(a.id) || (isRunning?.(a.id) ?? false)) ? 1 : 0;
    const bActive = activeId === `ai|${b.id}` ? 2 : (openIds.includes(b.id) || (isRunning?.(b.id) ?? false)) ? 1 : 0;
    return bActive - aActive;
  });
  const counts = new Map<string, number>();
  for (const item of sorted) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);

  return {
    icon: SendHorizontal,
    label: t("ai.sendSessionIdToOngoing"),
    children: sorted.map((target) => {
      const isCurrent = activeId === `ai|${target.id}`;
      const baseTitle = target.title || t("ai.untitledSession");
      const titleWithId = counts.get(target.title) === 1 ? baseTitle : `${baseTitle} · ${target.id.slice(0, 8)}`;
      const label = isCurrent ? t("ai.sendSessionId.current", { title: titleWithId }) : titleWithId;
      return {
        label,
        onSelect: () => void deliverAiSessionId(workspace, sourceSession, target, onOpen),
      };
    }),
  };
}

export type AiInputPayload =
  | { kind: "text"; text: string; source?: string }
  | { kind: "image"; dataUrl: string; name: string; text?: string }
  | { kind: "file"; path: string; startLine: number; endLine?: number };

export interface AiInputDelivery {
  workspaceKey: string;
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

async function prepareAiInput(payload: Exclude<AiInputPayload, { kind: "image" }>, inlineLimit = INLINE_AI_TEXT_LIMIT): Promise<{ text: string; additionalDir?: string }> {
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
  // 元素截图和问题先准备完再交付；附件失败不能先追加半份问题。
  const textPayload = payload.kind === "image" ? payload.text ? { kind: "text" as const, text: payload.text } : null : payload;
  const prepared = textPayload
    ? await prepareAiInput(textPayload, Math.max(0, Math.min(INLINE_AI_TEXT_LIMIT, 16_000 - current.length - 2)))
    : { text: "", additionalDir: undefined };
  if (payload.kind === "image") {
    const { maxImages } = await invoke<{ maxImages: number }>("ai_runtime_image_limits");
    const checkLimit = (count: number) => {
      if (count >= maxImages) throw new Error(`每条消息最多添加 ${maxImages} 张图片`);
    };
    checkLimit(loadDraftImages(workspace, target.id).length);
    const saved = await invoke<{ path: string }>("ai_runtime_save_pasted_image", { dataUrl: payload.dataUrl });
    try {
      // 保存期间仍可能收到粘贴或其他截图，必须合并最新附件并再次检查上限。
      updateDraftImages(workspace, target.id, (images) => {
        checkLimit(images.length);
        return [...images, { path: saved.path, name: payload.name }];
      });
    } catch (cause) {
      void invoke("ai_runtime_delete_image", { path: saved.path }).catch(() => {});
      throw cause;
    }
  }
  // 落盘或统计行数期间输入框仍能编辑，异步结果必须追加到最新草稿。
  const text = appendAiInputText(loadDraft(workspace, target.id), prepared.text);
  saveDraft(workspace, target.id, text);
  if (prepared.additionalDir) {
    const dirs = loadAdditionalDirs(workspace, target.id);
    if (!dirs.includes(prepared.additionalDir)) {
      // 临时附件目录必须进入后端最多 16 项的授权表；已满时淘汰最旧尾项。
      saveAdditionalDirs(workspace, target.id, [prepared.additionalDir, ...dirs].slice(0, 16));
    }
  }
  const workspaceKey = aiSessionStorageKey(workspace);
  const delivery = { workspaceKey, sessionId: target.id, text, additionalDir: prepared.additionalDir };
  // 目标标签刚被激活时组件可能还没挂载；保留一次待消费投递，避免焦点事件丢在 React 提交之前。
  pendingDeliveries.set(`${workspaceKey}:${target.id}`, delivery);
  window.dispatchEvent(new CustomEvent<AiInputDelivery>(DELIVERY_EVENT, { detail: delivery }));
}

export function watchAiInputDelivery(workspace: string | null, sessionId: string, listener: (delivery: AiInputDelivery) => void): () => void {
  // 新对话统一叫 draft；事件与待消费缓存必须同时按工作区隔离。
  const workspaceKey = aiSessionStorageKey(workspace);
  const key = `${workspaceKey}:${sessionId}`;
  let active = true;
  const receive = (event: Event) => {
    const delivery = (event as CustomEvent<AiInputDelivery>).detail;
    if (delivery?.sessionId === sessionId && delivery.workspaceKey === workspaceKey) {
      pendingDeliveries.delete(key);
      listener(delivery);
    }
  };
  window.addEventListener(DELIVERY_EVENT, receive);
  const pending = pendingDeliveries.get(key);
  if (pending) {
    // React 快速卸载或同帧又有新投递时，旧回放不能覆盖新草稿。
    queueMicrotask(() => {
      if (!active || pendingDeliveries.get(key) !== pending) return;
      pendingDeliveries.delete(key);
      listener(pending);
    });
  }
  return () => { active = false; window.removeEventListener(DELIVERY_EVENT, receive); };
}
