/**
 * 磁盘事件批次的分类：哪些批次真的需要「把所有展开过的目录缓存全作废」，
 * 哪些只该按路径精确作废。
 *
 * 精确作废（`refreshPaths`）从来不会漏掉用户看得见的东西：它会重列每一个「包含被改路径」
 * 或「在被改路径之下」的缓存目录。全量作废多做的，只是把跟这批事件毫无关系的目录也重读一遍。
 * 所以判据应当是「这批事件像不像把整棵树的结构改了」，而不是「路径名碰起来像个大目录」。
 *
 * 一次 `cargo build` 或 webpack watch 会连着写 `target/`、`dist/` 里的产物：那是文件**内容**
 * 被重写，目录里有什么名字基本没变。按老写法它算风暴，每批都要重列所有展开着的目录——
 * 白读一盘，还把刷新推迟到 1.2s 静默期之后。
 */

/** 归一成分隔符统一的小写形式，Windows 与 POSIX 的写法都落到同一个判断上。 */
function norm(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/** 包管理器装删依赖的地方：这些目录整块出现或消失，根级列表和忽略态都得跟着变。 */
const PACKAGE_DIRS = ["/node_modules", "/.pnpm", "/vendor/", "/.venv/", "/venv/"];

/** 构建工具的产物目录：里面的写入几乎全是覆盖写，不代表工程结构变了。 */
const BUILD_OUTPUT_DIRS = ["/target/", "/dist/", "/build/", "/out/", "/.next/", "/.gradle/", "/obj/", "/bin/debug/", "/bin/release/"];

/**
 * 落在这些目录里、或者**就是**这些目录本身，都算。
 * 只匹配 `/target/` 这种带尾斜杠的形式会漏：新建 `target/e2e-x/` 时，监听还会报来
 * `.../src-tauri/target` 这一条自身，那一下就把整批剔出「全是产物」，精确作废白做。
 */
function inAny(path: string, dirs: readonly string[]): boolean {
  return dirs.some((raw) => {
    const dir = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return path === dir || path.endsWith(dir) || path.includes(`${dir}/`);
  });
}

/** 这条路径是不是依赖安装/卸载留下的痕迹。 */
export function isPackageInstallPath(path: string): boolean {
  return inAny(norm(path), PACKAGE_DIRS);
}

/** 这条路径是不是构建产物。 */
export function isBuildOutputPath(path: string): boolean {
  return inAny(norm(path), BUILD_OUTPUT_DIRS);
}

/** 批量写入的特征路径：监听器据此把静默窗口拉长，避免每批都刷一次。产物也算，安装也算。 */
export function isBulkArtifactPath(path: string): boolean {
  const p = norm(path);
  return isPackageInstallPath(p) || isBuildOutputPath(p);
}

/**
 * 这批事件需不需要全量作废目录缓存。
 *
 * - 全是产物写入：不用。改动都在产物目录里，精确作废已经覆盖到用户展开着的每一层。
 * - 真·批量（路径数达到风暴阈值）且掺了非产物路径：要。这时可能是 `git checkout`、
 *   大目录移动这类整树结构变动。
 * - 一批里有依赖目录：要。`node_modules` 整块出现时，根目录列表和忽略态都得重算。
 */
export function needsFullTreeRefresh(paths: readonly string[], bulk: boolean): boolean {
  if (paths.length === 0) return false;
  if (paths.every(isBuildOutputPath)) return false;
  if (bulk) return true;
  return paths.some(isPackageInstallPath);
}

/** 一批变动该把哪三处刷新掉。 */
export interface FlushPlan {
  /** `full` 整棵目录树作废；`precise` 只作废与这批路径相干的目录；`none` 不动树。 */
  tree: "full" | "precise" | "none";
  /** 顶栏运行配置要不要防抖重扫（构建声明文件变了）。 */
  configs: boolean;
  /** `full` 连分支与提交记录一起重取（HEAD / 引用 / 合并态动过）；`changes` 只重取变更清单。 */
  git: "full" | "changes" | "none";
}

/** 动到这些就得全量重取 Git：分支、提交历史、合并状态都跟着走。 */
const GIT_REF_MARKERS = ["/.git/head", "/.git/refs/", "/.git/packed-refs", "/.git/merge_head"];

function touchesGitRef(gitPaths: readonly string[]): boolean {
  return gitPaths.some((p) => {
    const n = norm(p);
    return GIT_REF_MARKERS.some((marker) => n.includes(marker));
  });
}

/** 一批磁盘事件的分类输入：监听来的批次和安装会话收尾攒下的那批都长成这样。 */
export interface WorkspaceFlush {
  workspacePaths: string[];
  /** 同一批里 `.git` 下面那些路径：决定 Git 是只重取清单，还是连分支与提交记录一起重取。 */
  gitPaths: string[];
  bulk: boolean;
  /** 安装会话收尾：哪怕一个路径都没攒到，也要重读一次树与状态兜底。 */
  finishedInstall?: boolean;
}

/** 决策层的完整输入：除了批次本身，还差一个「构建声明文件变了没有」。 */
export interface FlushDecision extends WorkspaceFlush {
  manifestChanged: boolean;
}

/**
 * 一次磁盘批次（或安装会话收尾）该刷哪几处，都在这里定，不在调用方各写一套。
 *
 * 目录树只有在有工作区文件变动时才动；安装收尾即使一个路径都没攒到也要整树重读一次兜底。
 * Git 与顶栏配置只该由当前激活根触发，但那道归属判断留给调用方（只有它知道是不是激活根）。
 */
export function planWorkspaceFlush(input: FlushDecision): FlushPlan {
  const { workspacePaths, gitPaths, bulk } = input;
  const finishedInstall = input.finishedInstall ?? false;
  const tree =
    workspacePaths.length > 0
      ? needsFullTreeRefresh(workspacePaths, bulk)
        ? "full"
        : "precise"
      : finishedInstall
        ? "full"
        : "none";
  const git = touchesGitRef(gitPaths)
    ? "full"
    : workspacePaths.length > 0 || gitPaths.length > 0 || finishedInstall
      ? "changes"
      : "none";
  return { tree, configs: input.manifestChanged, git };
}
