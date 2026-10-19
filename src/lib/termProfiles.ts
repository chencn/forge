import type { TerminalProfile } from "./settings";
import type { TermSpec } from "./termStore";

/** 盘符、UNC、`/` 开头或 `~` 开头的都算绝对路径，不往工作区根上拼。 */
function isAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|[\\/]|~)/u.test(path);
}

/** 配置档的起始目录：相对路径拼在工作区根后面，分隔符跟着根走。 */
export function profileDir(dir: string, root: string | null): string | null {
  const trimmed = dir.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed) || !root) return trimmed;
  const separator = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/u, "");
  const rest = trimmed.replace(/^\.[\\/]/u, "").replace(/[\\/]/gu, separator);
  return rest === "." || rest === "" ? root : `${base}${separator}${rest}`;
}

/** 把配置档换成起会话要的东西；`shell` 为空时用默认 shell。 */
export function profileSpec(profile: TerminalProfile, root: string | null, defaultShell: string): TermSpec {
  const env: Record<string, string> = {};
  for (const entry of profile.env) {
    if (entry.key) env[entry.key] = entry.value;
  }
  return {
    shell: profile.shell || defaultShell,
    dir: profileDir(profile.dir, root),
    profile: profile.id,
    launch: { args: profile.args, env },
    command: profile.command,
  };
}

/** 一行一个 `KEY=VALUE`，空行和没有 `=` 的行不要；`KEY=` 表示摘掉这个变量。 */
export function parseEnvLines(text: string): TerminalProfile["env"] {
  const out: TerminalProfile["env"] = [];
  for (const line of text.split(/\r?\n/u)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!key) continue;
    out.push({ key, value: line.slice(at + 1) });
  }
  return out;
}

export function formatEnvLines(env: TerminalProfile["env"]): string {
  return env.map((entry) => `${entry.key}=${entry.value}`).join("\n");
}

/**
 * 参数一行写完，按空白切；双引号括起来的算一段，里面可以有空格。
 * 不做 shell 那套转义：这些参数交给进程，不过 shell。
 */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/gu;
  for (const match of text.matchAll(pattern)) out.push(match[1] ?? match[2] ?? "");
  return out;
}

export function formatArgs(args: string[]): string {
  return args.map((arg) => (/\s/u.test(arg) || arg === "" ? `"${arg}"` : arg)).join(" ");
}
