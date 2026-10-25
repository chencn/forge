import type { AiProvider } from "./aiCli";

/** CLI metadata only; argumentHint is documentation, never a parser or shell command. */
export interface AiCommand { name: string; description: string; argumentHint: string; aliases?: string[]; builtin?: boolean }
export interface AiCommandCatalog { commands: AiCommand[]; terminal: string[] }
export type LocalCommand = "help" | "model" | "effort" | "permissions" | "fast" | "context" | "settings";
export interface CommandSuggestion extends AiCommand { local?: LocalCommand; hintKey?: string }
const localNames: LocalCommand[] = ["help", "model", "effort", "permissions", "fast", "context", "settings"];
// 参数按这版 CLI 的模式原话匹配（read/ask/auto/full 仍是 Codex 的沙箱档、Claude 的旧别名）。
const hints: Record<LocalCommand, string> = { help: "", model: "[model-id | default]", effort: "[level | default]", permissions: "[plan | default | read | ask | auto | full]", fast: "[on | off]", context: "", settings: "" };

export function normalizeCommandCatalog(data: Record<string, unknown>): AiCommandCatalog | undefined {
  if (!Array.isArray(data.commands)) return undefined;
  const commands = data.commands.flatMap((item): AiCommand[] => {
    if (!item || typeof item !== "object") return [];
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string" || !validCommandName(c.name)) return [];
    return [{ name: c.name, description: typeof c.description === "string" ? c.description : "", argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
      aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string" && validCommandName(a)) : [], builtin: typeof c.builtin === "boolean" ? c.builtin : undefined }];
  });
  return { commands, terminal: Array.isArray(data.terminal) ? data.terminal.filter((s): s is string => typeof s === "string") : [] };
}
function validCommandName(name: string) { return name.length > 0 && name.length <= 200 && !/[\s/\\\u0000-\u001f]/u.test(name); }
/** Only the first token is parsed. Native arguments (including quotes/newlines) remain untouched. */
export function parseSlash(text: string): { name: string; args: string; text: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const match = /^\/([^\s]*)(?:\s([\s\S]*))?$/u.exec(trimmed);
  return match ? { name: match[1], args: match[2] ?? "", text: trimmed } : null;
}
/** Exact names beat aliases; a builtin beats a same-name skill. Preserve CLI spelling. */
export function resolveNativeCommand(catalog: AiCommandCatalog, name: string): AiCommand | undefined {
  const exact = catalog.commands.filter((c) => c.name === name);
  const matches = exact.length ? exact : catalog.commands.filter((c) => c.aliases?.includes(name));
  const command = matches.find((c) => c.builtin) ?? matches[0];
  return command && (["compact", "usage"].includes(command.name) || command.builtin !== true) && !catalog.terminal.includes(command.name) && !catalog.terminal.includes(name) ? command : undefined;
}
export function localCommand(name: string): LocalCommand | undefined {
  if (name === "permissions" || name === "permission" || name === "approvals") return "permissions";
  return localNames.includes(name as LocalCommand) ? name as LocalCommand : undefined;
}
export function commandSuggestions(provider: AiProvider, catalog?: AiCommandCatalog): CommandSuggestion[] {
  const local = localNames.filter((name) => provider === "codex" ? name !== "context" : name !== "fast").map((name) => ({ name, description: "", argumentHint: hints[name], local: name, hintKey: `ai.commands.${name}` }));
  const native = catalog ? [...new Set(catalog.commands.map((c) => c.name))].flatMap((name) => {
    const c = resolveNativeCommand(catalog, name);
    return c && !localCommand(name) ? [c] : [];
  }) : [];
  // These are Forge mappings to stable app-server methods, not a claimed CLI command catalog.
  const codex = provider === "codex" ? [
    { name: "compact", description: "", argumentHint: "", hintKey: "ai.commands.compact" },
    { name: "review", description: "", argumentHint: "[instructions]", hintKey: "ai.commands.review" },
  ] : [];
  return [...local, ...codex, ...native];
}
export function filterCommandSuggestions(commands: CommandSuggestion[], draft: string): CommandSuggestion[] {
  const slash = parseSlash(draft);
  if (!slash || /\s/u.test(draft.trimStart())) return [];
  return commands.filter((c) => c.name.startsWith(slash.name) || c.aliases?.some((a) => a.startsWith(slash.name)));
}
/** Completion preserves argument text and only replaces the command token. */
export function completeCommand(draft: string, name: string): string {
  const match = /^\s*\/[^\s]*(\s[\s\S]*)?$/u.exec(draft);
  return `/${name}${match?.[1] ?? " "}`;
}
