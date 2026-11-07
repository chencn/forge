import { Check, GitCommit, X } from "lucide-react";
import type { GitState } from "../hooks/useGitState";
import { useI18n } from "../i18n";
import { RECOVERY_CONTINUE, RECOVERY_MESSAGE, RECOVERY_ABORT } from "../lib/recovery";

/** 冲突恢复控件的入参。 */
interface ConflictWidgetProps {
  git: GitState;
}

/**
 * 冲突恢复控件：仓库停在合并/变基等动作中间时出现在主工具栏分支控件右侧。
 * 「继续」用运行色，「中止」用停止色。
 */
export default function ConflictWidget({ git }: ConflictWidgetProps) {
  const { t } = useI18n();
  const { recovery } = git;
  if (!recovery) return null;

  return (
    <div className="conflict-widget" role="group" aria-label={t(RECOVERY_MESSAGE[recovery])}>
      <button
        type="button"
        className="conflict-button is-resolve"
        onClick={() => void git.recoveryContinue()}
        title={t(RECOVERY_CONTINUE[recovery])}
      >
        {recovery === "rebase" ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <GitCommit size={13} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="conflict-button is-abort"
        onClick={() => void git.recoveryAbort()}
        title={t(RECOVERY_ABORT[recovery])}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
