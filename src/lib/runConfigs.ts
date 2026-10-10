import { invoke } from "@tauri-apps/api/core";
import { createFolder, writeFile } from "./fs";
import { parentPath } from "./format";

/** 配置类型。和后端 `RunKind` 一一对应，界面上按它分组与挑图标。 */
export type RunKind =
  | "npm"
  | "maven"
  | "gradle"
  | "spring"
  | "java"
  | "go"
  | "wails"
  | "rust"
  | "python"
  | "dotnet"
  | "clojure"
  | "cpp"
  | "dart"
  | "deno"
  | "elixir"
  | "haskell"
  | "julia"
  | "lua"
  | "php"
  | "ruby"
  | "scala"
  | "swift"
  | "zig"
  | "shell";

/** 一条键值环境变量。 */
export interface EnvVar {
  name: string;
  value: string;
}

/** 本机跑不了这条配置的原因。`code` 是稳定码，文案在前端。 */
export interface Unavailable {
  code: "NO_TOOL" | "NO_JDK" | "JDK_TOO_OLD";
  detail: string;
}

/** 起跑前要先落到磁盘上的辅助文件（Gradle 的 init 脚本）。 */
export interface HelperFile {
  path: string;
  content: string;
}

/** 装订线上那颗 ▶ 的落点：这条配置在某个源文件里声明在哪一行。 */
export interface RunMarker {
  /** 相对工程根的源文件路径，一律 `/` 分隔。缺了就对不上打开的那篇文档。 */
  file: string;
  /** 1 起的行号，指着声明本身那一行。后端只给命中的行，不给 0。 */
  line: number;
}

/** 一条运行配置：识别出来的和用户建的是同一个形状，差别在 `generated`。 */
export interface RunConfiguration {
  id: string;
  name: string;
  kind: RunKind;
  /** 交给进程通道的整行命令，可能带 `${mvn}` 这类占位。 */
  command: string;
  /** 相对工程根的运行目录；空串是根。 */
  workingDir: string;
  env: EnvVar[];
  /** 由构建文件推出来的，界面只读。 */
  generated: boolean;
  pinned: boolean;
  unavailable?: Unavailable | null;
  helper?: HelperFile | null;
  /** 编辑器装订线上的落点，一条可以有好几处（JVM 那边类声明与 main 各一处）。空就没有可点的。 */
  markers?: RunMarker[];
}

/** 一次识别的结果。`problems` 是「读到了但读不成」那类原因，不能当成「没有」。 */
export interface RunDetectOutcome {
  configs: RunConfiguration[];
  problems: string[];
}

/** 本机那三个 JVM 工具的实际位置；空串表示没有。 */
export interface RunTools {
  maven: string;
  gradle: string;
  java: string;
  javaFeature: number;
}

/** 一个工程存下来的那几样用户决定。 */
export interface ProjectRunState {
  configs: RunConfiguration[];
  selected: string;
  pinned: string[];
}

/** 命令行里代表「本机 PATH 上那个工具」的占位；展开见 `resolveCommand`。 */
export const TOOL_PLACEHOLDERS = ["${mvn}", "${gradle}", "${java}"] as const;

export function detectRuns(root: string): Promise<RunDetectOutcome> {
  return invoke<RunDetectOutcome>("run_detect", { root });
}

export function runTools(): Promise<RunTools> {
  return invoke<RunTools>("run_tools");
}

export function loadRunState(root: string): Promise<ProjectRunState> {
  return invoke<ProjectRunState>("run_state_load", { root });
}

export function saveRunState(root: string, state: ProjectRunState): Promise<void> {
  return invoke<void>("run_state_save", { root, state });
}

/** 路径写进命令行时要裹引号；不带空格与 cmd 保留字符的就原样。 */
function quoteArg(value: string): string {
  if (!value || value.startsWith('"')) return value;
  // 与后端 `needs_quote` 同一把尺子，两端展开出来的样子要能对上。
  return /[\s&()%^<>|]/.test(value) ? `"${value}"` : value;
}

/**
 * 把 `${mvn}` 这类占位展开成这台机器上的实际路径。
 *
 * 识别时不烤绝对路径：换台机器或挪个 JDK，配置就废了；烤占位则每次按本机现算。
 */
export function resolveCommand(command: string, tools: RunTools): string {
  return command
    .replaceAll("${mvn}", quoteArg(tools.maven))
    .replaceAll("${gradle}", quoteArg(tools.gradle))
    .replaceAll("${java}", quoteArg(tools.java));
}

/** 这条配置用到了哪些占位；缺哪个工具要说得出来。 */
export function usedPlaceholders(command: string): string[] {
  return TOOL_PLACEHOLDERS.filter((placeholder) => command.includes(placeholder));
}

/** 占位对应的那个工具在不在本机。 */
export function missingTool(command: string, tools: RunTools): string | null {
  const table: Record<string, string> = {
    "${mvn}": tools.maven,
    "${gradle}": tools.gradle,
    "${java}": tools.java,
  };
  for (const placeholder of usedPlaceholders(command)) {
    if (!table[placeholder]) return placeholder;
  }
  return null;
}

/**
 * 写辅助文件。目录要先建出来，`write_file` 不会替调用方建父目录。
 * 内容一样就不重写，省掉一次磁盘改动与随之而来的目录刷新。
 */
export async function ensureHelper(helper: HelperFile): Promise<void> {
  const dir = parentPath(helper.path);
  if (dir) await createFolder(dir).catch(() => undefined);
  await writeFile(helper.path, helper.content, "lf", false);
}

/** 一条新配的自定义配置该有的样子。 */
export function newShellConfig(id: string, name: string): RunConfiguration {
  return {
    id,
    name,
    kind: "shell",
    command: "",
    workingDir: "",
    env: [],
    generated: false,
    pinned: false,
    unavailable: null,
    helper: null,
  };
}
