import {
  ArrowUpToLine,
  CornerUpRight,
  FileDiff,
  FolderGit2,
  FolderInput,
  GitBranchPlus,
  GitMerge,
  Pencil,
  RefreshCw,
  Tag as TagIcon,
  Undo2,
} from "lucide-react";
import type { MenuItem } from "../components/ContextMenu";
import type { TranslationKey } from "../i18n/lang/zh";

/** 一条引用：日志的分支树和主工具栏的分支弹层用的是同一套目标。 */
export interface RefTarget {
  name: string;
  kind: "local" | "remote" | "tag";
}

/** 落到 git 命令的那些动作。 */
export type RefAction =
  | "checkout"
  | "checkoutUpdate"
  | "checkoutRebase"
  | "newBranch"
  | "merge"
  | "rebase"
  | "rename"
  | "push"
  | "delete"
  | "worktree"
  | "update";

/** 建菜单要的外部信息。 */
export interface RefMenuDeps {
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  /** 当前分支名；游离 HEAD 时是空串。 */
  current: string;
  /** 这条引用跟踪的上游短名（`origin/x`），没有上游时是空串。 */
  upstream: string;
  /** HEAD 是否游离。游离时没有「当前分支」可改变基目标，那两条变基项置灰给原因。 */
  detached: boolean;
  onAction: (action: RefAction, target: RefTarget) => void;
  /** 「与当前比较」：把日志中列筛成 current..target。 */
  onCompareWith: (target: RefTarget) => void;
  /** 「显示与工作树的差异」：第三栏改成列 target 对工作区的改动。 */
  onDiffWithWorktree: (target: RefTarget) => void;
}

/**
 * IDEA 只有一套引用动作（组 `Git.Branch`），本地 / 远端 / 标签的差别全在每个动作自己的
 * 可见性上：`refClass` 不匹配或 `isEnabledForRef` 返回 false 是整项隐藏，不是置灰
 * （见 docs/features/git-branches/ref-action-matrix.md）。空组不留下悬空的分隔线。
 */
export function buildRefMenu(target: RefTarget, deps: RefMenuDeps): MenuItem[] {
  const { t, current, upstream, detached, onAction, onCompareWith, onDiffWithWorktree } = deps;
  const isBranch = target.kind !== "tag";
  const isCurrent = target.kind === "local" && target.name === current;
  const go =
    (action: RefAction): (() => void) =>
    () =>
      onAction(action, target);
  const groups: MenuItem[][] = [
    [
      ...(isCurrent
        ? []
        : [
            {
              label: t("git.refCheckout"),
              icon: FolderInput,
              onSelect: go("checkout"),
            },
          ]),
      // 「打开工作树」要等 git worktree list 能查到别的工作树里检出了谁，先不摆。
      ...(isBranch
        ? [
            {
              label: t("git.refNewBranchFrom", { name: target.name }),
              icon: GitBranchPlus,
              onSelect: go("newBranch"),
            },
          ]
        : []),
      ...(isBranch && !isCurrent
        ? [
            {
              label: t("git.refCheckoutRebase", { name: current }),
              icon: CornerUpRight,
              // 第二步是把「刚才那条分支」变基过去，游离时没有这条分支。
              disabled: detached,
              hint: detached ? t("git.detachedRebase") : undefined,
              onSelect: go("checkoutRebase"),
            },
          ]
        : []),
      ...(target.kind === "local" && !isCurrent
        ? [
            {
              label: t("git.refCheckoutUpdate"),
              icon: RefreshCw,
              disabled: upstream === "",
              hint: upstream === "" ? t("git.noUpstream") : undefined,
              onSelect: go("checkoutUpdate"),
            },
          ]
        : []),
    ],
    [
      ...(isBranch && !isCurrent
        ? [
            {
              label: t("git.refCompareWith", { name: current }),
              icon: FileDiff,
              onSelect: () => onCompareWith(target),
            },
          ]
        : []),
      {
        label: t("git.refWorktreeDiff"),
        icon: FileDiff,
        onSelect: () => onDiffWithWorktree(target),
      },
    ],
    [
      ...(isBranch && !isCurrent
        ? [
            {
              label: t("git.refRebaseOnto", { name: target.name, current }),
              icon: Undo2,
              // IDEA 在游离 HEAD 时把这条置灰：变基的对象是「当前分支」，游离时没有。
              disabled: detached,
              hint: detached ? t("git.detachedRebase") : undefined,
              onSelect: go("rebase"),
            },
          ]
        : []),
      ...(!isCurrent
        ? [
            {
              label: t("git.refMergeInto", { name: target.name, current }),
              icon: GitMerge,
              onSelect: go("merge"),
            },
          ]
        : []),
    ],
    [
      {
        label: t("git.refNewWorktree", { name: target.name }),
        icon: FolderGit2,
        onSelect: go("worktree"),
      },
    ],
    [
      ...(target.kind === "local" && isCurrent
        ? [
            {
              label: t("git.refUpdate"),
              icon: RefreshCw,
              disabled: upstream === "",
              hint: upstream === "" ? t("git.noUpstream") : undefined,
              onSelect: go("update"),
            },
          ]
        : []),
      ...(target.kind === "local"
        ? [
            {
              label: t("git.refPush"),
              icon: ArrowUpToLine,
              shortcut: "Ctrl+Shift+K",
              onSelect: go("push"),
            },
          ]
        : []),
      ...(target.kind === "remote"
        ? [
            {
              label: t("git.refPullMerge", { name: target.name }),
              icon: CornerUpRight,
              disabled: true,
              hint: t("git.pullNeedsCheckout"),
            },
            {
              label: t("git.refPullRebase", { name: target.name }),
              icon: CornerUpRight,
              disabled: true,
              hint: t("git.pullNeedsCheckout"),
            },
          ]
        : []),
      // 跟踪的上游：IDEA 把同一套动作换成那条远端分支再列一遍。
      ...(target.kind === "local" && upstream
        ? [
            {
              label: t("git.refTrackedBranch", { name: upstream }),
              icon: GitBranchPlus,
              children: buildRefMenu(
                { name: upstream, kind: "remote" },
                { ...deps, upstream: "" }
              ),
            },
          ]
        : []),
    ],
    ...(target.kind === "tag"
      ? [
          [
            {
              label: t("git.refPushTag"),
              icon: TagIcon,
              onSelect: go("push"),
            },
          ],
        ]
      : []),
    [
      ...(target.kind === "local"
        ? [
            {
              label: t("git.refRename"),
              icon: Pencil,
              shortcut: "Alt+Shift+R",
              onSelect: go("rename"),
            },
          ]
        : []),
      ...(isCurrent
        ? []
        : [
            {
              label: t("git.refDelete"),
              danger: true,
              shortcut: "Delete",
              onSelect: go("delete"),
            },
          ]),
    ],
  ];
  const filled = groups.filter((group) => group.length > 0);
  return filled.flatMap((group, index) =>
    index === 0 ? group : [{ separator: true as const }, ...group]
  );
}

/** 查一条引用跟踪的上游短名；查不到或没有上游给空串。 */
export function upstreamOf(
  branches: { name: string; upstream: string }[],
  target: RefTarget
): string {
  if (target.kind !== "local") return "";
  return branches.find((branch) => branch.name === target.name)?.upstream ?? "";
}
