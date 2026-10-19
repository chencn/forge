/**
 * JVM 项目的包路径压缩，照 IntelliJ 项目视图的「Compact Middle Packages」。
 *
 * JVM 不只有 Java：Kotlin、Groovy、Scala 同样按包组织。IDEA 里只有 JVM 源码根之下的层级
 * 才把目录链显示成包名（`com/example/demo` → `com.example.demo`），其它语言照常按目录显示。
 *
 * 这里没有 PSI，按约定判：路径里出现 `src/main/<jvm语言>` 或 `src/test/<jvm语言>` 这样的片段，
 * 就是源码根。**按片段而非固定前缀匹配**，所以多模块（`backend/src/main/java/...`）、
 * Android（`app/src/main/java/...`）、Gradle 多语言（`src/main/kotlin/...`）都能覆盖。
 */

/** JVM 语言在源码根里的目录名。 */
const JVM_LANGUAGES = ["java", "kotlin", "groovy", "scala"];

/** 源码集：Gradle / Maven 的 main 与 test。 */
const SOURCE_SETS = ["main", "test"];

/** 合法的包名段：标识符（字母/下划线/$ 开头，后跟字母数字/下划线/$）。 */
export function isPackageSegment(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** 把路径归一成「正斜杠 + 小写、去尾斜杠」，用于比较。 */
function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
}

/**
 * 在路径里找 JVM 源码根片段，返回它与「当前目录」的关系。
 * @description 源码根 = `src/{main,test}/{java,kotlin,groovy,scala}` 连续三段。
 *   `isRoot` 表示当前目录就是源码根本身（包链的硬边界，不并入父节点）。
 *   `underRoot` 表示当前目录严格在源码根之下（包链内部，用 `.` 连接）。
 * @returns 找不到源码根片段时返回 null
 */
function sourceRootPosition(path: string): { isRoot: boolean; underRoot: boolean } | null {
  const parts = normalizePath(path).split("/");
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (parts[i] !== "src") continue;
    if (!SOURCE_SETS.includes(parts[i + 1])) continue;
    if (!JVM_LANGUAGES.includes(parts[i + 2])) continue;
    const below = parts.length - (i + 3);
    return { isRoot: below === 0, underRoot: below > 0 };
  }
  return null;
}

/** JVM 源码根目录名，和同名源文件的图标颜色一一对应。 */
export type JvmSourceLanguage = (typeof JVM_LANGUAGES)[number];

/** 当前目录是不是 JVM 源码根本身（`.../src/main/java`）。 */
function isJvmSourceRoot(path: string): boolean {
  return sourceRootPosition(path)?.isRoot ?? false;
}

/**
 * 这条路径如果正好是源码根，返回它的语言目录名（`java` / `kotlin` / …）。
 * 源码根之下的包目录、以及普通同名文件夹都返回 null。
 */
export function jvmSourceRootLanguage(path: string): JvmSourceLanguage | null {
  if (!isJvmSourceRoot(path)) return null;
  const parts = normalizePath(path).split("/");
  const language = parts[parts.length - 1];
  return JVM_LANGUAGES.includes(language) ? language : null;
}

/** `src/main/resources` 与 `src/test/resources` 本身。子目录不算。 */
export type ResourcesRootKind = "main" | "test";

/**
 * 这条路径如果正好是资源根，返回 main 或 test。
 * 照 Lithe：只有 `src/{main,test}/resources` 这一层换资源根图标。
 */
export function resourcesRootKind(path: string): ResourcesRootKind | null {
  const parts = normalizePath(path).split("/");
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (parts[i] !== "src") continue;
    if (parts[i + 1] !== "main" && parts[i + 1] !== "test") continue;
    if (parts[i + 2] !== "resources") continue;
    if (parts.length !== i + 3) return null;
    return parts[i + 1] === "test" ? "test" : "main";
  }
  return null;
}

/** 当前目录是不是严格在 JVM 源码根之下。 */
export function isUnderJvmSourceRoot(path: string): boolean {
  return sourceRootPosition(path)?.underRoot ?? false;
}

/** 压缩用的最小目录形态；提交面板的 DirNode、日志的 FileNode 都满足。 */
interface DirLike {
  name: string;
  path: string;
  dirs: DirLike[];
  files: unknown[];
}

/**
 * 压缩「只有一个子目录、自己没有文件」的目录链。
 *
 * 分隔符分两种：处于 JVM 包链内部（源码根之下）时用 `.`（`com.example.demo`），其余用 `/`（`a/b/c`）。
 * 源码根本身是硬边界，不并入父节点——这样 `java` 与它下面的 `com` 不会黏成 `java/com`。
 *
 * @param dir 目录节点
 * @returns 压缩后的节点
 */
export function collapsePackageDirs<T extends DirLike>(dir: T): T {
  let current: T = dir;
  while (current.files.length === 0 && current.dirs.length === 1) {
    // 源码根本身到此为止，链从它下面重新起。
    if (isJvmSourceRoot(current.path)) break;
    const child = current.dirs[0] as T;
    const isPackage = isUnderJvmSourceRoot(current.path) && isPackageSegment(child.name);
    child.name = `${current.name}${isPackage ? "." : "/"}${child.name}`;
    current = child;
  }
  current.dirs = current.dirs.map((child) => collapsePackageDirs(child as T)) as T["dirs"];
  return current;
}
