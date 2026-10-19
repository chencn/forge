import { invoke } from "@tauri-apps/api/core";
import { joinPath, separator } from "./format";
import type { RunConfiguration } from "./runConfigs";

export interface MavenSourceRoot {
  path: string;
  kind: "mainJava" | "mainResources" | "testJava" | "testResources";
}

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope: string;
}

export interface MavenProfile {
  id: string;
  activeByDefault: boolean;
}

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

const GOAL = /^[A-Za-z0-9_.:@=,\-/]+$/;
const PROFILE = /^[A-Za-z0-9_.-]+$/;

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
