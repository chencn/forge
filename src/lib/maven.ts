import { invoke } from "@tauri-apps/api/core";
import { joinPath, separator } from "./format";
import type { RunConfiguration } from "./runConfigs";

/** 模块下的一个源码根及其类别。 */
export interface MavenSourceRoot {
  path: string;
  kind: "mainJava" | "mainResources" | "testJava" | "testResources";
}

/** 一条依赖（坐标 + scope）。 */
export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope: string;
}

/** 一个 POM profile。 */
export interface MavenProfile {
  id: string;
  activeByDefault: boolean;
}

/** 一个 Maven 模块（反应堆模块树上的一层，可嵌套）。 */
export interface MavenModule {
  relativePath: string;
  artifactId: string;
  groupId: string;
  version: string;
  packaging: string;
  sourceRoots: MavenSourceRoot[];
  dependencies: MavenDependency[];
  modules: MavenModule[];
}

/** 扫描出的整个工程：反应堆根模块 + 运行入口信息。 */
export interface MavenProject extends MavenModule {
  /** 反应堆相对工作区的位置。打开的文件夹自己就是反应堆时为 "."。 */
  invoke: string;
  hasWrapper: boolean;
  profiles: MavenProfile[];
}

/** 工程起来之后再问。没有 pom 时是 null，状态栏不画图标。 */
export function mavenScan(root: string): Promise<MavenProject | null> {
  return invoke<MavenProject | null>("maven_scan", { root });
}

/** goal / phase 的白名单字符集。 */
const GOAL = /^[A-Za-z0-9_.:@=,\-/]+$/;
/** profile id 与模块路径段的白名单字符集。 */
const PROFILE = /^[A-Za-z0-9_.-]+$/;

/** 含 shell 特殊字符时加引号（Windows cmd 约定）。 */
function quoteArg(value: string): string {
  return /[\s&()%^<>|]/.test(value) ? `"${value}"` : value;
}

/** 模块路径只允许普通相对段，避免把用户输入拼进 shell。 */
function safeModule(module: string): boolean {
  return module.split("/").every((seg) => seg.length > 0 && PROFILE.test(seg));
}

/**
 * 拼一条从反应堆目录起跑的 Maven 命令。
 * 过不了白名单就返回 null，调用方自己提示，不把这段交给 cmd。
 */
export function mavenCommand(
  project: MavenProject,
  module: string | null,
  goals: string[],
  profiles: string[],
  skipTests: boolean,
): string | null {
  if (goals.length === 0 || goals.some((goal) => !GOAL.test(goal))) return null;
  if (profiles.some((profile) => !PROFILE.test(profile))) return null;
  const parts = [project.invoke];
  if (module && module !== ".") {
    if (!safeModule(module)) return null;
    parts.push("-pl", quoteArg(module), "-am");
  }
  if (profiles.length > 0) parts.push(`-P${profiles.join(",")}`);
  if (skipTests) parts.push("-DskipTests");
  parts.push(...goals);
  return parts.join(" ");
}

/** Maven 命令的工作目录：反应堆子目录时给相对段，工程根本身给空串。 */
export function mavenWorkingDir(root: string, project: MavenProject): string {
  if (project.relativePath === ".") return "";
  return project.relativePath.replaceAll("/", separator(root));
}

/** 反应堆或某个模块的 pom。模块路径相对反应堆。 */
export function mavenPomPath(root: string, project: MavenProject, module: string | null): string {
  const parts: string[] = [];
  if (project.relativePath !== ".") parts.push(project.relativePath);
  if (module && module !== ".") parts.push(module);
  parts.push("pom.xml");
  return joinPath(root, parts.join("/").replaceAll("/", separator(root)));
}

/**
 * 把一次 Maven 执行包装成运行配置；命令过不了白名单返回 null。
 * id 由工作目录、模块与 goals 组成，同参数复用同一条配置。
 */
export function mavenRunConfig(
  project: MavenProject,
  module: string | null,
  goals: string[],
  profiles: string[],
  skipTests: boolean,
  title: string,
  workingDir: string,
): RunConfiguration | null {
  const command = mavenCommand(project, module, goals, profiles, skipTests);
  if (!command) return null;
  const scope = module && module !== "." ? module : ".";
  return {
    id: `maven-goal:${workingDir}:${scope}:${goals.join(" ")}`,
    name: title,
    kind: "maven",
    command,
    workingDir,
    env: [],
    generated: true,
    pinned: false,
  };
}
