import { Check, CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitOperation } from "../hooks/useGitState";
import { useI18n } from "../i18n";
import { tooltipAttrs } from "../ui/Tooltip";
import "./GitOperationStatus.css";

/** 进度直接跟随 Git Promise，后端尚无流式百分比时只显示不定进度。 */
export default function GitOperationStatus({ operation }: { operation: GitOperation | null }) {
  const { t } = useI18n();
  const [visibleId, setVisibleId] = useState<number | null>(null);
  useEffect(() => {
    if (!operation || operation.phase !== "running") return;
    // 小于 500ms 的操作不闪进度；显示后的任务跟随真实完成状态收尾。
    const timer = setTimeout(() => setVisibleId(operation.id), 500);
    return () => clearTimeout(timer);
  }, [operation?.id, operation?.phase]);
  if (!operation || visibleId !== operation.id) return null;
  const running = operation.phase === "running";
  const label = t(`git.operation.${operation.kind}`);
  const result = running ? "…" : ` · ${t(operation.phase === "success" ? "git.operationDone" : "git.operationFailed")}`;
  return <span className="git-operation-status" role="status" aria-live="polite" {...tooltipAttrs(`${label} · ${operation.target}${result}`)}>
    {running ? <Loader2 size={12} className="is-spinning" aria-hidden="true" /> : operation.phase === "success" ? <Check size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}
    <span className="git-operation-label">{label}{result}</span>
    {running && <span className="git-operation-progress" role="progressbar" aria-label={label}><span /></span>}
  </span>;
}
