import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "../lib/fs";
import { reconstructFileChange, type AiFilePreview } from "../lib/aiFilePreview";
import { useI18n } from "../i18n";
import { useAiDiffViewMode } from "../lib/aiDiffView";
import AiDiffEditor from "./AiDiffEditor";

/** 独立只读 model：打开历史读取记录不能覆盖工作区编辑器里的未保存内容。 */
function ReadEditor({ preview, text, firstLine = 1 }: { preview: AiFilePreview; text: string; firstLine?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void Promise.all([import("../lib/monacoEditor"), import("../lib/monacoEnv")]).then(([{ monaco }, { languageForPath, monoFont }]) => {
      if (cancelled || !host.current) return;
      const model = monaco.editor.createModel(text, languageForPath(preview.path));
      const editor = monaco.editor.create(host.current, {
        model, readOnly: true, automaticLayout: true, fontFamily: monoFont(), fontSize: 13,
        lineNumbers: preview.kind === "change" && preview.start === undefined ? "off" : (line) => String(firstLine + line - 1), minimap: { enabled: false },
        scrollBeyondLastLine: false, editContext: false,
      });
      const start = Math.min(model.getLineCount(), Math.max(1, (preview.start ?? 1) - firstLine + 1));
      const end = Math.min(model.getLineCount(), Math.max(start, (preview.end ?? preview.start ?? model.getLineCount()) - firstLine + 1));
      if (preview.kind === "read") editor.createDecorationsCollection([{
        range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
        options: {
          isWholeLine: true, className: "ai-file-read-highlight", linesDecorationsClassName: "ai-file-read-gutter",
          overviewRuler: { color: "#58a6ff80", position: monaco.editor.OverviewRulerLane.Full },
        },
      }]);
      editor.revealLineInCenter(start);
      dispose = () => { editor.dispose(); model.dispose(); };
    });
    return () => { cancelled = true; dispose?.(); };
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
