import { useEffect } from "react";
import { GitMerge } from "lucide-react";
import EntryIcon from "./EntryIcon";
import { useI18n } from "../i18n";
import type { GitChange } from "../lib/git";

interface ResolveConflictsDialogProps {
  /** 未合并的那些文件，顺序跟着变更清单。 */
  files: GitChange[];
  /** 按一边了结：本地取 stage 2，对方取 stage 3，取完顺带记为已解决。 */
  onAccept: (change: GitChange, side: "ours" | "theirs") => void;
  /** 打开源文件自己改冲突标记。 */
  onOpen: (change: GitChange) => void;
  onClose: () => void;
}

/** IDEA 的 Resolve Conflicts 那一层：逐个冲突文件按一边了结，或打开自己改。 */
export default function ResolveConflictsDialog({
  files,
  onAccept,
  onOpen,
  onClose,
}: ResolveConflictsDialogProps) {
  const { t } = useI18n();

  // 冲突全清完就没必要留着这层了。
  useEffect(() => {
    if (files.length === 0) onClose();
  }, [files.length, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop is-wide" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("git.resolveConflicts")}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog-title">{t("git.resolveConflicts")}</p>

        <ul className="resolve-list">
          {files.map((change) => (
            <li key={change.path} className="resolve-row">
              <button
                type="button"
                className="resolve-name"
                onClick={() => onOpen(change)}
                title={change.path}
              >
                <GitMerge size={13} aria-hidden="true" />
                <EntryIcon name={change.path.split(/[\\/]/).pop() ?? change.path} size={13} />
                <span>{change.path}</span>
              </button>
              <button
                type="button"
                className="button is-tiny"
                onClick={() => onAccept(change, "ours")}
              >
                {t("git.acceptYours")}
              </button>
              <button
                type="button"
                className="button is-tiny"
                onClick={() => onAccept(change, "theirs")}
              >
                {t("git.acceptTheirs")}
              </button>
            </li>
          ))}
        </ul>

        <div className="dialog-actions">
          <button type="button" className="button is-primary" onClick={onClose}>
            {t("git.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
