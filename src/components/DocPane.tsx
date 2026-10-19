import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code2, Columns2, Eye, Search } from "lucide-react";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import ImagePreview from "./ImagePreview";
import PaneNotice from "./PaneNotice";
import { canPreview } from "../hooks/useDocuments";
import { retainEditorModels } from "../lib/modelRetention";
import { disposeModel } from "../lib/monacoEnv";
import type { DocView, OpenDocument, RevealTarget } from "../hooks/useDocuments";
import type { DocKind } from "../lib/docKind";
import { describeError } from "../lib/errors";
import type { ChangeBaseline } from "../lib/lineChanges";
import type { RunConfiguration } from "../lib/runConfigs";
import { useI18n } from "../i18n";
import type { MarkdownPreviewHandle } from "./MarkdownPreview";

/** marked 与 DOMPurify 只在渲染预览时要用，跟着第一次切到预览那侧才取。 */
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

interface DocPaneProps {
  document: OpenDocument;
  onChange: (path: string, contents: string) => void;
  onSave: () => void;
  /** 编辑器失去焦点或从源码切向预览时触发（用于失焦自动保存）。 */
  onBlur?: () => void;
  onView: (path: string, view: DocView) => void;
  /** 点预览里的本地链接时打开它。 */
  onOpenLocal: (absolute: string) => void;
  /** 搜索命中的落点，只有源码视图用得上。 */
  reveal: RevealTarget | null;
  onRevealDone: () => void;
  /** 全工程识别出来的运行配置，装订线上那颗 ▶ 从这里面挑。 */
  runConfigs: RunConfiguration[];
  /** 工程根绝对路径。 */
  projectRoot: string;
  /** 还开着的文档路径。超出最近几篇的 Monaco model 按这个名单回收。 */
  openPaths: readonly string[];
  /** 点了装订线那颗 ▶：一条就直接跑，几条就开选择器让他挑。 */
  onRunConfig: (configs: RunConfiguration[]) => void;
  /** 点了脚本文件装订线那颗 ▶：把脚本发到对应终端里执行。 */
  onRunScript: (path: string) => void;
  /** 点了 `.http` / `.rest` 请求行上的 ▶。 */
  onRunHttp: (path: string, line: number, contents: string) => void;
  /**
   * 左右分栏时这一份请求对应的响应正文。
   * 为 null 表示不在右边挂响应（还没发送，或设置成了单独页签）。
   */
  httpResponse: string | null;
  /** 相对上次提交的基线。null 表示这篇不画改动。只给源码那台编辑器。 */
  changeBaseline: ChangeBaseline | null;
}

/**
 * 预览那侧的悬停文案，按类型给（markdown 是「预览」，svg 是「图片」）。
 *
 * 只有能预览的类型才画那颗按钮；其余类型到不了这里，退回「预览」即可。
 */
function previewLabel(kind: DocKind): "preview.markdown" | "preview.svg" | "preview.image" {
  if (kind === "svg") return "preview.svg";
  if (kind === "image") return "preview.image";
  return "preview.markdown";
}

/**
 * 编辑区里一篇文档的落点：按类型分派到源码编辑器与预览。
 *
 * 有源码的文档（text / markdown / svg）把 Monaco 一直挂着，切到预览只是把它藏起来——
 * 这样来回切视图不会丢掉撤销栈与光标位置。图片没有源码，只画预览。
 *
 * 视图切换是编辑区右上角那组浮动图标（照 IDEA）：左边源码、右边预览，纯图标不带字，
 * 浮在内容之上，不占正文的一条高。
 */
export default function DocPane({
  document: doc,
  onChange,
  onSave,
  onBlur,
  onView,
  onOpenLocal,
  reveal,
  onRevealDone,
  runConfigs,
  projectRoot,
  openPaths,
  onRunConfig,
  onRunScript,
  onRunHttp,
  httpResponse,
  changeBaseline,
}: DocPaneProps) {
  const { t } = useI18n();
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;
  const openKey = openPaths.join("\0");
  useEffect(() => {
    if (doc.loading) return;
    retainEditorModels(doc.path, openPathsRef.current);
  }, [doc.loading, doc.path, openKey]);
  const sourceCapable = doc.kind !== "image" && doc.kind !== "binary";
  const markdownSplit = doc.kind === "markdown" && doc.view === "split";
  const httpSplit = httpResponse !== null;
  const layoutSplit = markdownSplit || httpSplit;
  const responseDoc = useMemo<OpenDocument | null>(() => {
    if (httpResponse === null) return null;
    return {
      path: `${doc.path}#response`,
      root: doc.root,
      name: "response.http",
      kind: "text",
      view: "source",
      contents: httpResponse,
      baseline: httpResponse,
      lineEnding: "lf",
      hasBom: false,
      language: "http",
      readOnly: true,
      loading: false,
      error: null,
      diskMs: 0,
      stamp: 0,
      onDisk: false,
    };
  }, [doc.path, doc.root, httpResponse]);
  const showPreview = canPreview(doc) && (doc.view === "preview" || markdownSplit);
  const hideSource = showPreview && !markdownSplit;

  /**
   * 响应那台编辑器用的是自己造的一份「虚拟文档」，不在 `openPaths` 名单里，
   * `retainEditorModels` 不认识它，关掉分栏后它的 Monaco model 会一直留在内存里
   * （还带着整份响应正文）。这里跟着响应路径走：换了或没了就把它关掉。
   */
  const responsePath = responseDoc?.path ?? null;
  const responsePathRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = responsePathRef.current;
    responsePathRef.current = responsePath;
    if (previous !== null && previous !== responsePath) disposeModel(previous);
  }, [responsePath]);
  useEffect(
    () => () => {
      const held = responsePathRef.current;
      responsePathRef.current = null;
      if (held !== null) disposeModel(held);
    },
    []
  );

  /** 分栏模式下左侧编辑器的宽度百分比（默认 50%，支持 20%~80% 范围拖动调节）。 */
  const [splitRatio, setSplitRatio] = useState(50);
  const bodyRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ startX: number; startRatio: number; totalWidth: number } | null>(null);

  /** 分栏联动滚动句柄与防回环锁。 */
  const editorHandleRef = useRef<CodeEditorHandle>(null);
  const previewHandleRef = useRef<MarkdownPreviewHandle>(null);
  const scrollLockRef = useRef<"editor" | "preview" | null>(null);
  const unlockTimerRef = useRef<number | null>(null);

  const handleEditorScrollRatio = useCallback(
    (ratio: number) => {
      if (!markdownSplit) return;
      if (scrollLockRef.current === "preview") return;
      scrollLockRef.current = "editor";
      previewHandleRef.current?.setScrollRatio(ratio);
      if (unlockTimerRef.current !== null) {
        window.clearTimeout(unlockTimerRef.current);
      }
      unlockTimerRef.current = window.setTimeout(() => {
        scrollLockRef.current = null;
        unlockTimerRef.current = null;
      }, 60);
    },
    [markdownSplit]
  );

  const handlePreviewScrollRatio = useCallback(
    (ratio: number) => {
      if (!markdownSplit) return;
      if (scrollLockRef.current === "editor") return;
      scrollLockRef.current = "preview";
      editorHandleRef.current?.setScrollRatio(ratio);
      if (unlockTimerRef.current !== null) {
        window.clearTimeout(unlockTimerRef.current);
      }
      unlockTimerRef.current = window.setTimeout(() => {
        scrollLockRef.current = null;
        unlockTimerRef.current = null;
      }, 60);
    },
    [markdownSplit]
  );

  useEffect(() => {
    return () => {
      if (unlockTimerRef.current !== null) {
        window.clearTimeout(unlockTimerRef.current);
      }
    };
  }, []);

  // 切入分栏模式时，按当前编辑器的滚动比例初始化右侧预览区
  useEffect(() => {
    if (markdownSplit && editorHandleRef.current && previewHandleRef.current) {
      const ratio = editorHandleRef.current.getScrollRatio();
      previewHandleRef.current.setScrollRatio(ratio);
    }
  }, [markdownSplit]);

  // 打不开的文档（二进制、读失败）把原因摆在正文正中：横幅只闪一下，人还没看就走了。
  if (doc.error !== null) {
    return (
      <div className="doc-pane">
        <PaneNotice text={describeError(doc.error, t)} />
      </div>
    );
  }

  return (
    <div className="doc-pane">
      <div className={`doc-body${layoutSplit ? " is-split" : ""}`} ref={bodyRef}>
        {sourceCapable ? (
          // 藏起来而不是卸载：Monaco 实例留着，撤销栈和光标才不会丢；分栏模式下按比例划分宽度。
          <div
            className="doc-source"
            hidden={hideSource}
            style={layoutSplit ? { width: `${splitRatio}%`, flex: "none" } : undefined}
          >
            <CodeEditor
              ref={editorHandleRef}
              document={doc}
              onChange={onChange}
              onSave={onSave}
              onBlur={onBlur}
              reveal={reveal}
              onRevealDone={onRevealDone}
              runConfigs={runConfigs}
              projectRoot={projectRoot}
              onRunConfig={onRunConfig}
              onRunScript={onRunScript}
              onRunHttp={onRunHttp}
              onScrollRatio={handleEditorScrollRatio}
              changeBaseline={changeBaseline}
            />
          </div>
        ) : null}

        {layoutSplit ? (
          <div
            role="separator"
            aria-orientation="vertical"
            className="doc-split-divider"
            title={t("preview.splitResetTip")}
            onDoubleClick={() => setSplitRatio(50)}
            onPointerDown={(event) => {
              if (!bodyRef.current) return;
              const rect = bodyRef.current.getBoundingClientRect();
              splitDragRef.current = {
                startX: event.clientX,
                startRatio: splitRatio,
                totalWidth: rect.width,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = splitDragRef.current;
              if (!drag || drag.totalWidth <= 0) return;
              const deltaRatio = ((event.clientX - drag.startX) / drag.totalWidth) * 100;
              const next = Math.max(20, Math.min(80, drag.startRatio + deltaRatio));
              setSplitRatio(next);
            }}
            onPointerUp={() => {
              splitDragRef.current = null;
            }}
          />
        ) : null}

        {showPreview && doc.kind === "markdown" ? (
          <div
            className="doc-preview-pane"
            style={markdownSplit ? { width: `${100 - splitRatio}%`, flex: "none" } : undefined}
          >
            <Suspense fallback={null}>
              <MarkdownPreview
                ref={previewHandleRef}
                source={doc.contents}
                docPath={doc.path}
                onOpenLocal={onOpenLocal}
                onToggleSource={() => onView(doc.path, "source")}
                onScrollRatio={handlePreviewScrollRatio}
              />
            </Suspense>
          </div>
        ) : null}

        {responseDoc ? (
          <div
            className="doc-preview-pane"
            style={{ width: `${100 - splitRatio}%`, flex: "none" }}
          >
            <CodeEditor
              document={responseDoc}
              onChange={() => {}}
              onSave={() => {}}
              reveal={null}
              onRevealDone={() => {}}
              runConfigs={[]}
              projectRoot={projectRoot}
              onRunConfig={() => {}}
              onRunScript={() => {}}
              onRunHttp={() => {}}
            />
          </div>
        ) : null}

        {showPreview && doc.kind === "svg" ? (
          <ImagePreview path={doc.path} stamp={doc.stamp} />
        ) : null}

        {doc.kind === "image" ? <ImagePreview path={doc.path} stamp={doc.stamp} /> : null}
      </div>

      {canPreview(doc) ? (
        <div className="doc-view-bar" role="group" aria-label={t("preview.toggle")}>
          <button
            type="button"
            className={`doc-view-button${doc.view === "source" ? " is-active" : ""}`}
            onClick={() => onView(doc.path, "source")}
            title={t("preview.source")}
            aria-label={t("preview.source")}
            aria-pressed={doc.view === "source"}
          >
            <Code2 size={15} aria-hidden="true" />
          </button>
          {doc.kind === "markdown" ? (
            <button
              type="button"
              className={`doc-view-button${doc.view === "split" ? " is-active" : ""}`}
              onClick={() => {
                onView(doc.path, "split");
              }}
              title={t("preview.split")}
              aria-label={t("preview.split")}
              aria-pressed={doc.view === "split"}
            >
              <Columns2 size={15} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className={`doc-view-button${doc.view === "preview" ? " is-active" : ""}`}
            onClick={() => {
              // 从有编辑器的视图切到纯预览时编辑器被 hidden，主动触发失焦回调确保 svg 等磁盘预览拿到最新存盘内容。
              if (doc.view !== "preview") onBlur?.();
              onView(doc.path, "preview");
            }}
            title={t(previewLabel(doc.kind))}
            aria-label={t(previewLabel(doc.kind))}
            aria-pressed={doc.view === "preview"}
          >
            <Eye size={15} aria-hidden="true" />
          </button>
          {showPreview && doc.kind === "markdown" ? (
            <button
              type="button"
              className="doc-view-button"
              onClick={() => previewHandleRef.current?.openFind()}
              title={`${t("preview.find")} (Ctrl+F)`}
              aria-label={t("preview.find")}
            >
              <Search size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
