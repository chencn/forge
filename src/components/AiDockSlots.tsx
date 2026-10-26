import { createContext, useContext } from "react";

/**
 * 右侧侧边栏给 AI 会话的子代理列表留的挂载点。代理状态活在
 * AiSessionPane 里，不宜上提，所以侧栏只提供空槽，由会话面板
 * 把列表 portal 进来；槽不存在时列表不渲染。
 */
export interface AiDockSlots {
  /** 子代理列表区块的挂载点。 */
  agents: HTMLElement | null;
}

export const AiDockSlotContext = createContext<AiDockSlots>({ agents: null });

export function useAiDockSlots(): AiDockSlots {
  return useContext(AiDockSlotContext);
}
