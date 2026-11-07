import { createContext, useContext, type ReactNode } from "react";
import type { MenuItem } from "./ContextMenu";
import type { AiInputPayload } from "../lib/aiInputBridge";

/** 各选区只描述要投递的内容；目标会话与二级菜单统一由 App 决定。 */
export type AiInputMenuFactory = (payload: AiInputPayload) => MenuItem;

/** 「发送到 AI」菜单工厂的 Context；没挂 Provider 时给一个禁用的缺省项。 */
const AiInputContext = createContext<AiInputMenuFactory>(() => ({
  label: "发送到 AI",
  disabled: true,
}));

/** 挂上菜单工厂。 */
export function AiInputProvider({ value, children }: { value: AiInputMenuFactory; children: ReactNode }) {
  return <AiInputContext.Provider value={value}>{children}</AiInputContext.Provider>;
}

/** 取「发送到 AI」菜单工厂。 */
export function useAiInputMenu(): AiInputMenuFactory {
  return useContext(AiInputContext);
}
