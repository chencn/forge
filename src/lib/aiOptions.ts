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

/** 按引擎的全局默认档在 localStorage 的键。 */
const defaultsKey = (provider: AiProvider) => `forge:ai:defaults:v1:${provider}`;
/** 权限档的白名单（读回时按它把关）。 */
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
      providerId: typeof value?.providerId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.providerId) ? value.providerId : undefined,
      model: typeof value?.model === "string" ? value.model.slice(0, 200) : undefined,
      effort: typeof value?.effort === "string" ? value.effort : undefined,
      fast: typeof value?.fast === "boolean" ? value.fast : undefined,
      permission,
      mode,
    };
  } catch { return {}; }
}
/**
 * 读取已有会话自己的选项；缺省字段沿用 CLI，不读取其他会话更新的默认值。
 * @param key - 会话或草稿的独立存储键
 * @param _provider - 会话所属引擎；只读独立键，不再用它补默认值
 * @returns 已保存选项；没有记录时为空对象
 */
export function loadAiOptions(key: string, _provider: AiProvider): AiRunOptions {
  return readAiOptions(key);
}
/**
 * 读取未来新会话的初始选项；调用方须在创建草稿时复制为独立快照。
 * @param provider - 新会话所属引擎
 * @returns 该引擎最后一次选择；未选择过时为空对象
 */
export function loadAiDefaultOptions(provider: AiProvider): AiRunOptions {
  return readAiOptions(defaultsKey(provider));
}
/** 保存运行选项：当前会话键一份 + 按引擎的全局默认一份（不写 CLI 原生配置）。 */
export function saveAiOptions(key: string, provider: AiProvider, value: AiRunOptions): void {
  // 选择记在 Forge 自己的存储里（当前会话一份 + 按引擎的全局默认一份），
  // 不写 CLI 的原生配置：记住上次选择不等于替用户改 config。
  /** 当前会话和未来新会话共享这次选择的值，不共享后续可变状态。 */
  const saved = JSON.stringify({ providerId: value.providerId, model: value.model, effort: value.effort, fast: value.fast, permission: value.permission, mode: value.mode });
  localStorage.setItem(key, saved);
  localStorage.setItem(defaultsKey(provider), saved);
}
