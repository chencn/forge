import type { AiModelOption } from "./aiRuntime";

/**
 * 请求的模型与实际服务的模型怎么对上。
 *
 * CLI 会改写选择器：Claude 的别名按配置落到带日期的快照，Codex 用 `[1m]` 尾巴表示
 * 长上下文档。用户看到的两个字符串常常不同但其实同一模型，直接摆两个原始 id 让人自己
 * 比对，等于把归一化甩给了眼睛。这里收敛成四种判定。
 */
export type ModelVerdict = "match" | "variant" | "mismatch" | "unknown";

/** 档位标记（`[1m]`、`[200k]` 之类）改的是上下文窗口，不是模型本身。 */
const CONTEXT_MARKER = /\[[^\]]*\]$/;

export function hasContextMarker(id: string): boolean {
  return CONTEXT_MARKER.test(id.trim());
}

export function stripContextMarker(id: string): string {
  return id.replace(CONTEXT_MARKER, "").trim();
}

/** 快照尾巴：`@latest`、`-20250929`、`-2025-09-29`、`-latest`、`-preview`。 */
const SNAPSHOT = /(?:@latest|-(?:\d{4}-\d{2}-\d{2}|\d{8}|latest|preview))$/i;

/** 去掉快照标记，留下「哪一代模型」；只削最后一个标记，不再往里猜。 */
export function stripSnapshot(id: string): string {
  return id.replace(SNAPSHOT, "");
}

/** 同一代模型的名：档位标记与快照尾巴都不参与判定。 */
export function modelGeneration(id: string): string {
  return stripSnapshot(stripContextMarker(id)).trim().toLowerCase();
}

/** 目录里的别名到配置目标，用来把 `sonnet` 这类选择器接到真实快照 id 上。 */
export function modelAliases(models: AiModelOption[] | undefined): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const model of models ?? []) {
    if (model.configuredModel && model.configuredModel !== model.id) aliases[model.id.toLowerCase()] = model.configuredModel.toLowerCase();
  }
  return aliases;
}

/** 别名可能再指向别名（default → sonnet → 快照 id），走有限几跳，不跟环。 */
function followAlias(selector: string, aliases: Record<string, string>): string {
  let current = selector;
  for (let hop = 0; hop < 3; hop += 1) {
    const next = aliases[current] ?? aliases[stripContextMarker(current).toLowerCase()];
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * 比较请求值与服务回报值。
 *
 * 任一侧为空即 `unknown`：没选模型时沿用 CLI 默认，而默认是什么我们并不知道，不能把它
 * 说成「一致」。同一代之内部位标记丢了也算 `variant`——那正是要提醒的偏差；换了别的模型
 * 才是 `mismatch`。
 */
export function compareModels(requested: string | null | undefined, served: string | null | undefined, aliases: Record<string, string> = {}): ModelVerdict {
  const want = requested?.trim().toLowerCase();
  const got = served?.trim().toLowerCase();
  if (!want || !got) return "unknown";
  const resolved = followAlias(want, aliases);
  if (modelGeneration(resolved) !== modelGeneration(got)) return "mismatch";
  if ((want === got || resolved === got) && hasContextMarker(want) === hasContextMarker(got)) return "match";
  return "variant";
}
