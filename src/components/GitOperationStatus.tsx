import { useEffect, useRef, useState } from "react";
import type { GitOperation } from "../hooks/useGitState";
import { useI18n } from "../i18n";
import { BarButton } from "../ui/BarButton";
import { Popup } from "../ui/Popup";
import { ProgressBar } from "../ui/Feedback";
import "./GitOperationStatus.css";

/** 进度直接跟随 Git Promise，后端尚无流式百分比时只显示不定进度。 */
export default function GitOperationStatus({ operation }: { operation: GitOperation | null }) {
  const { t } = useI18n();
  const [visibleId, setVisibleId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 任务自动消失后恢复原控件；用户已主动移走焦点时不抢回。
    if (!operation && document.activeElement === document.body && previousFocus.current?.isConnected) {
      previousFocus.current.focus({ preventScroll: true });
    }
  }, [operation]);
  useEffect(() => {
    if (!operation || operation.phase !== "running") return;
    // 小于 500ms 的操作不闪进度；显示后的任务跟随真实完成状态收尾。
    const timer = setTimeout(() => setVisibleId(operation.id), 500);
    return () => clearTimeout(timer);
  }, [operation?.id, operation?.phase]);
  if (!operation || visibleId !== operation.id) return null;
  const running = operation.phase === "running";
  const label = t(`git.operation.${operation.kind}`);
  const result = running ? "" : ` · ${t(operation.phase === "success" ? "git.operationDone" : "git.operationFailed")}`;
  const open = openId === operation.id;
  // 完成后保留进度条到任务清理；标题和宽度稳定，不插入额外旋转图标或完成标记。
  const value = running ? undefined : 1;
  return <>
    <span className="git-operation-status" role="status" aria-live="polite">
      <BarButton ref={anchor} className="git-operation-task" aria-expanded={open} aria-haspopup="dialog"
        aria-label={`${t("git.backgroundTasks")} · ${label}${result}`} tooltip={`${label} · ${operation.target}${result}`}
        onFocus={(event) => { if (event.relatedTarget instanceof HTMLElement) previousFocus.current = event.relatedTarget; }}
        onClick={() => setOpenId(open ? null : operation.id)}>
        <span className="git-operation-label">{label}</span>
        <ProgressBar value={value} className="git-operation-progress" aria-label={label} />
      </BarButton>
    </span>
    <Popup open={open} anchor={anchor} placement="top-end" offset={6} autoFocus={false} onClose={() => setOpenId(null)} aria-label={t("git.backgroundTasks")}>
      <div className="git-operation-list">
        <div className="git-operation-list-header">{t("git.backgroundTasks")}</div>
        <div className="git-operation-row">
          <span className="git-operation-row-title">{label}{result}</span>
          <ProgressBar value={value} aria-label={label} />
          <span className="git-operation-target">{operation.target}</span>
        </div>
      </div>
    </Popup>
  </>;
}
