import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, RefreshCw, RotateCcw } from "lucide-react";
import type { OpenDocument } from "../hooks/useDocuments";
import { useI18n } from "../i18n";
import { languageForPath } from "../lib/editorEnv";
import { describeError } from "../lib/errors";
import { errorText, readFile, type FileContent } from "../lib/fs";
import { pathWithin, samePath } from "../lib/format";
import { getSnapshot, listDirectoryHistory, putHistoryLabel, restoreSnapshot, revisionRange, snapshotsBefore,
  type DirectoryHistory, type HistoryEntry } from "../lib/localHistory";
import { Button, IconButton } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { List } from "../ui/List";
import DiffPane from "./DiffPane";
import styles from "./LocalHistoryEditor.module.css";

/** {@link LocalHistoryEditor} 的入参。 */
interface Props {
  root: string;
  path: string;
  documents: OpenDocument[];
  labelRequested?: boolean;
  onLabelHandled: () => void;
  beforeRestore: (paths: string[]) => Promise<void>;
  onRestored: (content: FileContent) => void;
}

/** 一条修订的稳定键（清单选中态用）。 */
const keyOf = (entry: HistoryEntry) => `${entry.kind}:${entry.path}:${entry.savedAt}`;
/** 秒级本地时间文案（修订列表用）。 */
function time(ms: number) { return new Date(ms).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
/** 一次比对的两份数据（路径、还原出的两版、当前盘上版本与修改时刻）。 */
interface Comparison { path: string; original: string; modified: string; left: string; right?: string; modifiedMs: number }

/** 历史是编辑器输入；文件、目录和已删除文件使用同一条查询与恢复流程。 */
export default function LocalHistoryEditor({ root, path, documents, labelRequested, onLabelHandled, beforeRestore, onRestored }: Props) {
  const { t } = useI18n();
  const [history, setHistory] = useState<DirectoryHistory | null>(null);
  const [active, setActive] = useState(0);
  const [extra, setExtra] = useState(new Set<number>());
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<{ entry: HistoryEntry; modifiedMs: number }[] | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState("");
  const pointer = useRef(false);
  const anchor = useRef(0);
  const previous = useRef(0);
  const selectedKey = useRef("");
  const entries = history?.entries ?? [];
  const selected = useMemo(() => entries.filter((_, index) => index === active || extra.has(index)), [entries, active, extra]);
  const current = entries[active];
  const range = useMemo(() => revisionRange(selected), [selected]);
  const folder = entries.some((entry) => entry.kind === "snapshot" && !samePath(entry.path, path));
  const targets = current?.kind === "label" ? snapshotsBefore(entries, current, path) : current ? [current] : [];
  const targetKey = targets.map(keyOf).join("\n");

  useEffect(() => {
    let cancelled = false;
    setError(""); setHistory(null); setComparison(null); setConfirm(null);
    void listDirectoryHistory(root, path).then((view) => {
      if (cancelled) return;
      const index = view.entries.findIndex((entry) => keyOf(entry) === selectedKey.current);
      setHistory(view); setActive(Math.max(0, index)); setExtra(new Set());
    }).catch((cause) => { if (!cancelled) setError(describeError(errorText(cause), t)); });
    return () => { cancelled = true; };
  }, [root, path, reload, t]);

  useEffect(() => { if (current) selectedKey.current = keyOf(current); }, [current]);

  useEffect(() => {
    let cancelled = false;
    setComparison(null); setDetailError("");
    if (!current || (selected.length > 1 && !range) || (current.kind === "label" && targets.length !== 1)) return;
    const source = range?.[0] ?? targets[0];
    if (!source) return;
    const load = async () => {
      const original = await getSnapshot(root, source.path, source.savedAt);
      if (!original) throw new Error(t("history.missing"));
      const newer = range ? await getSnapshot(root, source.path, range[1].savedAt) : null;
      if (range && !newer) throw new Error(t("history.missing"));
      const deleted = history?.deleted.some((deletedPath) => samePath(deletedPath, source.path));
      const disk = deleted || range ? null : await readFile(source.path);
      const doc = documents.find((item) => samePath(item.path, source.path));
      if (!cancelled) setComparison({ path: source.path, original: original.contents,
        modified: newer?.contents ?? (deleted ? "" : doc?.contents ?? disk?.contents ?? ""), modifiedMs: disk?.modifiedMs ?? 0,
        left: time(source.savedAt), right: range ? time(range[1].savedAt) : deleted ? t("history.deleted") : undefined });
    };
    void load().catch((cause) => { if (!cancelled) setDetailError(describeError(errorText(cause), t)); });
    return () => { cancelled = true; };
  }, [root, current, range, targetKey, documents, history, t]);

  const prepareRestore = async () => {
    if (!targets.length || busy) return;
    setBusy(true); setDetailError("");
    try {
      const plan = await Promise.all(targets.map(async (entry) => ({ entry,
        modifiedMs: !range && comparison && samePath(comparison.path, entry.path) ? comparison.modifiedMs
          : history?.deleted.includes(entry.path) ? 0 : (await readFile(entry.path)).modifiedMs })));
      setConfirm(plan);
    } catch (cause) { setDetailError(describeError(errorText(cause), t)); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (!confirm || busy) return;
    setBusy(true); setDetailError("");
    try {
      // 未保存文本也要先留存，磁盘版本的保护由后端在文件写锁内完成。
      await beforeRestore(confirm.map(({ entry }) => entry.path));
      for (const { entry, modifiedMs } of confirm) {
        onRestored(await restoreSnapshot(root, entry.path, entry.savedAt, modifiedMs));
      }
      setConfirm(null); setReload((value) => value + 1);
    } catch (cause) { setConfirm(null); setDetailError(describeError(errorText(cause), t)); }
    finally { setBusy(false); }
  };

  const closeLabel = () => { if (!busy) { setLabelOpen(false); setLabel(""); onLabelHandled(); } };
  const putLabel = async () => {
    if (!label.trim() || busy) return;
    setBusy(true); setDetailError("");
    try {
      const snapshots = documents.filter((doc) => !doc.loading && !doc.error && doc.onDisk && (samePath(doc.path, path) || pathWithin(path, doc.path)))
        .map((doc) => ({ path: doc.path, savedAt: Date.now(), contents: doc.contents, lineEnding: doc.lineEnding, hasBom: doc.hasBom, encoding: doc.encoding, event: "label" }));
      await putHistoryLabel(root, path, label.trim(), snapshots);
      setLabelOpen(false); setLabel(""); onLabelHandled(); setReload((value) => value + 1);
    } catch (cause) { setDetailError(describeError(errorText(cause), t)); }
    finally { setBusy(false); }
  };

  return <div className={styles.root}>
    <aside className={styles.sidebar} onMouseDownCapture={(event) => {
      pointer.current = event.button === 0 && !!(event.target as Element).closest('[role="option"]');
    }}>
      <header className={styles.header}>
        <span className={styles.title}>{t("menu.localHistory")}</span>
        <IconButton size="small" icon={Bookmark} title={t("history.putLabel")} disabled={busy} onClick={() => setLabelOpen(true)} />
        <IconButton size="small" icon={RefreshCw} title={t("history.refresh")} disabled={busy} onClick={() => setReload((value) => value + 1)} />
        <Button size="small" disabled={!targets.length || busy || !history} onClick={() => void prepareRestore()} icon={RotateCcw}>
          {t(current && history?.deleted.includes(current.path) ? "history.restore" : "history.revert")}
        </Button>
      </header>
      {error ? <div role="alert" className={styles.message}>{error}</div> : !history ? <div role="status" className={styles.message}>{t("history.loading")}</div> : <List
        items={entries} getKey={keyOf} activeIndex={active} rowHeight={folder ? 52 : 38}
        aria-label={t("history.revisions")} className={styles.list} isSelected={(_, index) => extra.has(index)}
        onActiveChange={(index) => {
          previous.current = active;
          if (!pointer.current) { anchor.current = index; setExtra(new Set()); }
          setActive(index);
        }}
        onActivate={(_, index, event) => {
          if (!pointer.current) return;
          pointer.current = false;
          if (event.shiftKey) {
            const from = Math.min(anchor.current, index), to = Math.max(anchor.current, index);
            setExtra(new Set(Array.from({ length: to - from + 1 }, (_, offset) => from + offset).filter((value) => value !== index)));
          } else if (event.ctrlKey || event.metaKey) {
            anchor.current = index;
            setExtra((currentExtra) => { const next = new Set(currentExtra); next.delete(index); if (previous.current !== index) next.add(previous.current); return next; });
          } else { anchor.current = index; setExtra(new Set()); }
          setActive(index);
        }}
        empty={<span className={styles.message}>{t("history.empty")}</span>}
        renderItem={(entry) => <span className={styles.entry}>
          <span className={styles.time}>{time(entry.savedAt)}</span>
          {entry.kind === "label" ? <span className={styles.label}><Bookmark size={12} />{entry.label}</span> : <>
            {folder && <span className={history.deleted.includes(entry.path) ? styles.deleted : styles.path}>{entry.path.slice(root.length).replace(/^[\\/]/, "")}</span>}
            <span className={styles.label}>{t(entry.label === "opened" ? "history.opened" : entry.label === "external" ? "history.external" : entry.label === "deleted" ? "history.deleted" : entry.label === "beforeRestore" ? "history.beforeRestore" : entry.label === "restored" ? "history.restored" : "history.saved")} · {entry.chars < 1024 ? `${entry.chars} B` : `${(entry.chars / 1024).toFixed(1)} KB`}</span>
          </>}
        </span>}
      />}
    </aside>
    <main className={styles.diff}>
      {detailError ? <div role="alert" className={styles.message}>{detailError}</div> : comparison ? <DiffPane
        path={comparison.path} original={comparison.original} modified={comparison.modified} language={languageForPath(comparison.path, comparison.original)}
        leftLabel={comparison.left} rightLabel={comparison.right ?? t("history.current")} onRefresh={() => setReload((value) => value + 1)}
      /> : <div className={styles.message}>{selected.length > 1 && !range ? t("history.sameFile") : current?.kind === "label" ? t("history.labelFiles", { count: targets.length }) : current ? t("history.loading") : t("history.empty")}</div>}
    </main>
    <Dialog open={confirm !== null} title={t("history.revert")} onClose={() => { if (!busy) setConfirm(null); }} buttons={[
      { label: t("history.revert"), role: "default", disabled: busy, onClick: () => void restore() },
      { label: t("dialog.cancel"), role: "cancel", disabled: busy },
    ]}>
      <p>{t("history.confirmRestore", { count: confirm?.length ?? 0 })}</p>
      <div className={styles.confirmPaths}>{confirm?.map(({ entry }) => <div key={entry.path}>{entry.path}</div>)}</div>
    </Dialog>
    <Dialog open={labelOpen || !!labelRequested} title={t("history.putLabel")} onClose={closeLabel} buttons={[
      { label: t("history.putLabel"), role: "default", disabled: !label.trim() || busy, onClick: () => void putLabel() },
      { label: t("dialog.cancel"), role: "cancel", disabled: busy },
    ]}>
      <Input autoFocus aria-label={t("history.labelName")} value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} />
      {detailError && <p role="alert">{detailError}</p>}
    </Dialog>
  </div>;
}
