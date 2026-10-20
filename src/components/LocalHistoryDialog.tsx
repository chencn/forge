import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import { monaco } from "../lib/monacoEditor";
import { monoFont } from "../lib/monacoEnv";
import { useI18n } from "../i18n";
import {
  getSnapshot,
  listSnapshots,
  restoreSnapshot,
  type SnapshotFull,
  type SnapshotInfo,
} from "../lib/localHistory";
import type { FileContent } from "../lib/fs";

interface LocalHistoryDialogProps {
  root: string;
  path: string;
  name: string;
  language: string;
  currentContent: string;
  onRestored: (content: FileContent) => void;
  onClose: () => void;
}

let historyDiffSeq = 0;

function formatTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (sameDay) return time;
  return `${date.toLocaleDateString([], { month: "2-digit", day: "2-digit" })} ${time}`;
}

export default function LocalHistoryDialog({
  root,
  path,
  name,
  language,
  currentContent,
  onRestored,
  onClose,
}: LocalHistoryDialogProps) {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAt, setSelectedAt] = useState<number | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotFull | null>(null);
  const [restoring, setRestoring] = useState(false);

  const diffHostRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ left: monaco.editor.ITextModel; right: monaco.editor.ITextModel } | null>(
    null
  );

  // 挂载时拉取快照清单（最新在前）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSnapshots(root, path)
      .then((items) => {
        if (cancelled) return;
        setSnapshots(items);
        setLoading(false);
        if (items.length > 0) {
          setSelectedAt(items[0].savedAt);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, root]);

  // 选中某一条时拉取其完整正文
  useEffect(() => {
    if (selectedAt === null) {
      setSelectedSnapshot(null);
      return;
    }
    let cancelled = false;
    getSnapshot(root, path, selectedAt).then((item) => {
      if (!cancelled && item) setSelectedSnapshot(item);
    });
    return () => {
      cancelled = true;
    };
  }, [path, root, selectedAt]);

  // 初始化 Diff Editor
  useEffect(() => {
    const host = diffHostRef.current;
    if (!host) return;

    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      fontFamily: monoFont(),
      fontSize: 12.5,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerLanes: 0,
      diffWordWrap: "off",
      editContext: false,
    });
    diffEditorRef.current = editor;

    return () => {
      diffEditorRef.current = null;
      editor.dispose();
      if (modelsRef.current) {
        modelsRef.current.left.dispose();
        modelsRef.current.right.dispose();
        modelsRef.current = null;
      }
    };
  }, []);

  // 每次选中快照内容变更时，更新 Diff Editor 的两侧 Model
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;

    if (modelsRef.current) {
      modelsRef.current.left.dispose();
      modelsRef.current.right.dispose();
      modelsRef.current = null;
    }

    const seq = (historyDiffSeq += 1);
    const leftText = selectedSnapshot ? selectedSnapshot.contents : "";
    const rightText = currentContent;

    const left = monaco.editor.createModel(
      leftText,
      language,
      monaco.Uri.parse(`inmemory://forge/local-history-${seq}-snapshot`)
    );
    const right = monaco.editor.createModel(
      rightText,
      language,
      monaco.Uri.parse(`inmemory://forge/local-history-${seq}-current`)
    );

    modelsRef.current = { left, right };
    editor.setModel({ original: left, modified: right });
  }, [currentContent, language, selectedSnapshot]);

  const handleRestore = useCallback(async () => {
    if (!selectedSnapshot || restoring) return;
    setRestoring(true);
    try {
      const written = await restoreSnapshot(root, path, selectedSnapshot.savedAt);
      onRestored(written);
      onClose();
    } catch {
      setRestoring(false);
    }
  }, [onClose, onRestored, path, restoring, root, selectedSnapshot]);

  // Esc 快捷键关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedTitle = useMemo(() => {
    if (!selectedSnapshot) return "";
    return `${t("history.snapshot")} (${formatTime(selectedSnapshot.savedAt)})`;
  }, [selectedSnapshot, t]);

  return (
    <div className="dialog-backdrop is-wide" onMouseDown={onClose}>
      <div
        className="dialog dialog-local-history"
        role="dialog"
        aria-modal="true"
        aria-label={t("history.title", { name })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-local-history-head">
          <div className="dialog-local-history-title-wrap">
            <History size={16} aria-hidden="true" />
            <p className="dialog-title">{t("history.title", { name })}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t("dialog.cancel")}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="dialog-local-history-body">
          {/* 左侧：快照列表 */}
          <aside className="dialog-local-history-sidebar">
            <div className="dialog-local-history-list-head">
              <span>{t("menu.localHistory")}</span>
              <span className="dialog-local-history-count">{snapshots.length}</span>
            </div>

            {loading ? (
              <div className="dialog-local-history-empty">{t("history.loading")}</div>
            ) : snapshots.length === 0 ? (
              <div className="dialog-local-history-empty">{t("history.empty")}</div>
            ) : (
              <div className="dialog-local-history-list" role="listbox">
                {snapshots.map((item) => {
                  const active = item.savedAt === selectedAt;
                  return (
                    <button
                      key={item.savedAt}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`dialog-local-history-item${active ? " is-active" : ""}`}
                      onClick={() => setSelectedAt(item.savedAt)}
                    >
                      <div className="dialog-local-history-item-top">
                        <span className="dialog-local-history-time">{formatTime(item.savedAt)}</span>
                        {item.encoding && item.encoding !== "utf-8" ? (
                          <span className="dialog-local-history-badge">{item.encoding.toUpperCase()}</span>
                        ) : null}
                      </div>
                      <div className="dialog-local-history-item-sub">
                        <span>{t("history.chars", { count: item.chars })}</span>
                        <span>{item.lineEnding.toUpperCase()}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          {/* 右侧：Diff 对比 */}
          <main className="dialog-local-history-main">
            <div className="dialog-local-history-diff-header">
              <span className="dialog-local-history-diff-label">
                {selectedTitle || t("history.snapshot")}
              </span>
              <span className="dialog-local-history-diff-label">{t("history.current")}</span>
            </div>
            <div ref={diffHostRef} className="dialog-local-history-diff-host" />
          </main>
        </div>

        <div className="dialog-actions dialog-local-history-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button
            type="button"
            className="button is-primary"
            disabled={!selectedSnapshot || restoring}
            onClick={() => void handleRestore()}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t("history.revert")}
          </button>
        </div>
      </div>
    </div>
  );
}
