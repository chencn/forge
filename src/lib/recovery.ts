import type { Recovery } from "./git";
import type { TranslationKey } from "../i18n/lang/zh";

/**
 * 仓库停在某个动作中间时，那对「继续 / 中止」按钮的文案。
 * 顶栏的微工具条和提交面板的横幅各画各的形状，读的是这一份，免得两处对不上。
 */
export const RECOVERY_MESSAGE: Record<Recovery, TranslationKey> = {
  rebase: "git.midRebase",
  merge: "git.midMerge",
  cherryPick: "git.midCherryPick",
  revert: "git.midRevert",
};

/** 继续那一颗：变基是接着往下跑，其余三条都是把那一次提交落下来。 */
export const RECOVERY_CONTINUE: Record<Recovery, TranslationKey> = {
  rebase: "git.continueRebase",
  merge: "git.commitMerge",
  cherryPick: "git.continueCherryPick",
  revert: "git.continueRevert",
};

export const RECOVERY_ABORT: Record<Recovery, TranslationKey> = {
  rebase: "git.abortRebase",
  merge: "git.abortMerge",
  cherryPick: "git.abortCherryPick",
  revert: "git.abortRevert",
};
