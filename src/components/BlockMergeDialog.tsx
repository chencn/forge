import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { readFile, writeFile, errorText } from "../lib/fs";
import {
  parseConflicts,
  resolveWithChoices,
  type ConflictBlock,
  type Resolution,
} from "../features/vcs/conflicts";

interface BlockMergeDialogProps {
  /** 冲突文件的绝对路径。 */
  path: string;
  /** 应用成功（已写回磁盘）后通知上层——暂存与刷新由上层接手。 */
  onApplied: () => void;
  onClose: () => void;
  reportError: (message: string, title?: string) => void;
}

/** 预览框最多显示多少行，超出折叠——冲突块经常几百行。 */
const PREVIEW_MAX = 12;

function previewOf(text: string): { lines: string[]; more: number } {
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  if (lines.length <= PREVIEW_MAX) return { lines, more: 0 };
  return { lines: lines.slice(0, PREVIEW_MAX), more: lines.length - PREVIEW_MAX };
}

function SidePreview({ text, tone }: { text: string; tone: "ours" | "base" | "theirs" }) {
  const { lines, more } = previewOf(text);
  return (
    <div className={`block-merge-side is-${tone}`}>
      <pre>{lines.join("\n")}</pre>
      {more > 0 ? <p className="block-merge-more">… +{more}</p> : null}
    </div>
  );
}

/**
 * 块级冲突解决（对齐 IDEA 的逐块取舍）：列出文件里每个冲突块，
 * 逐块选你的 / 对方的 / 两者 / base，一次应用写回并暂存。
 */
export default function BlockMergeDialog({
  path,
  onApplied,
  onClose,
  reportError,
}: BlockMergeDialogProps) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [choices, setChoices] = useState<Array<Resolution | undefined>>([]);
  const [applying, setApplying] = useState(false);

  const blocks = useMemo<ConflictBlock[]>(() => (content ? parseConflicts(content) : []), [content]);

  useEffect(() => {
    let stale = false;
    readFile(path)
      .then((doc) => {
        if (!stale) setContent(doc.contents);
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
  }, [path, onClose, reportError]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolvedCount = choices.filter(Boolean).length;
  const remaining = blocks.length - resolvedCount;

  const choose = (index: number, how: Resolution) =>
    setChoices((current) => {
      const next = [...current];
      next[index] = how;
      return next;
    });

  const apply = async () => {
    if (!content) return;
    setApplying(true);
    try {
      const doc = await readFile(path);
      // 取舍按打开那一刻的块下标记账：窗口期间磁盘被外部改写（块数或内容变了），
      // 照旧应用会把取舍落到错的块上。宁可让用户重开一次，也不静默错位。
      const fresh = parseConflicts(doc.contents);
      const unchanged =
        fresh.length === blocks.length &&
        fresh.every((block, index) => {
          const known = blocks[index];
          return (
            block.ours === known.ours &&
            block.theirs === known.theirs &&
            block.base === known.base
          );
        });
      if (!unchanged) {
        reportError(t("git.blockStale"));
        onClose();
        return;
      }
      const merged = resolveWithChoices(doc.contents, choices);
      await writeFile(path, merged, doc.lineEnding, doc.hasBom, doc.encoding, doc.modifiedMs);
      onApplied();
    } catch (cause: unknown) {
      reportError(errorText(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="dialog-backdrop is-wide" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("git.blockMergeTitle")}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 860, width: "90%" }}
      >
        <p className="dialog-title">{t("git.blockMergeTitle")}</p>
        <p className="dialog-body" title={path}>
          {remaining > 0
            ? t("git.blockRemaining").replace("{n}", String(remaining))
            : t("git.blockAllResolved")}
        </p>

        {content !== null && blocks.length === 0 ? (
          <p className="panel-note">{t("git.blockNoMarkers")}</p>
        ) : (
          <ul className="block-merge-list">
            {blocks.map((block, index) => {
              const picked = choices[index];
              return (
                <li key={block.from} className="block-merge-item">
                  <div className="block-merge-row">
                    <span className="block-merge-label">
                      #{index + 1}
                      {block.oursLabel ? ` · ${block.oursLabel}` : ""}
                    </span>
                    <div className="block-merge-actions">
                      <button
                        type="button"
                        className={`button is-tiny${picked === "ours" ? " is-primary" : ""}`}
                        onClick={() => choose(index, "ours")}
                      >
                        {t("git.acceptYours")}
                      </button>
                      <button
                        type="button"
                        className={`button is-tiny${picked === "theirs" ? " is-primary" : ""}`}
                        onClick={() => choose(index, "theirs")}
                      >
                        {t("git.acceptTheirs")}
                      </button>
                      <button
                        type="button"
                        className={`button is-tiny${picked === "both" ? " is-primary" : ""}`}
                        onClick={() => choose(index, "both")}
                      >
                        {t("git.blockBoth")}
                      </button>
                      <button
                        type="button"
                        className={`button is-tiny${picked === "base" ? " is-primary" : ""}`}
                        disabled={!block.base}
                        onClick={() => choose(index, "base")}
                      >
                        {t("git.blockBase")}
                      </button>
                    </div>
                  </div>
                  <div className="block-merge-sides">
                    <SidePreview text={block.ours} tone="ours" />
                    {block.base !== null ? <SidePreview text={block.base} tone="base" /> : null}
                    <SidePreview text={block.theirs} tone="theirs" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button
            type="button"
            className="button is-primary"
            disabled={content === null || blocks.length === 0 || remaining > 0 || applying}
            onClick={() => void apply()}
          >
            {t("git.blockApply")}
          </button>
        </div>
      </div>
    </div>
  );
}
