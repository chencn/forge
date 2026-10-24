/**
 * 授权卡片的可选动作。
 *
 * 这里只做「界面上能提出什么」的判断，真正能不能兑现由后端各协议自己把关：
 * Codex 收到 input 会直接拒收，Claude 只接受原入参里已有的键。前端把按钮画全
 * 而后端兑不了，比少画一个按钮更糟。
 */

/** 一条授权答复的形状；拒绝就是拒绝，不附带任何修改或记住。 */
export type AiPermissionAnswer =
  | { allow: false }
  | { allow: true; input?: Record<string, unknown>; remember?: { tool: string; root?: string } };

/** 一张卡片最终收到的答复：授权是允许/拒绝，提问是每题选了什么。 */
export type AiRequestAnswer = AiPermissionAnswer | { answers: Record<string, string[]> };

/**
 * 把后端带回来的提问答案拆回界面用的两份：值命中某个选项的算「选中」，没命中的是当时
 * 在「其他」里手打的那句。重开会话、或者另一个窗口答的，都靠它把选过的结果原样显示出来，
 * 而不是把一张已经结束的卡片摆成空白。
 */
export function seedQuestionAnswers(questions: { id: string; options?: { label: string }[] }[], answer?: AiRequestAnswer) {
  const answers: Record<string, string[]> = {};
  const other: Record<string, string> = {};
  if (!answer || !("answers" in answer)) return { answers, other };
  for (const question of questions) {
    const chosen = (answer.answers[question.id] ?? []).filter((value) => typeof value === "string");
    const labels = new Set((question.options ?? []).map((option) => option.label));
    const picked = chosen.filter((value) => labels.has(value));
    const typed = chosen.filter((value) => !labels.has(value));
    if (picked.length) answers[question.id] = picked;
    if (typed.length) other[question.id] = typed.join("、");
  }
  return { answers, other };
}

/** 与 Rust 侧 `request_target` 同一批键；顺序也一致，两边必须挑到同一个路径。 */
const PATH_KEYS = ["file_path", "notebook_path", "path", "absolute_path", "target_file"] as const;

/** 入参里要动的那个文件；命令类入参（command/cwd）不在其中，目录规则永远不覆盖它。 */
export function requestPath(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * 目标文件所在的绝对目录；拿不到就返回 null，界面于是只给「允许一次 / 拒绝」。
 *
 * 相对路径不给：没有基准目录就无从判定「在不在里面」，后端也会拒。
 */
export function parentDirectory(path: string | null): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  // 带 `..` 的入参连位置都说不准，后端也不会替它担保。
  if (!trimmed || trimmed.includes("..")) return null;
  if (!/^([A-Za-z]:[\\/])|^[\\/]/.test(trimmed)) return null;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut <= 0) return null;
  let parent = trimmed.slice(0, cut);
  while (parent.length > 1 && /[\\/]$/.test(parent)) parent = parent.slice(0, -1);
  // 「整个盘 / 整个根 / 只有服务器名」都不算一个目录授权：那等于把工具对本机全放行。
  if (!parent || /^[A-Za-z]:$/i.test(parent) || parent === "/" || /^[\\/]{2}[^\\/]+$/.test(parent)) return null;
  return parent;
}

/** 这张卡片能提出哪些动作。 */
export interface PermissionOffer {
  /** 授权的工具名；认不出来时不能记规则，只能一次一答。 */
  tool: string | null;
  /** 目标文件所在目录；有它才出现「这个目录里都允许」。 */
  root: string | null;
  /** 后端声明这条答复有「改过的入参」位置。 */
  canEdit: boolean;
}

export function permissionOffer(request: { toolName?: string; input?: unknown; canEdit?: boolean }): PermissionOffer {
  const tool = typeof request.toolName === "string" && request.toolName.trim() ? request.toolName.trim() : null;
  return { tool, root: parentDirectory(requestPath(request.input)), canEdit: request.canEdit === true };
}

/** 「改完再允许」的入参上限，与后端 MAX_EDITED_INPUT 同值。 */
const MAX_EDITED_INPUT = 64 * 1024;

/** 校验失败的原因；都是能直接交给 i18n 的键。 */
export type EditedInputError =
  | "ai.runtime.editTooLarge"
  | "ai.runtime.editNotJson"
  | "ai.runtime.editNotObject"
  | "ai.runtime.editNoBaseline"
  | "ai.runtime.editEmpty"
  | "ai.runtime.editUnknownKey";

/**
 * 校验用户在卡片里改过的入参。
 *
 * 只接受原入参已有键的子集：能加键就等于能往工具里塞它没打算收的参数，
 * 而那个行为由 CLI 决定，我们审查不了。
 */
export function editedInput(text: string, original: unknown): { value?: Record<string, unknown>; error?: EditedInputError } {
  if (text.length > MAX_EDITED_INPUT) return { error: "ai.runtime.editTooLarge" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "ai.runtime.editNotJson" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "ai.runtime.editNotObject" };
  if (!original || typeof original !== "object" || Array.isArray(original)) return { error: "ai.runtime.editNoBaseline" };
  const base = original as Record<string, unknown>;
  const changes = parsed as Record<string, unknown>;
  const keys = Object.keys(changes);
  if (!keys.length) return { error: "ai.runtime.editEmpty" };
  if (keys.some((key) => !(key in base))) return { error: "ai.runtime.editUnknownKey" };
  return { value: changes };
}

export const denyPermission = (): AiPermissionAnswer => ({ allow: false });
export const allowOnce = (): AiPermissionAnswer => ({ allow: true });
export const allowAndRemember = (tool: string): AiPermissionAnswer => ({ allow: true, remember: { tool } });
export const allowDirectory = (tool: string, root: string): AiPermissionAnswer => ({ allow: true, remember: { tool, root } });
export const allowEdited = (input: Record<string, unknown>): AiPermissionAnswer => ({ allow: true, input });
