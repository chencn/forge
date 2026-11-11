import { useEffect, useMemo, useRef, useState } from "react";
import { Compartment } from "@codemirror/state";
import { readFile } from "../lib/fs";
import { reconstructFileChange, type AiFilePreview } from "../lib/aiFilePreview";
import { applyFontMetrics, detachedState, EditorView, fromDiskText, highlightRange, languageOf, loadLanguage, scrollToPos } from "../lib/cmEditor";
import { languageForPath } from "../lib/editorEnv";
import { useI18n } from "../i18n";
import { useAiDiffViewMode } from "../lib/aiDiffView";
import AiDiffEditor from "./AiDiffEditor";

/**
 * 创建独立只读文件预览，并在语法加载完成后补上高亮。
 *
 * @param props - 读取记录、正文与片段起始行号；firstLine 默认 1
 * @returns 只读编辑器宿主；卸载时释放实例并忽略迟到的语法加载结果
 * @remarks 语法通过局部槽位更新，保留选区和滚动位置，也不占用工作区的文档状态。
 */
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
    /** 当前文件的语言标识；语法包可能尚未加载。 */
    const language = languageForPath(preview.path);
    /** 迟到的语法只更新本预览，不重建正文或改变阅读位置。 */
    const syntax = new Compartment();
    /** 切换文件或关闭后禁止向已经销毁的编辑器派发。 */
    let disposed = false;
    const state = detachedState(
      {
        path: preview.path,
        contents: text,
        language,
        readOnly: true,
        tabSize: 4,
        lineNumberFormat: numbered ? (line) => String(firstLine + line - 1) : undefined,
        showLineNumbers: numbered,
      },
      // 读过的那一段整行上底色，行号那一栏留一条竖标。
      [syntax.of([]), ...(preview.kind === "read" ? [highlightRange(start, end)] : [])]
    );
    const view = new EditorView({ state, parent: element });
    scrollToPos(view, state.doc.line(start).from);
    if (!languageOf(language, preview.path)) void loadLanguage(language, preview.path).then((support) => {
      if (!support || disposed) return;
      view.dispatch({ effects: syntax.reconfigure(support) });
    });
    return () => { disposed = true; view.destroy(); };
  }, [preview, text, firstLine]);
  return <div className="ai-file-preview-editor" ref={host} />;
}

/** 文件改动预览窗格：按当前差异视图模式渲染工具改动的文件。 */
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
    <header className="ai-file-preview-head" data-copy-text={preview.path} title={preview.path}>
      <span data-copy-text={preview.path}>{preview.path}</span>
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
