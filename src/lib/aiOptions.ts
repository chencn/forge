import type { AiProvider } from "./aiCli";
import type { AiCapabilities, AiRunOptions } from "./aiRuntime";

/** 显示名/目录项 ID 只用于查找；持久化与调用始终返回目录里的模型参数。 */
export function resolveAiModel(catalog: AiCapabilities | null, input: string | undefined): string | undefined {
  if (!input) return undefined;
  const value = input.trim();
  if (!catalog) return value;
  const exact = catalog.models.find((item) => item.id === value);
  if (exact) return exact.id;
  const matches = catalog.models.filter((item) => [item.id, item.name, item.catalogId].some((name) => name?.toLowerCase() === value.toLowerCase()));
  const ids = [...new Set(matches.map((item) => item.id))];
  // 多个模型重名时不能猜；未知自定义 ID 保留原样，不能臆造服务端大小写规则。
  return ids.length === 1 ? ids[0] : value;
}

const defaultsKey = (provider: AiProvider) => `forge:ai:defaults:v1:${provider}`;
const PERMISSIONS = ["read", "ask", "auto", "full"] as const;
/** 模式 id 会原样交给 CLI：先在本地过形状白名单，真正的取值把关在后端对着这版 CLI 的清单上做。 */
const MODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** 每个引擎的「照常干活」档：记住的模式被 CLI 撤掉时回落到它，而不是回落到别的权限。 */
export const aiNormalMode = (provider: AiProvider) => provider === "codex" ? "default" : "manual";
/** 权限四档和会话模式都记住：用户明确选过完全访问或计划模式，就要在会话和新会话里继续用它。 */
export function readAiOptions(key: string): AiRunOptions {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    const permission = typeof value?.permission === "string" && (PERMISSIONS as readonly string[]).includes(value.permission)
      ? value.permission as AiRunOptions["permission"]
      : undefined;
    // 旧版本把计划模式存成布尔；它现在只是模式列表里的一项。
    const mode = typeof value?.mode === "string" && MODE_ID.test(value.mode) ? value.mode
      : value?.planMode === true ? "plan" : undefined;
    return {
      model: typeof value?.model === "string" ? value.model.slice(0, 200) : undefined,
      effort: typeof value?.effort === "string" ? value.effort : undefined,
      fast: typeof value?.fast === "boolean" ? value.fast : undefined,
      permission,
      mode,
    };
  } catch { return {}; }
}
export function loadAiOptions(key: string, provider: AiProvider): AiRunOptions {
  let value: AiRunOptions;
  let own = false;
  try {
    own = localStorage.getItem(key) !== null;
    value = own ? readAiOptions(key) : readAiOptions(defaultsKey(provider));
  } catch { return {}; }
  // 旧版本把完全访问写成了「无权限」，会话键里缺值时回落到该引擎上次的普通模式。
  if (own && value.permission === undefined) {
    const fallback = readAiOptions(defaultsKey(provider)).permission;
    if (fallback) value = { ...value, permission: fallback };
  }
  // 同理，升级前存下的会话没有 mode：沿用上次的模式，新会话首屏也按这份记忆选中。
  if (own && value.mode === undefined) {
    const fallback = readAiOptions(defaultsKey(provider)).mode;
    if (fallback) value = { ...value, mode: fallback };
  }
  return value;
}
export function saveAiOptions(key: string, provider: AiProvider, value: AiRunOptions): void {
  // 选择记在 Forge 自己的存储里（当前会话一份 + 按引擎的全局默认一份），
  // 不写 CLI 的原生配置：记住上次选择不等于替用户改 config。
  const saved = JSON.stringify({ model: value.model, effort: value.effort, fast: value.fast, permission: value.permission, mode: value.mode });
  localStorage.setItem(key, saved);
  localStorage.setItem(defaultsKey(provider), saved);
}
