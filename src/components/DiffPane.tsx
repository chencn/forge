import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronsDownUp,
  Columns2,
  ListOrdered,
  Pencil,
  Plus,
  RefreshCw,
  Redo2,
} from "lucide-react";
import PaneNotice from "./PaneNotice";
import {
  createDiffView,
  type DiffDir,
  type DiffHighlight,
  type DiffNav,
  type DiffView,
  type DiffWhitespace,
} from "../lib/cm/diffView";
import { buildChunkPatch } from "../lib/cm/chunkPatch";
import { useI18n } from "../i18n";

/** 一次比对所属的那一串：F7 走到头再按一次就换到这一串的相邻一篇。 */
export interface DiffGroup {
  /** 现在第几篇，0 起。 */
  index: number;
  /** 这一串一共几篇。 */
  total: number;
  /**
   * 上一篇。给了 `land` 就是 F7 走到本篇尽头转过来的，要落在那一篇的最后一处差异上；
   * 不给就是跨篇换档，从篇首看起。第一篇时不会被调到。
   */
  onPrev: (land?: "last") => void;
  /** 下一篇，`land` 同 onPrev 那一档意思。最后一篇时不会被调到。 */
  onNext: (land?: "first") => void;
}

interface DiffPaneProps {
  /** 左边那一栏的表头：这一侧是哪个版本（HEAD、Staged (index)、短哈希）。 */
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
  /** 这篇文件所在的串；给不出来 F7 走到头就停在原地。 */
  group?: DiffGroup;
  /** 这一篇算完差异后把光标落到首 / 末那一处：跨篇转过来才带。 */
  landOn?: "first" | "last";
  /** 跳到源码：把工作区里那一份开进编辑器。工作区里没有对应文件时不给。 */
  onOpenFile?: () => void;
  /** 按块暂存：把光标那块打回索引（`git apply --cached`）。只在工作区比对给。 */
  onStageChunk?: (patch: string) => void;
  /** 按块回退：把光标那块从工作区里撤掉（`git apply -R`）。只在工作区比对给。 */
  onRevertChunk?: (patch: string) => void;
  /** 重开这一篇（同链同篇重读一遍）。 */
  onRefresh?: () => void;
}

/** 一侧表头那一行：版本名 + 可选徽章，左侧再跟上那条路径。 */
function sideRow(label: string, path?: string, badge?: string) {
  return (
    <span className="diff-side-row">
      {label ? <span className="diff-rev">{label}</span> : null}
      {path ? <span className="diff-path">{path}</span> : null}
      {badge ? <span className="diff-side-badge">{badge}</span> : null}
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
  onStageChunk,
  onRevertChunk,
  onRefresh,
}: DiffPaneProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DiffView | null>(null);
  /** 差异条数与本篇可走情况；null 是那一份视图还没建起来的状态，此时既不报条数也不让走。 */
  const [nav, setNav] = useState<DiffNav | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  /** 排法要活过重挂：换一篇文件会重建视图，创建参数得带着当前这一档。 */
  const sideBySideRef = useRef(true);
  const [highlight, setHighlight] = useState<DiffHighlight>("words");
  const [collapse, setCollapse] = useState(true);
  const highlightRef = useRef(highlight);
  const collapseRef = useRef(collapse);
  const [whitespace, setWhitespace] = useState<DiffWhitespace>("default");
  const whitespaceRef = useRef(whitespace);
  const [syncScroll, setSyncScroll] = useState(true);
  const syncScrollRef = useRef(syncScroll);
  /** 按块操作的回调走 ref：视图只建一次，回调换档不用重建。 */
  const stageRef = useRef(onStageChunk);
  const revertRef = useRef(onRevertChunk);
  stageRef.current = onStageChunk;
  revertRef.current = onRevertChunk;
  /** 「再按一次转到下一个文件」那颗气泡；2.5 秒内第二下才真的换篇。 */
  const [chainHint, setChainHint] = useState(false);
  const chainAtRef = useRef(0);

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
      highlight: highlightRef.current,
      collapse: collapseRef.current,
      whitespace: whitespaceRef.current,
      syncScroll: syncScrollRef.current,
      onNav: setNav,
      onStep: (dir) => stepChain(dir),
      onJumpSource: onOpenFile,
      // 行内 ‹ › 控件：补丁在这里生成，落地走调用方的回调（ref 取最新那份）。
      onChunkOp:
        onStageChunk || onRevertChunk
          ? (op, patch) => void (op === "stage" ? stageRef.current?.(patch) : revertRef.current?.(patch))
          : undefined,
      chunkLabels: { stage: t("diff.stageChunk"), revert: t("diff.revertChunk") },
    });
    viewRef.current = view;
    // 跨篇转过来时，落在这篇的首 / 末那一处差异。差异是同步算完的，建好就能落。
    if (landOn) view.land(landOn);

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landOn, language, modified, notice, original, path]);

  /** 换排法：两栏与单栏是两台不同的视图，由这一层自己重建，React 这边只换档。 */
  const setMode = useCallback((next: boolean) => {
    sideBySideRef.current = next;
    setSideBySide(next);
    viewRef.current?.setMode(next ? "side" : "unified");
  }, []);

  /** 高亮 / 折叠这两档走 setPresentation：同一台视图重建，光标留住。 */
  const setHighlightMode = useCallback((next: DiffHighlight) => {
    highlightRef.current = next;
    setHighlight(next);
    viewRef.current?.setPresentation({ highlight: next });
  }, []);
  const setCollapseMode = useCallback((next: boolean) => {
    collapseRef.current = next;
    setCollapse(next);
    viewRef.current?.setPresentation({ collapse: next });
  }, []);
  const setWhitespaceMode = useCallback((next: DiffWhitespace) => {
    whitespaceRef.current = next;
    setWhitespace(next);
    viewRef.current?.setPresentation({ whitespace: next });
  }, []);
  const setSyncScrollMode = useCallback((next: boolean) => {
    syncScrollRef.current = next;
    setSyncScroll(next);
    viewRef.current?.setPresentation({ syncScroll: next });
  }, []);

  const count = nav?.count ?? 0;

  /**
   * F7 / ⇧F7 与上一处 / 下一处：本篇还有就走本篇；走到头了，2.5 秒内再按一下
   * 才转到链上相邻那一篇（IDEA 的「Press again to go to the next file」）。
   */
  const stepChain = (target: DiffDir) => {
    const view = viewRef.current;
    if (view?.canGo(target)) {
      view.go(target);
      return;
    }
    if (!group) return;
    const now = Date.now();
    if (now - chainAtRef.current > 2500) {
      chainAtRef.current = now;
      setChainHint(true);
      window.setTimeout(() => setChainHint(false), 2500);
      return;
    }
    chainAtRef.current = 0;
    setChainHint(false);
    if (target === "next") group.onNext("first");
    else group.onPrev("last");
  };

  /** 光标所在（或下一处）的差异块；块操作两颗按钮的落点。 */
  const activeChunk = useMemo(() => viewRef.current?.currentChunk() ?? { index: 0, chunk: null }, [nav]);

  const canRevert = !!onRevertChunk && !!activeChunk.chunk;
  const canStage = !!onStageChunk && !!activeChunk.chunk;

  const applyStage = () => {
    const chunk = viewRef.current?.currentChunk().chunk;
    if (!chunk || !onStageChunk) return;
    onStageChunk(buildChunkPatch(path, original, modified, chunk));
  };
  const applyRevert = () => {
    const chunk = viewRef.current?.currentChunk().chunk;
    if (!chunk || !onRevertChunk) return;
    onRevertChunk(buildChunkPatch(path, original, modified, chunk));
  };

  /** 右那一侧的表头：根提交那类没有名字的侧不出这一行。 */
  // 右侧是工作区那份时挂「working copy」徽章（IDEA 的比对窗口）。
  const rightSideRow = rightLabel
    ? sideRow(
        rightLabel,
        undefined,
        rightLabel === t("git.revWorktree") ? t("diff.workingCopy") : undefined
      )
    : null;

  return (
    <section className="diff-pane">
      <header className="diff-head">
        {notice ? null : (
          <>
            <button
              type="button"
              className="icon-button is-inline"
              onClick={() => stepChain("previous")}
              disabled={!nav || (!nav.previous && !group)}
              data-tip={t("diff.prevChange")}
              aria-label={t("diff.prevChange")}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button is-inline"
              onClick={() => stepChain("next")}
              disabled={!nav || (!nav.next && !group)}
              data-tip={t("diff.nextChange")}
              aria-label={t("diff.nextChange")}
            >
              <ArrowDown size={14} aria-hidden="true" />
            </button>
            {onOpenFile ? (
              <button
                type="button"
                className="icon-button is-inline"
                onClick={onOpenFile}
                data-tip={t("diff.jumpToSource")}
                aria-label={t("diff.jumpToSource")}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
            ) : null}
            <span className="diff-sep" aria-hidden="true" />
            <button
              type="button"
              className={`icon-button is-inline${sideBySide ? " is-pressed" : ""}`}
              onClick={() => setMode(true)}
              data-tip={t("diff.modeSide")}
              aria-label={t("diff.modeSide")}
              aria-pressed={sideBySide}
            >
              <Columns2 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-button is-inline${sideBySide ? "" : " is-pressed"}`}
              onClick={() => setMode(false)}
              data-tip={t("diff.modeUnified")}
              aria-label={t("diff.modeUnified")}
              aria-pressed={!sideBySide}
            >
              <ListOrdered size={14} aria-hidden="true" />
            </button>
            <span className="diff-sep" aria-hidden="true" />
            <label className="diff-select-wrap" aria-label={t("diff.ignoreWhitespace")}>
              <select
                className="diff-select"
                value={whitespace}
                onChange={(event) => setWhitespaceMode(event.target.value as DiffWhitespace)}
                data-tip={t("diff.ignoreWhitespace")}
              >
                <option value="default">{t("diff.wsKeep")}</option>
                <option value="trim">{t("diff.wsTrim")}</option>
                <option value="ignore">{t("diff.wsIgnore")}</option>
                <option value="ignoreEmptyLines">{t("diff.wsEmpty")}</option>
              </select>
            </label>
            <label className="diff-select-wrap" aria-label={t("diff.highlighting")}>
              <select
                className="diff-select"
                value={highlight}
                onChange={(event) => setHighlightMode(event.target.value as DiffHighlight)}
                data-tip={t("diff.highlighting")}
              >
                <option value="words">{t("diff.highlightWords")}</option>
                <option value="lines">{t("diff.highlightLines")}</option>
                <option value="none">{t("diff.highlightNone")}</option>
              </select>
            </label>
            <button
              type="button"
              className={`icon-button is-inline${collapse ? " is-pressed" : ""}`}
              onClick={() => setCollapseMode(!collapse)}
              data-tip={t("diff.collapseUnchanged")}
              aria-label={t("diff.collapseUnchanged")}
              aria-pressed={collapse}
            >
              <ChevronsDownUp size={14} aria-hidden="true" />
            </button>
            {/* 同步滚动只在双栏有意义：单栏只有一份正文，档位收起来。 */}
            {sideBySide ? (
              <button
                type="button"
                className={`icon-button is-inline${syncScroll ? " is-pressed" : ""}`}
                onClick={() => setSyncScrollMode(!syncScroll)}
                data-tip={t("diff.syncScroll")}
                aria-label={t("diff.syncScroll")}
                aria-pressed={syncScroll}
              >
                <ArrowDownUp size={14} aria-hidden="true" />
              </button>
            ) : null}
            {(onRevertChunk || onStageChunk) && (
              <>
                <span className="diff-sep" aria-hidden="true" />
                {onRevertChunk ? (
                  <button
                    type="button"
                    className="icon-button is-inline"
                    onClick={applyRevert}
                    disabled={!canRevert}
                    data-tip={t("diff.revertChunk")}
                    aria-label={t("diff.revertChunk")}
                  >
                    <Redo2 size={14} aria-hidden="true" />
                  </button>
                ) : null}
                {onStageChunk ? (
                  <button
                    type="button"
                    className="icon-button is-inline"
                    onClick={applyStage}
                    disabled={!canStage}
                    data-tip={t("diff.stageChunk")}
                    aria-label={t("diff.stageChunk")}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </>
            )}
            {onRefresh ? (
              <>
                <span className="diff-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="icon-button is-inline"
                  onClick={onRefresh}
                  data-tip={t("tool.refresh")}
                  aria-label={t("tool.refresh")}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </>
        )}
        <div className="diff-head-end">
          {notice || nav === null ? null : (
            <span className="diff-counter">
              {count === 0
                ? original === modified || whitespaceRef.current !== "default"
                  ? t("diff.identical")
                  : t("diff.noChanges")
                : nav.index > 0
                  ? t("diff.changesOf", { index: nav.index, count })
                  : count === 1
                    ? t("diff.changes.one")
                    : t("diff.changes.many", { count })}
            </span>
          )}
        </div>
      </header>

      {notice ? (
        <PaneNotice text={notice} />
      ) : (
        <>
          {chainHint ? <div className="diff-nav-hint">{t("diff.chainHint")}</div> : null}
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
