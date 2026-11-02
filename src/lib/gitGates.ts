/**
 * Git 动作门禁的共享谓词。
 *
 * 过去这些判断散落在 BranchPicker、GitLogPane、refMenu、contextMenu、命令面板五处，
 * 每处各写一遍，结果"推送在日志窗禁了、在分支弹层没禁"这种不一致。这里收敛成唯一真源：
 * 每个入口只认 `canPush` / `canUpdate` / `canFetch` / `isRepoFresh`，不再自己重写条件。
 *
 * GitState 的部分字段在这些函数里只读，调用方传整个 GitState 即可。
 */
import type { GitState } from "../hooks/useGitState";

/** 有没有配任何远端。推送与抓取都需要至少一个远端。 */
export function hasRemotes(git: GitState): boolean {
  return (git.probe?.remotes.length ?? 0) > 0;
}

/** 仓库里有没有一次提交。空仓库（刚 init）没有任何 ref 可推。 */
export function isRepoFresh(git: GitState): boolean {
  return git.lastCommit === null;
}

/** HEAD 是否游离。游离 HEAD 上推送没有意义——没有分支可跟。 */
function isDetached(git: GitState): boolean {
  return git.status?.detached ?? false;
}

/** 当前分支有没有跟踪的上游。更新（pull --ff-only）需要上游存在。 */
function hasUpstream(git: GitState): boolean {
  return !!git.status?.upstream?.trim();
}

/** 推送：至少有一个远端、HEAD 不在游离态、仓库不是空仓库。 */
export function canPush(git: GitState): boolean {
  return !isRepoFresh(git) && hasRemotes(git) && !isDetached(git);
}

/** 更新项目（pull --ff-only）：满足推送条件 + 当前分支有上游。 */
export function canUpdate(git: GitState): boolean {
  return canPush(git) && hasUpstream(git);
}

/** 抓取远端：至少有一个远端。不需要上游。 */
export function canFetch(git: GitState): boolean {
  return hasRemotes(git);
}
