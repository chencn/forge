import type { ShellInfo } from "./term";

/**
 * 能被装订线 ▶ 送进终端的脚本类型。
 *
 * 只收 shell 家族这三类：它们在终端里跑就是原生的运行方式，不存在「解释器」这一层要另配。
 * `.py` / `.js` 那类要按解释器探测，口径不同，不在这里。
 */
export type ScriptKind = "bat" | "cmd" | "ps1" | "sh" | "bash";

/** 按扩展名或特殊文件名认出脚本类型；不是这五类就返回 null。 */
export function scriptKindOf(path: string): ScriptKind | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name === "gradlew" || name === "mvnw") return "sh";
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "bat":
    case "cmd":
    case "ps1":
    case "sh":
    case "bash":
      return ext;
    default:
      return null;
  }
}

/** 一类脚本对应的终端：错误文案里报的名字，以及怎么在 `shell_probe` 的结果里给它打分。 */
interface TerminalSpec {
  /** 缺终端时写进文案的名字，如 cmd、PowerShell、bash。 */
  label: string;
  /** 越合适分越高；不匹配返回 -1。挑分最高的那条。 */
  rank: (shell: ShellInfo) => number;
}

/**
 * 脚本类型 → 终端。认的是 `shell_probe` 给的可读名（`ShellInfo.name`），
 * 名字来自后端 `term.rs` 的 `push_shell` 调用，两端要对齐。
 */
const TERMINALS: Record<ScriptKind, TerminalSpec> = {
  bat: { label: "cmd", rank: (shell) => (shell.name === "cmd" ? 0 : -1) },
  cmd: { label: "cmd", rank: (shell) => (shell.name === "cmd" ? 0 : -1) },
  // 版本高的优先：`shell_probe` 把 Windows PowerShell 5.1 排在第一位，
  // 直接取第一条会挑中最旧的那个。`PowerShell 8/7/6` 按版本号打分；`pwsh` 是 PATH 上的
  // Core（6 起步，实践上多为 7+），给 7；光叫 `PowerShell` 没有版本号的那条就是 5.1，给 5。
  ps1: {
    label: "PowerShell",
    rank: (shell) => {
      if (shell.name === "pwsh") return 7;
      const versioned = /^PowerShell (\d+)$/.exec(shell.name);
      if (versioned) return Number(versioned[1]);
      return shell.name === "PowerShell" ? 5 : -1;
    },
  },
  sh: {
    label: "bash",
    rank: (shell) => (shell.name === "Git Bash" || shell.name === "bash" ? 0 : -1),
  },
  bash: {
    label: "bash",
    rank: (shell) => (shell.name === "Git Bash" || shell.name === "bash" ? 0 : -1),
  },
};

/** 这类脚本缺终端时，文案里要报的终端名。 */
export function scriptTerminalLabel(kind: ScriptKind): string {
  return TERMINALS[kind].label;
}

/** 在本机扫出来的 shell 里挑一个能跑这类脚本的；一个都没有返回 null。 */
export function findShellForScript(shells: ShellInfo[], kind: ScriptKind): ShellInfo | null {
  let best: ShellInfo | null = null;
  let bestRank = -1;
  for (const shell of shells) {
    const rank = TERMINALS[kind].rank(shell);
    // 同分时留先出现的：`shell_probe` 的次序就是它的偏好。
    if (rank > bestRank) {
      bestRank = rank;
      best = shell;
    }
  }
  return best;
}

/** 转成目标 shell 认的分隔符：cmd / PowerShell 用反斜杠，bash 用正斜杠。 */
function toBackslash(path: string): string {
  return path.replace(/\//g, "\\");
}

function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

/** PowerShell 单引号字符串里，单引号写成两个。 */
function psQuote(path: string): string {
  return path.replace(/'/g, "''");
}

/** POSIX 单引号字符串里，单引号写成 `'\''`。 */
function shQuote(path: string): string {
  return path.replace(/'/g, "'\\''");
}

/**
 * 拼出写进终端的整行命令：先切到脚本所在目录，再调它。
 *
 * 切目录是必要的——脚本多半按相对当前目录找自己的资源，终端的起始目录是工程根，不切就找错。
 * 三类 shell 的写法各不相同，这里按类型分派；路径按各自的分隔符与引号规则处理。
 */
export function buildScriptCommand(kind: ScriptKind, scriptPath: string, workDir: string): string {
  switch (kind) {
    case "bat":
    case "cmd": {
      const script = toBackslash(scriptPath);
      const dir = toBackslash(workDir);
      return dir ? `cd /d "${dir}" && "${script}"` : `"${script}"`;
    }
    case "ps1": {
      const script = psQuote(toBackslash(scriptPath));
      const dir = psQuote(toBackslash(workDir));
      return dir
        ? `Set-Location -LiteralPath '${dir}'; & '${script}'`
        : `& '${script}'`;
    }
    case "sh":
    case "bash": {
      const script = shQuote(toSlash(scriptPath));
      const dir = shQuote(toSlash(workDir));
      return dir ? `cd '${dir}' && bash '${script}'` : `bash '${script}'`;
    }
  }
}
