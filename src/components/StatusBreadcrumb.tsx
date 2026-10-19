import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../i18n";
import { errorText, listDirectory } from "../lib/fs";
import type { FsEntry } from "../lib/fs";
import { joinPath, nativeSeparators, pathWithin } from "../lib/format";
import EntryIcon from "./EntryIcon";
import Popover from "./Popover";

interface Crumb {
  name: string;
  path: string;
}

interface CrumbMenu {
  anchor: HTMLElement;
  segmentIndex: number;
  path: string;
  stack: string[];
  entries: FsEntry[];
  error: string | null;
  ready: boolean;
}

/**
 * 底栏左侧的路径条，照 Lithe 的页脚面包屑：
 * 相对工程根拆段，点目录弹出这一层的内容，点文件直接打开。弹层从底栏往上翻。
 */
export default function StatusBreadcrumb({
  root,
  file,
  showHidden,
  onOpenFile,
}: {
  root: string;
  file: string;
  showHidden: boolean;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const ticket = useRef(0);
  const [menu, setMenu] = useState<CrumbMenu | null>(null);
  const segments = useMemo(() => crumbsOf(root, file), [root, file]);

  if (segments.length === 0) return null;

  const load = async (anchor: HTMLElement, segmentIndex: number, path: string, stack: string[]) => {
    const mine = ++ticket.current;
    setMenu({ anchor, segmentIndex, path, stack, entries: [], error: null, ready: false });
    try {
      const listing = await listDirectory(path);
      if (mine !== ticket.current) return;
      const entries = listing.entries.filter((entry) => showHidden || !entry.isHidden);
      setMenu((current) =>
        current && current.path === path ? { ...current, entries, ready: true } : current,
      );
    } catch (error) {
      if (mine !== ticket.current) return;
      const message = errorText(error);
      setMenu((current) =>
        current && current.path === path ? { ...current, error: message, ready: true } : current,
      );
    }
  };

  return (
    <nav className="status-crumbs" aria-label={t("status.filePath")}>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={segment.path} className="status-crumb-pair">
            {index > 0 ? <ChevronRight size={12} className="status-crumb-sep" aria-hidden="true" /> : null}
            <button
              type="button"
              className={`status-crumb${last ? " is-current" : ""}`}
              onClick={(event) => {
                if (last) {
                  onOpenFile(segment.path);
                  return;
                }
                const anchor = event.currentTarget;
                if (menu?.segmentIndex === index && menu.path === segment.path) {
                  ticket.current += 1;
                  setMenu(null);
                  return;
                }
                void load(anchor, index, segment.path, []);
              }}
            >
              {last ? <EntryIcon name={segment.name} size={14} /> : null}
              <span>{segment.name}</span>
            </button>
          </span>
        );
      })}
      <Popover anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} minWidth={220} maxWidth={360}>
        {menu ? (
          <div className="status-crumb-menu" role="menu">
            {menu.stack.length > 0 ? (
              <button
                type="button"
                className="popover-item"
                onClick={() => {
                  const previous = menu.stack[menu.stack.length - 1];
                  if (!previous) return;
                  void load(menu.anchor, menu.segmentIndex, previous, menu.stack.slice(0, -1));
                }}
              >
                <ChevronLeft size={14} aria-hidden="true" />
                <span>{t("breadcrumb.back")}</span>
              </button>
            ) : null}
            {menu.error ? <p className="status-crumb-empty">{menu.error}</p> : null}
            {menu.ready && !menu.error && menu.entries.length === 0 ? (
              <p className="status-crumb-empty">{t("breadcrumb.empty")}</p>
            ) : null}
            {menu.entries.map((entry) => {
              const directory = entry.kind === "directory";
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="menuitem"
                  className="popover-item"
                  onClick={() => {
                    if (directory) {
                      void load(menu.anchor, menu.segmentIndex, entry.path, [...menu.stack, menu.path]);
                      return;
                    }
                    ticket.current += 1;
                    setMenu(null);
                    onOpenFile(entry.path);
                  }}
                >
                  <EntryIcon name={entry.name} isDirectory={directory} size={16} />
                  <span className="status-crumb-name">{entry.name}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </Popover>
    </nav>
  );
}

/** 工程根之内的相对段；根外面的文件只留最后一级，路径仍用绝对路径。 */
function crumbsOf(root: string, file: string): Crumb[] {
  const filePath = nativeSeparators(file);
  const rootPath = nativeSeparators(root).replace(/[\\/]+$/, "");
  if (!pathWithin(rootPath, filePath)) {
    const name = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    return [{ name, path: filePath }];
  }
  const names = filePath.slice(rootPath.length).replace(/^[\\/]+/, "").split(/[\\/]/).filter(Boolean);
  let built = rootPath;
  return names.map((name) => {
    built = joinPath(built, name);
    return { name, path: built };
  });
}
