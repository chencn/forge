import { useRef, type KeyboardEvent } from "react";
import clsx from "clsx";
import { useI18n } from "../i18n";
import type { GitView } from "./GitPanel";
import styles from "./GitViewTabs.module.css";

/** {@link GitViewTabs} 的入参。 */
interface GitViewTabsProps {
  /** 当前选中的视图。 */
  view: GitView;
  /** 切换视图的回调；选中项记在 App 那层，工具窗换边或重新挂载都不丢。 */
  onChange: (view: GitView) => void;
  /** 贮藏条数（含搁置列表），大于 0 才考虑画计数。 */
  stashCount: number;
  /** 侧栏当前宽度容不容得下计数；容不下就退回纯文字，不挤走头部右端的动作按钮。 */
  showCount: boolean;
}

/**
 * 提交工具窗口头部的视图页签：「提交」和「贮藏」并列，直接顶掉原来的窗口标题。
 *
 * @remarks 页签只负责选视图，两块内容始终都在 DOM 里，切走的那块靠 `hidden` 藏起来——
 * 说明框草稿与正在跑的 AI 生成任务不会因为切页签而中断。
 */
export default function GitViewTabs({ view, onChange, stashCount, showCount }: GitViewTabsProps) {
  const { t } = useI18n();
  const commitRef = useRef<HTMLButtonElement>(null);
  const stashRef = useRef<HTMLButtonElement>(null);

  /** 只有两个页签，方向键即对调；切换顺手把焦点带过去。 */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, next: GitView) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onChange(next);
    (next === "commit" ? commitRef : stashRef).current?.focus();
  };

  return (
    <div className={styles.root} role="tablist" aria-label={t("panel.commit")}>
      <button
        ref={commitRef}
        type="button"
        role="tab"
        aria-selected={view === "commit"}
        tabIndex={view === "commit" ? 0 : -1}
        className={clsx(styles.tab, view === "commit" && styles.isSelected)}
        onClick={() => onChange("commit")}
        onKeyDown={(event) => onKeyDown(event, "stash")}
      >
        <span className={styles.label}>{t("git.tabCommit")}</span>
      </button>
      <button
        ref={stashRef}
        type="button"
        role="tab"
        aria-selected={view === "stash"}
        tabIndex={view === "stash" ? 0 : -1}
        className={clsx(styles.tab, view === "stash" && styles.isSelected)}
        onClick={() => onChange("stash")}
        onKeyDown={(event) => onKeyDown(event, "commit")}
      >
        <span className={styles.label}>{t("git.tabStash")}</span>
        {showCount && stashCount > 0 ? (
          <span className={styles.count} aria-hidden="true">
            {stashCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
