import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AlignLeft, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2, ExternalLink, Lock, X } from "lucide-react";
import PaneNotice from "./PaneNotice";
import { createDiffView, type DiffNav, type DiffView } from "../lib/cm/diffView";
import { useI18n } from "../i18n";

/** 一次比对所属的那一串文件：那两枚左右箭头沿这一串走，一串只有一篇时不摆箭头。 */
export interface DiffGroup {
  /** 现在第几篇，0 起。 */
  index: number;
  /** 这一串一共几篇。 */
  total: number;
  /**
   * 上一篇。给了 `land` 就是上下箭头走到本篇尽头转过来的，要落在那一篇的最后一处差异上；
   * 不给就是左右箭头本身换篇，从篇首看起。第一篇时不会被调到。
   */
  onPrev: (land?: "last") => void;
  /** 下一篇，`land` 同 onPrev 那一档意思。最后一篇时不会被调到。 */
  onNext: (land?: "first") => void;
}

interface DiffPaneProps {
  /** 左边那一栏的表头：这一侧是哪个版本（HEAD、索引、短哈希）。 */
  leftLabel: string;
  /** 右边那一栏的表头。 */
  rightLabel: string;
  /** 比对的是哪条路径，跟在左侧表头后面；重命名带 `旧 → 新`。 */
  path: string;
  /** 基线文本（左侧）。 */
  original: string;
  /** 当前文本（右侧）。 */
  modified: string;
  language: string;
  /** 有值时这次比对打不开（二进制、图片），正文区摆这句说明，不建编辑器也不摆导航。 */
  notice?: string;
  /** 这篇文件所在的串；给不出来就没有左右箭头，跟没有这条链时一样。 */
  group?: DiffGroup;
  /** 这一篇算完差异后把光标落到首 / 末那一处：上下箭头从邻篇转过来才带。 */
  landOn?: "first" | "last";
  /** 跳到源码：把工作区里那一份开进编辑器。工作区里没有对应文件时不给。 */
  onOpenFile?: () => void;
  onClose: () => void;
}

/** 一侧表头那一行：只读锁标 + 这一侧的版本名，左侧再跟上那条路径。 */
function sideRow(label: string, path?: string) {
  return (
    <span className="diff-side-row">
      <Lock size={12} aria-hidden="true" />
      {label ? <span className="diff-rev">{label}</span> : null}
      {path ? <span className="diff-path">{path}</span> : null}
    </span>
  );
}

function DiffPane({
  leftLabel,
  rightLabel,
  path,
  original,
  modified,
  language,
  notice,
  group,
  landOn,
  onOpenFile,
  onClose,
}: DiffPaneProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DiffView | null>(null);
  /** 差异条数与本篇可走情况；null 是那一份视图还没建起来的状态，此时既不报条数也不让走。 */
  const [nav, setNav] = useState<DiffNav | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  /** 排法要活过重挂：换一篇文件会重建视图，创建参数得带着当前这一档。 */
  const sideBySideRef = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    // 打不开的比对不建编辑器；notice 一出现 host 就不再挂载了。
    if (!host || notice) return;

    const view = createDiffView({
      parent: host,
      original,
      modified,
      language,
      path,
      mode: sideBySideRef.current ? "side" : "unified",
      onNav: setNav,
    });
    viewRef.current = view;
    // 上下箭头从邻篇转过来时，落在这篇的首 / 末那一处差异。差异是同步算完的，建好就能落。
    if (landOn) view.land(landOn);

    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [landOn, language, modified, notice, original, path]);

  /** 换排法：两栏与单栏是两台不同的视图，由这一层自己重建，React 这边只换档。 */
  const setMode = useCallback((next: boolean) => {
    sideBySideRef.current = next;
    setSideBySide(next);
    viewRef.current?.setMode(next ? "side" : "unified");
  }, []);

  const count = nav?.count ?? 0;
  /** 链上还有没有相邻那一篇。 */
  const filePrev = (group?.index ?? 0) > 0;
  const fileNext = !!group && group.index < group.total - 1;
  const canPrev = !!nav && (nav.previous || filePrev);
  const canNext = !!nav && (nav.next || fileNext);

  /**
   * 上一处 / 下一处。本篇还有就走本篇，走到头了转到链上相邻那一篇，并落在那一篇的首 / 末一处上——
   * IDEA 的「走到最后一处差异之后再走就换文件」那条默认就是这半句。
   */
  const goDiff = (target: "next" | "previous") => {
    if (target === "next") {
      if (nav?.next) viewRef.current?.go("next");
      else group?.onNext("first");
      return;
    }
    if (nav?.previous) viewRef.current?.go("previous");
    else group?.onPrev("last");
  };

  /** 右那一侧的表头：根提交那类没有名字的侧不出这一行。 */
  const rightSideRow = rightLabel ? sideRow(rightLabel) : null;

  return (
    <section className="diff-pane">
      <header className="diff-head">
        {notice ? null : (
          <>
            <div className="diff-group">
              <button
                type="button"
                className="icon-button is-inline"
                onClick={() => goDiff("previous")}
                disabled={!canPrev}
                data-tip={t("diff.prevChange")}
                aria-label={t("diff.prevChange")}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button is-inline"
                onClick={() => goDiff("next")}
                disabled={!canNext}
                data-tip={t("diff.nextChange")}
                aria-label={t("diff.nextChange")}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            </div>
            <span className="diff-sep" aria-hidden="true" />
            {onOpenFile ? (
              <button
                type="button"
                className="icon-button is-inline"
                onClick={onOpenFile}
                data-tip={t("diff.jumpToSource")}
                aria-label={t("diff.jumpToSource")}
              >
                <ExternalLink size={14} aria-hidden="true" />
              </button>
            ) : null}
            {group ? (
              <>
                <span className="diff-sep" aria-hidden="true" />
                <div className="diff-group">
                  {/* 一串只有一篇时不摆那两枚箭头：IDEA 只在链条能走的时候才给这一对。 */}
                  {group.total > 1 ? (
                    <button
                      type="button"
                      className="icon-button is-inline"
                      onClick={() => group.onPrev()}
                      disabled={group.index <= 0}
                      data-tip={t("diff.prevFile")}
                      aria-label={t("diff.prevFile")}
                    >
                      <ArrowLeft size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                  <span className="diff-counter">
                    {group.total === 1
                      ? t("diff.files.one")
                      : t("diff.files.many", { total: group.total, index: group.index + 1 })}
                  </span>
                  {group.total > 1 ? (
                    <button
                      type="button"
                      className="icon-button is-inline"
                      onClick={() => group.onNext()}
                      disabled={group.index >= group.total - 1}
                      data-tip={t("diff.nextFile")}
                      aria-label={t("diff.nextFile")}
                    >
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
        <span className="diff-sep" aria-hidden="true" />
        <button
          type="button"
          className="icon-button is-inline"
          onClick={onClose}
          data-tip={t("editor.closeDiff")}
          aria-label={t("editor.closeDiff")}
        >
          <X size={14} aria-hidden="true" />
        </button>

        <div className="diff-head-end">
          {notice || nav === null ? null : (
            <span className="diff-counter">
              {count === 0
                ? t("diff.changes.none")
                : count === 1
                  ? t("diff.changes.one")
                  : t("diff.changes.many", { count })}
            </span>
          )}
          {notice ? null : (
            <div className="diff-mode" role="group" aria-label={t("diff.mode")}>
              <button
                type="button"
                className={`diff-mode-button${sideBySide ? " is-active" : ""}`}
                onClick={() => setMode(true)}
                data-tip={t("diff.modeSide")}
                aria-label={t("diff.modeSide")}
                aria-pressed={sideBySide}
              >
                <Columns2 size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`diff-mode-button${sideBySide ? "" : " is-active"}`}
                onClick={() => setMode(false)}
                data-tip={t("diff.modeUnified")}
                aria-label={t("diff.modeUnified")}
                aria-pressed={!sideBySide}
              >
                <AlignLeft size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </header>

      {notice ? (
        <PaneNotice text={notice} />
      ) : (
        <>
          {/* 每一侧的表头挂在各自那一栏上沿，跟它底下那个编辑区对齐，不是一条横跨的通栏。 */}
          <div className="diff-sides">
            <span className="diff-side">
              {leftLabel || path ? sideRow(leftLabel, path) : null}
              {sideBySide ? null : rightSideRow}
            </span>
            {sideBySide ? <span className="diff-side">{rightSideRow}</span> : null}
          </div>
          <div ref={hostRef} className="diff-host" />
        </>
      )}
    </section>
  );
}

/** 比对视图自己管更新，外层重渲染不该把它整份重建。 */
export default memo(DiffPane);
