import { lazy, Suspense } from "react";
import { Code2, Eye } from "lucide-react";
import CodeEditor from "./CodeEditor";
import ImagePreview from "./ImagePreview";
import PaneNotice from "./PaneNotice";
import { canPreview } from "../hooks/useDocuments";
import type { DocView, OpenDocument, RevealTarget } from "../hooks/useDocuments";
import type { DocKind } from "../lib/docKind";
import { describeError } from "../lib/errors";
import type { RunConfiguration } from "../lib/runConfigs";
import { useI18n } from "../i18n";

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
  /** 点了装订线那颗 ▶：一条就直接跑，几条就开选择器让他挑。 */
  onRunConfig: (configs: RunConfiguration[]) => void;
  /** 点了脚本文件装订线那颗 ▶：把脚本发到对应终端里执行。 */
  onRunScript: (path: string) => void;
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
  onRunConfig,
  onRunScript,
}: DocPaneProps) {
  const { t } = useI18n();
  const sourceCapable = doc.kind !== "image" && doc.kind !== "binary";
  const showPreview = canPreview(doc) && doc.view === "preview";

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
      <div className="doc-body">
        {sourceCapable ? (
          // 藏起来而不是卸载：Monaco 实例留着，撤销栈和光标才不会丢。
          <div className="doc-source" hidden={showPreview}>
            <CodeEditor
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
            />
          </div>
        ) : null}

        {showPreview && doc.kind === "markdown" ? (
          <Suspense fallback={null}>
            <MarkdownPreview
              source={doc.contents}
              docPath={doc.path}
              onOpenLocal={onOpenLocal}
            />
          </Suspense>
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
          <button
            type="button"
            className={`doc-view-button${doc.view === "preview" ? " is-active" : ""}`}
            onClick={() => {
              // 从源码切到预览时编辑器被 hidden，主动触发失焦回调确保 svg 等磁盘预览拿到最新存盘内容。
              if (doc.view === "source") onBlur?.();
              onView(doc.path, "preview");
            }}
            title={t(previewLabel(doc.kind))}
            aria-label={t(previewLabel(doc.kind))}
            aria-pressed={doc.view === "preview"}
          >
            <Eye size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
