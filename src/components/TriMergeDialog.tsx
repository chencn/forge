/**
 * 三栏合并编辑器：Yours | Result | Theirs。
 * 结果栏从「冲突块填 base」的形态起步（不留标记），
 * 每个未解决冲突上方挂着取舍按钮（采用本地/对方/两者/共同祖先），手动编辑也行——
 * 块范围随文档改动平移，改完点「应用解决」写回并交上层暂存。
 * 三方正文来自 index stage（git_conflict_versions），工作区文本只用来起步。
 */
import { useEffect, useRef, useState } from "react";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { useI18n } from "../i18n";
import { errorText, readFile, writeFile } from "../lib/fs";
import { parseSaveConflict } from "../lib/errors";
import { gitConflictVersions, type GitConflictVersions } from "../lib/git";
import { languageForPath } from "../lib/editorEnv";
import { languageOf } from "../lib/cmEditor";
import { initialResult, parseConflicts, resolutionText, type Resolution, type ResultConflict } from "../features/vcs/conflicts";

/** 一块被解决后把它的装饰与范围表清掉。 */
const resolvedConflict = StateEffect.define<number>();

/** 三方合并编辑器持有的状态：冲突清单 + 装饰 + 按钮文案。 */
interface ConflictField {
  conflicts: ResultConflict[];
  deco: DecorationSet;
  /** 取舍按钮的文案：构建结果编辑器时定一次，装饰随 field 渲染（对话框生命周期内语言不变）。 */
  labels: ActionsWidget["labels"];
}

/** 冲突块整段的行装饰（上色用）。 */
const conflictLine = Decoration.line({ class: "tri-merge-marker" });

/** 按冲突清单铺装饰：每块一个按钮 widget + 块内每行的底色标记。 */
function decorate(
  state: EditorState,
  conflicts: readonly ResultConflict[],
  labels: ActionsWidget["labels"],
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  conflicts.forEach((c, i) => {
    ranges.push({ from: c.from, to: c.from, value: Decoration.widget({ widget: new ActionsWidget(i, c.base !== null, labels), block: true, side: -1 }) });
    if (c.to <= c.from) return;
    const endLine = doc.lineAt(c.to - 1).number;
    for (let n = doc.lineAt(c.from).number; n <= endLine; n++) {
      ranges.push({ from: doc.line(n).from, to: doc.line(n).from, value: conflictLine });
    }
  });
  // set 的 sort 塔式排序兜住手动编辑造成的乱序：删掉块前的换行后块起点会落进行中间，
  // 行装饰位置反而小于块起点，RangeSetBuilder 的顺序断言会直接把编辑器打崩。
  return Decoration.set(ranges, true);
}

/** 未解决冲突随文档改动平移；被按钮解决掉的整块移出清单。 */
const conflictField = StateField.define<ConflictField>({
  create: () => ({ conflicts: [], deco: Decoration.none, labels: { ours: "", theirs: "", both: "", base: "" } }),
  update(value, tr) {
    const done = new Set(tr.effects.filter((e) => e.is(resolvedConflict)).map((e) => e.value as number));
    let conflicts = value.conflicts.filter((_, i) => !done.has(i));
    if (tr.docChanged) {
      conflicts = conflicts.map((c) => ({
        ...c,
        from: tr.changes.mapPos(c.from, -1),
        to: tr.changes.mapPos(c.to, 1),
      }));
    }
    if (!tr.docChanged && done.size === 0) return value;
    return { conflicts, deco: decorate(tr.state, conflicts, value.labels), labels: value.labels };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

/** 冲突上方的取舍按钮条（块索引在渲染时从当前 field 清单里反查）。 */
class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly hasBase: boolean,
    readonly labels: Record<"ours" | "theirs" | "both" | "base", string>,
  ) {
    super();
  }
  eq(other: ActionsWidget) {
    return other.index === this.index && other.hasBase === this.hasBase;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "tri-merge-actions";
    const add = (label: string, how: Resolution) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      // 点击时不把焦点从编辑器抢走。
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = (event) => {
        event.preventDefault();
        const current = view.state.field(conflictField).conflicts[this.index];
        if (!current) return;
        view.dispatch({
          changes: { from: current.from, to: current.to, insert: resolutionText(current, how) },
          effects: resolvedConflict.of(this.index),
        });
      };
      el.append(button);
    };
    add(this.labels.ours, "ours");
    add(this.labels.theirs, "theirs");
    add(this.labels.both, "both");
    if (this.hasBase) add(this.labels.base, "base");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** {@link TriMergeDialog} 的入参。 */
interface TriMergeDialogProps {
  /** 仓库根（git_conflict_versions 要拿 index stage）。 */
  root: string;
  path: string;
  onApplied: () => void;
  onClose: () => void;
  reportError: (message: string, title?: string) => void;
}

/** 三方合并对话框：两侧编辑器点按钮取舍，写入结果并落盘。 */
export default function TriMergeDialog({ root, path, onApplied, onClose, reportError }: TriMergeDialogProps) {
  const { t } = useI18n();
  const [data, setData] = useState<(GitConflictVersions & { working: string }) | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  /** 磁盘在编辑期间被外部改过：不关框弃稿，也不静默覆盖，交给用户选重载还是强制。 */
  const [stale, setStale] = useState<{ diskMs: number } | null>(null);
  const oursRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const resultViewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    let stale = false;
    Promise.all([gitConflictVersions(root, path), readFile(path)])
      .then(([versions, file]) => {
        if (!stale) setData({ ...versions, working: file.contents });
      })
      .catch((cause: unknown) => {
        if (!stale) {
          reportError(errorText(cause));
          onClose();
        }
      });
    return () => {
      stale = true;
    };
  }, [root, path, onClose, reportError]);

  useEffect(() => {
    if (!data || !oursRef.current || !theirsRef.current || !resultRef.current) return;
    const language = languageOf(languageForPath(path), path);
    const side: Extension[] = [EditorView.editable.of(false), EditorView.lineWrapping];
    if (language) side.push(language);
    const ours = new EditorView({ doc: data.ours, parent: oursRef.current, extensions: side });
    const theirs = new EditorView({ doc: data.theirs, parent: theirsRef.current, extensions: side });

    const start = initialResult(data.working, data.reversed);
    const labels = {
      ours: t("git.triMergeYours"),
      theirs: t("git.triMergeTheirs"),
      both: t("git.blockBoth"),
      base: t("git.blockBase"),
    };
    const result = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        conflictField.init((state) => ({
          conflicts: start.conflicts,
          deco: decorate(state, start.conflicts, labels),
          labels,
        })),
        EditorView.updateListener.of(() => {
          const field = result.state.field(conflictField, false);
          if (field) setRemaining(field.conflicts.length);
        }),
        history(),
        keymap.of(historyKeymap),
        EditorView.lineWrapping,
        ...(language ? [language] : []),
      ],
    });
    resultViewRef.current = result;
    // updateListener 只在首个事务后触发，这里先把起步计数报出来，底栏不留空窗。
    setRemaining(start.conflicts.length);
    return () => {
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultViewRef.current = null;
    };
    // labels 随语言重取：对话框生命周期内语言不会变，依赖只挂 data/path。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async () => {
    const view = resultViewRef.current;
    // 结果编辑器从打开那一刻的工作区文本起步：磁盘若在窗口期被外部改过，照写会把
    // 外部改动吞掉、照关框会把用户的合并成果丢掉——都不行。命中就亮出选择条，
    // 由用户决定「重新载入外部版本」还是「应用我的结果」。
    if (!view || applying || !data) return;
    setApplying(true);
    try {
      const file = await readFile(path);
      if (file.contents !== data.working) {
        setStale({ diskMs: file.modifiedMs });
        return;
      }
      // 未解决的块保留 base 段：用户可以先全部取舍，也可以直接应用。
      await writeFile(path, view.state.doc.toString(), file.lineEnding, file.hasBom, file.encoding, file.modifiedMs);
      onApplied();
    } catch (cause: unknown) {
      // 写回时乐观锁拒了（读后写之间被外部改）：与 stale 同一条收敛路径。
      const conflict = parseSaveConflict(errorText(cause));
      if (conflict) {
        setStale({ diskMs: conflict.diskMs });
        return;
      }
      reportError(errorText(cause));
    } finally {
      setApplying(false);
    }
  };

  /** 丢弃本次合并结果，用磁盘上的新文本重建三栏。applying 一并挡住：重载期间
   *  不让「应用」用旧 data.working 再比一次、再亮一次选择条。 */
  const reloadExternal = async () => {
    if (applying) return;
    setApplying(true);
    setStale(null);
    try {
      const [versions, file] = await Promise.all([gitConflictVersions(root, path), readFile(path)]);
      setData({ ...versions, working: file.contents });
    } catch (cause: unknown) {
      reportError(errorText(cause));
    } finally {
      setApplying(false);
    }
  };

  /** 仍以本对话框里的结果为准写回（覆盖外部改动）：mtime 取此刻的磁盘值。 */
  const applyAnyway = async () => {
    const view = resultViewRef.current;
    if (!view || applying) return;
    setApplying(true);
    try {
      const file = await readFile(path);
      await writeFile(path, view.state.doc.toString(), file.lineEnding, file.hasBom, file.encoding, file.modifiedMs);
      setStale(null);
      onApplied();
    } catch (cause: unknown) {
      reportError(errorText(cause));
    } finally {
      setApplying(false);
    }
  };

  const parseHint = data && parseConflicts(data.working).length === 0;

  return (
    <div className="dialog-backdrop is-wide" onClick={onClose}>
      <div className="dialog tri-merge" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t("git.triMergeTitle")}>
        <p className="dialog-title">{t("git.triMergeTitle")}</p>
        <p className="panel-note" style={{ margin: "0 16px" }}>
          {path}
        </p>
        <div className="tri-merge-heads">
          <span className="tri-merge-head is-ours">{t("git.triMergeYours")}</span>
          <span className="tri-merge-head is-result">{t("git.triMergeResult")}</span>
          <span className="tri-merge-head is-theirs">{t("git.triMergeTheirs")}</span>
        </div>
        <div className="tri-merge-panes">
          <div ref={oursRef} className="tri-merge-pane is-ours" />
          <div ref={resultRef} className="tri-merge-pane is-result" />
          <div ref={theirsRef} className="tri-merge-pane is-theirs" />
        </div>
        {stale ? (
          <div className="tri-merge-stale" role="alert">
            <span>{t("git.triMergeStale")}</span>
            <div>
              <button type="button" className="button" disabled={applying} onClick={() => void reloadExternal()}>
                {t("git.triMergeReload")}
              </button>
              <button type="button" className="button is-primary" disabled={applying} onClick={() => void applyAnyway()}>
                {t("git.triMergeApplyAnyway")}
              </button>
            </div>
          </div>
        ) : null}
        <div className="tri-merge-foot">
          <span>
            {remaining === 0
              ? t("git.triMergeAllResolved")
              : remaining === null
                ? ""
                : t("git.triMergeRemaining").replace("{n}", String(remaining))}
          </span>
          <div className="dialog-actions" style={{ margin: 0 }}>
            <button type="button" className="button" onClick={onClose}>
              {t("dialog.cancel")}
            </button>
            <button type="button" className="button is-primary" disabled={applying || Boolean(parseHint)} onClick={() => void apply()}>
              {t("git.blockApply")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
