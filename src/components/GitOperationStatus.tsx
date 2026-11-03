import { useEffect, useRef, useState } from "react";
import type { GitOperation } from "../hooks/useGitState";
import { useI18n } from "../i18n";
import { BarButton } from "../ui/BarButton";
import { Popup } from "../ui/Popup";
import { ProgressBar } from "../ui/Feedback";
import "./GitOperationStatus.css";

/** 底栏表示任务仍在运行；展开详情才展示 Git 输出中的阶段进度。 */
export default function GitOperationStatus({ operations }: { operations: readonly GitOperation[] }) {
  const { t } = useI18n();
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<number>>(new Set());
  const [open, setOpen] = useState(false);
  const pending = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const anchor = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 任务自动消失后恢复原控件；用户已主动移走焦点时不抢回。
    if (!operations.length && document.activeElement === document.body && previousFocus.current?.isConnected) {
      previousFocus.current.focus({ preventScroll: true });
    }
  }, [operations.length]);
  useEffect(() => {
    // 每项独立延迟；实时输出和切换工程都不能重置 500ms 的显示计时。
    const ids = new Set(operations.map((task) => task.id));
    for (const [id, timer] of pending.current) {
      if (!operations.some((task) => task.id === id && task.phase === "running")) {
        clearTimeout(timer); pending.current.delete(id);
      }
    }
    setVisibleIds((current) => [...current].some((id) => !ids.has(id)) ? new Set([...current].filter((id) => ids.has(id))) : current);
    for (const task of operations) {
      if (task.phase !== "running" || visibleIds.has(task.id) || pending.current.has(task.id)) continue;
      pending.current.set(task.id, setTimeout(() => {
        pending.current.delete(task.id);
        setVisibleIds((current) => new Set(current).add(task.id));
      }, 500));
    }
    if (!operations.length) setOpen(false);
  }, [operations, visibleIds]);
  useEffect(() => () => {
    for (const timer of pending.current.values()) clearTimeout(timer);
    // StrictMode 会重放挂载效果；清掉记录，重放时才能重新安排显示。
    pending.current.clear();
  }, []);
  const tasks = operations.filter((task) => visibleIds.has(task.id)).sort((left, right) => left.id - right.id);
  const runningTasks = tasks.filter((task) => task.phase === "running");
  const operation = runningTasks.at(-1) ?? tasks.at(-1);
  if (!operation) return null;
  const running = operation.phase === "running";
  const label = t(`git.operation.${operation.kind}`);
  const result = running ? "" : ` · ${t(operation.phase === "success" ? "git.operationDone" : "git.operationFailed")}`;
  // Git 的百分比只属于当前阶段，不能当作整个任务的进度；底栏运行中持续扫动。
  const value = running ? null : 1;
  return <>
    <span className="git-operation-status" role="status" aria-live="polite">
      <BarButton ref={anchor} className="git-operation-task" aria-expanded={open} aria-haspopup="dialog"
        aria-label={`${t("git.backgroundTasks")} · ${label}${result}`} tooltip={`${label} · ${operation.target}${result}`}
        onFocus={(event) => { if (event.relatedTarget instanceof HTMLElement) previousFocus.current = event.relatedTarget; }}
        onClick={() => setOpen((current) => !current)}>
        <span className="git-operation-label">{label}</span>
        <ProgressBar value={value} className="git-operation-progress" aria-label={label} />
        {runningTasks.length > 1 && <span>+{runningTasks.length - 1}</span>}
      </BarButton>
    </span>
    <Popup open={open} anchor={anchor} placement="top-end" offset={6} autoFocus={false} onClose={() => setOpen(false)} aria-label={t("git.backgroundTasks")}>
      <div className="git-operation-list">
        <div className="git-operation-list-header">{t("git.backgroundTasks")}</div>
        {tasks.map((task) => {
          const title = t(`git.operation.${task.kind}`);
          const progress = task.phase === "success" ? 1 : task.fraction;
          const outcome = task.phase === "running" ? "" : ` · ${t(task.phase === "success" ? "git.operationDone" : "git.operationFailed")}`;
          const detail = task.message ?? `${task.root} · ${task.target}`;
          return <div className="git-operation-row" key={task.id}>
            <div className="git-operation-row-head"><span className="git-operation-row-title">{title}{outcome}</span>
              {progress != null && <span>{Math.round(progress * 100)}%</span>}</div>
            <ProgressBar value={progress} aria-label={title} />
            <span className="git-operation-target" title={`${task.root} · ${detail}`}>{detail}</span>
          </div>;
        })}
      </div>
    </Popup>
  </>;
}
