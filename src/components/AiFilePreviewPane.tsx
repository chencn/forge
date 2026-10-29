import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "../lib/fs";
import { reconstructFileChange, type AiFilePreview } from "../lib/aiFilePreview";
import { applyFontMetrics, detachedState, EditorView, fromDiskText, highlightRange, scrollToPos } from "../lib/cmEditor";
import { languageForPath } from "../lib/editorEnv";
import { useI18n } from "../i18n";
import { useAiDiffViewMode } from "../lib/aiDiffView";
import AiDiffEditor from "./AiDiffEditor";

/** 独立只读 model：打开历史读取记录不能覆盖工作区编辑器里的未保存内容。 */
function ReadEditor({ preview, text, firstLine = 1 }: { preview: AiFilePreview; text: string; firstLine?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    applyFontMetrics(element, 13);
    // 行号：预览的是文件中间一段，就得写真实行号；整篇且没有起点信息的（改动的一侧未知）不写。
    const numbered = !(preview.kind === "change" && preview.start === undefined);
    const lines = fromDiskText(text).split("\n").length;
    const start = Math.min(lines, Math.max(1, (preview.start ?? 1) - firstLine + 1));
    const end = Math.min(lines, Math.max(start, (preview.end ?? preview.start ?? lines) - firstLine + 1));
    const state = detachedState(
      {
        path: preview.path,
        contents: text,
        language: languageForPath(preview.path),
        readOnly: true,
        tabSize: 4,
        lineNumberFormat: numbered ? (line) => String(firstLine + line - 1) : undefined,
        showLineNumbers: numbered,
      },
      // 读过的那一段整行上底色，行号那一栏留一条竖标。
      preview.kind === "read" ? [highlightRange(start, end)] : []
    );
    const view = new EditorView({ state, parent: element });
    scrollToPos(view, state.doc.line(start).from);
    return () => view.destroy();
  }, [preview, text, firstLine]);
  return <div className="ai-file-preview-editor" ref={host} />;
}

export default function AiFilePreviewPane({ preview, documentText }: { preview: AiFilePreview; documentText?: string }) {
  const { t } = useI18n();
  const [mode] = useAiDiffViewMode();
  const [loaded, setLoaded] = useState<{ text: string | null; error: string | null }>({ text: documentText ?? null, error: null });
  useEffect(() => {
    let cancelled = false;
    setLoaded({ text: documentText ?? null, error: null });
    if (documentText !== undefined) return;
    void readFile(preview.path).then(
      (file) => { if (!cancelled) setLoaded({ text: file.contents, error: null }); },
      (error: unknown) => { if (!cancelled) setLoaded({ text: null, error: String(error) }); },
    );
    return () => { cancelled = true; };
  }, [preview, documentText]);
  const sides = useMemo(() => preview.kind === "change" ? reconstructFileChange(preview, loaded.text ?? "") : null, [preview, loaded.text]);
  const patches = preview.patches ?? [];
  const partial = !sides && preview.kind === "change";
  return <section className="ai-file-preview-pane" aria-label={preview.path}>
    <header className="ai-file-preview-head">
      <span>{preview.path}</span>
      {preview.kind === "read" ? <span>{t("ai.filePreview.readRange", { start: preview.start ?? 1, end: preview.end ?? preview.start ?? loaded.text?.split(/\r?\n/).length ?? "?" })}</span> : null}
    </header>
    {loaded.error ? <p className="panel-note" role="status">{loaded.error}</p> : null}
    {loaded.text === null && !loaded.error && !sides ? <p className="panel-note" role="status">{t("ai.filePreview.loading")}</p>
      : preview.kind === "read" ? (loaded.text !== null || preview.source !== undefined ? <>
        {loaded.text === null ? <p className="panel-note">{t("ai.filePreview.readFragment")}</p> : null}
        <ReadEditor preview={preview} text={loaded.text ?? preview.source ?? ""} firstLine={loaded.text === null ? preview.start ?? 1 : 1} />
      </> : null)
      : sides ? <AiDiffEditor path={preview.path} original={sides.original} modified={sides.modified} sideBySide={mode === "split"} height="100%" revealChange />
      : <>
        {partial ? <p className="panel-note" role="status">{t("ai.filePreview.patchOnly")}</p> : null}
        <div className="ai-file-preview-patches">{patches.map((patch, index) => patch.diff
          ? <AiDiffEditor key={index} path={preview.path} diff={patch.diff} sideBySide={mode === "split"} height={patches.length === 1 ? "100%" : 320} revealChange />
          : patch.before !== undefined && patch.after !== undefined
            ? <AiDiffEditor key={index} path={preview.path} original={patch.before} modified={patch.after} sideBySide={mode === "split"} height={patches.length === 1 ? "100%" : 320} revealChange />
            // 缺失的一侧未知，不能用空字符串冒充，制造整文件新增/删除。
            : patch.before !== undefined || patch.after !== undefined ? <div key={index} style={{ height: patches.length === 1 ? "100%" : 320 }}>
              <ReadEditor preview={{ ...preview, start: patch.start }} text={patch.after ?? patch.before ?? ""} firstLine={patch.start ?? 1} />
            </div> : null)}</div>
      </>}
  </section>;
}
