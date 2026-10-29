import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { EditorView, applyFontMetrics, detachedState, textOf, textReplacement } from "../lib/cmEditor";
import { errorText, readFile, type FileContent } from "../lib/fs";
import { useI18n } from "../i18n";
import {
  flattenMerge,
  renderWithMarkers,
  threeWayMerge,
  type ConflictChoice,
  type MergeResult,
} from "../lib/merge";
import type { SaveConflictInfo } from "../hooks/useDocuments";

/**
 * 保存冲突时的三向合并对话框（`docs/features/code-editor/merge-and-local-history.md` 的 A 方案）。
 *
 * 上面两格只读，给「本地手里那份」与「磁盘现在那份」，都对着共同祖先（上次保存的那份）算：
 * 底下那一整格可编辑，默认填带冲突标记的合并文本（`<<<<<<< / ======= / >>>>>>>`），
 * 人删掉不要的一侧、抹掉标记即可。三颗快捷按钮按合并块整体取本地 / 取磁盘 / 两边都要，覆盖结果格。
 *
 * 「保存」把结果格当前正文和本次读到的磁盘版本一起交出去，由上层再次做乐观锁校验后写盘。
 * 这里不做三栏合并控件——那是给「一次挑一块」用的，冲突块带标记铺进结果格让人直接删，
 * 对保存冲突这种「两份都得留」的场合更快，所以是「只读两份 + 一份可编辑」的拼法。
 */
interface MergeConflictDialogProps {
  conflict: SaveConflictInfo;
  /** 接受磁盘那份：把编辑器刷成读回来的磁盘内容并认领基线，不写盘。 */
  onAcceptDisk: (disk: FileContent) => void;
  /** 按结果格正文（或「保留我的」那份）写盘，并带回本次比较过的磁盘版本。 */
  onResolve: (result: string, disk: FileContent) => void;
  onCancel: () => void;
}

/**
 * 挂一台编辑器进 host：上面两格只读、下面结果格可编辑，配置只差在 readOnly 那一档。
 *
 * 正文不进常驻表（`detachedState`）：这几格对着的是磁盘那份与手里那份，跟工作区里
 * 同路径那篇不是同一份内容，共用一格会把那边的撤销栈与光标顶掉。
 */
function mountPane(
  host: HTMLElement,
  options: { text: string; language: string; readOnly: boolean; onChange?: (text: string) => void }
): { set: (text: string) => void; destroy: () => void } {
  applyFontMetrics(host, 12);
  const extra = options.onChange
    ? [EditorView.updateListener.of((update) => { if (update.docChanged) options.onChange!(textOf(update.view)); })]
    : [];
  const view = new EditorView({
    state: detachedState(
      {
        path: "",
        contents: options.text,
        language: options.language,
        readOnly: options.readOnly,
        tabSize: 4,
      },
      extra
    ),
    parent: host,
  });
  return {
    set: (text: string) => {
      const transaction = textReplacement(view.state, text);
      if (transaction) view.dispatch(transaction);
    },
    destroy: () => view.destroy(),
  };
}

/** 把每个冲突块按同一策略铺成 choices。 */
function fillChoices(result: MergeResult, choice: ConflictChoice): ConflictChoice[] {
  return new Array(result.conflicts).fill(choice);
}

function formatStamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

export default function MergeConflictDialog({
  conflict,
  onAcceptDisk,
  onResolve,
  onCancel,
}: MergeConflictDialogProps) {
  const { t } = useI18n();
  const oursHost = useRef<HTMLDivElement>(null);
  const theirsHost = useRef<HTMLDivElement>(null);
  const resultHost = useRef<HTMLDivElement>(null);
  /** 读回来的磁盘那份（含正文与新 mtime），读成了才有。 */
  const [disk, setDisk] = useState<FileContent | null>(null);
  /** 读磁盘失败时的说明。 */
  const [readError, setReadError] = useState<string | null>(null);
  /** 合并结果块序列，读完磁盘才算得出。 */
  const [merged, setMerged] = useState<MergeResult | null>(null);

  /** 结果格那台编辑器：三颗快捷按钮往它里换正文。 */
  const resultRef = useRef<{ set: (text: string) => void; destroy: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    readFile(conflict.path)
      .then((content) => {
        if (disposed) return;
        setDisk(content);
        setMerged(threeWayMerge(conflict.base, conflict.ours, content.contents));
      })
      .catch((cause) => {
        if (!disposed) setReadError(errorText(cause));
      });
    return () => {
      disposed = true;
    };
  }, [conflict.path, conflict.base, conflict.ours]);

  // 只读两格：本地手里那份与磁盘现在那份，正文换了重挂。
  useEffect(() => {
    if (!oursHost.current || !theirsHost.current) return;
    const ours = mountPane(oursHost.current, {
      text: conflict.ours,
      language: conflict.language,
      readOnly: true,
    });
    const theirs = mountPane(theirsHost.current, {
      text: disk ? disk.contents : "",
      language: conflict.language,
      readOnly: true,
    });
    return () => {
      ours.destroy();
      theirs.destroy();
    };
  }, [conflict.language, conflict.ours, disk]);

  // 结果格：默认正文是带标记的合并文本；用户后续手改由它自己的监听记着，不覆盖。
  const initialResult = merged ? renderWithMarkers(merged) : "";
  const resultTextRef = useRef<string>("");
  useEffect(() => {
    const host = resultHost.current;
    if (!host) return;
    resultTextRef.current = initialResult;
    const pane = mountPane(host, {
      text: initialResult,
      language: conflict.language,
      readOnly: false,
      onChange: (text) => {
        resultTextRef.current = text;
      },
    });
    resultRef.current = pane;
    return () => {
      resultRef.current = null;
      pane.destroy();
    };
    // 合并结果一旦算出就定型填进结果格；再读磁盘或换 conflict 由外层重开对话框，这里不重挂。
    // 依赖只认 initialResult：它在 merged 到位前一直是空串。
  }, [initialResult, conflict.language]);

  const overwrite = (text: string) => {
    resultRef.current?.set(text);
  };

  // Esc 关掉。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const ready = disk !== null && merged !== null && readError === null;

  return (
    <div className="dialog-backdrop is-wide" onMouseDown={onCancel}>
      <div
        className="dialog dialog-merge"
        role="dialog"
        aria-modal="true"
        aria-label={t("merge.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-merge-head">
          <p className="dialog-title">{t("merge.title", { name: conflict.name })}</p>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={t("dialog.cancel")}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        {readError ? (
          <p className="dialog-body is-error">{t("merge.readFailed", { detail: readError })}</p>
        ) : (
          <>
            <p className="dialog-note">{t("merge.body")}</p>
            <div className="dialog-merge-sides">
              <section className="dialog-merge-side">
                <p className="dialog-merge-side-title">
                  {t("merge.ours")}
                  <span className="dialog-merge-when">{formatStamp(conflict.baseMs)}</span>
                </p>
                <div ref={oursHost} className="dialog-merge-editor" />
              </section>
              <section className="dialog-merge-side">
                <p className="dialog-merge-side-title">
                  {t("merge.theirs")}
                  <span className="dialog-merge-when">{disk ? formatStamp(disk.modifiedMs) : ""}</span>
                </p>
                <div ref={theirsHost} className="dialog-merge-editor" />
              </section>
            </div>
            <div className="dialog-merge-actions">
              <button type="button" className="button is-inline" onClick={() => merged && overwrite(flattenMerge(merged, fillChoices(merged, "ours")))} disabled={!ready}>
                {t("merge.takeOurs")}
              </button>
              <button type="button" className="button is-inline" onClick={() => merged && overwrite(flattenMerge(merged, fillChoices(merged, "theirs")))} disabled={!ready}>
                {t("merge.takeTheirs")}
              </button>
              <button type="button" className="button is-inline" onClick={() => merged && overwrite(flattenMerge(merged, fillChoices(merged, "both")))} disabled={!ready}>
                {t("merge.takeBoth")}
              </button>
            </div>
            <section className="dialog-merge-result">
              <p className="dialog-merge-side-title">{t("merge.result")}</p>
              <div ref={resultHost} className="dialog-merge-editor dialog-merge-editor-tall" />
            </section>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            {t("dialog.cancel")}
          </button>
          {disk ? (
            <button type="button" className="button" onClick={() => onAcceptDisk(disk)} disabled={!ready}>
              {t("merge.acceptDisk")}
            </button>
          ) : null}
          <button type="button" className="button is-primary" onClick={() => disk && onResolve(resultTextRef.current, disk)} disabled={!ready}>
            {t("merge.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
