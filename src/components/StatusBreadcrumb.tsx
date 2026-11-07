import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../i18n";
import { errorText, listDirectory } from "../lib/fs";
import type { FsEntry } from "../lib/fs";
import { basenameOf, joinPath, nativeSeparators, parentPath, pathWithin } from "../lib/format";
import type { OutlineSymbol } from "../lib/editorOutline";
import { tooltipAttrs } from "../ui/Tooltip";
import { Icon } from "../ui/Icon";
import { openOutlineSymbol, useCodeOutline } from "./CodeBreadcrumbs";
import SymbolIcon from "./SymbolIcon";
import EntryIcon from "./EntryIcon";
import Popover from "./Popover";

interface Crumb {
  name: string;
  path: string;
  root?: boolean;
  collapsed?: boolean;
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

interface SymbolMenu {
  anchor: HTMLElement;
  item?: OutlineSymbol;
}

/**
 * 层级：工程 › 目录 › 文件 › 光标所在符号，点击每段浏览其子项。
 * 目录仍复用文件系统入口；符号来自源码编辑器手上的大纲，包含尚未保存的改动。
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
  const [symbolMenu, setSymbolMenu] = useState<SymbolMenu | null>(null);
  const { items, chain } = useCodeOutline(file);
  const navRef = useRef<HTMLElement>(null);
  const segments = useMemo(() => crumbsOf(root, file), [root, file]);
  const stem = basenameOf(file).replace(/\.[^.]+$/, "");
  const shownChain = chain.filter((item, index) => index > 0 || item.name !== stem);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav) nav.scrollLeft = nav.scrollWidth;
  }, [file, chain]);
  useEffect(() => {
    // 文档或大纲改变后关掉旧菜单，不能继续用旧符号偏移跳转。
    ticket.current += 1;
    setMenu(null);
    setSymbolMenu(null);
  }, [file, items]);

  if (segments.length === 0) return null;

  const load = async (anchor: HTMLElement, segmentIndex: number, path: string, stack: string[]) => {
    const mine = ++ticket.current;
    setSymbolMenu(null);
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
    <nav ref={navRef} className="status-crumbs" aria-label={t("status.filePath")}>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={segment.path} className="status-crumb-pair">
            {index > 0 ? <ChevronRight size={12} className="status-crumb-sep" aria-hidden="true" /> : null}
            <button
              type="button"
              className={`status-crumb${last ? " is-current" : ""}`}
              {...tooltipAttrs(segment.path)}
              aria-haspopup="menu"
              aria-expanded={last ? symbolMenu?.anchor.dataset.crumbFile === file : menu?.segmentIndex === index}
              data-crumb-file={last ? file : undefined}
              onClick={(event) => {
                if (last) {
                  ticket.current += 1;
                  setMenu(null);
                  const anchor = event.currentTarget;
                  setSymbolMenu((current) => current?.anchor === anchor ? null : { anchor });
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
              {segment.root ? <Icon name="module" size={14} /> : segment.collapsed ? null : <EntryIcon name={segment.name} isDirectory={!last} size={14} />}
              <span className="status-crumb-label">{segment.name}</span>
            </button>
          </span>
        );
      })}
      {shownChain.map((item) => (
        <span key={`${item.from}:${item.name}`} className="status-crumb-pair">
          <ChevronRight size={12} className="status-crumb-sep" aria-hidden="true" />
          <button type="button" className="status-crumb" {...tooltipAttrs(item.name)} aria-haspopup="menu"
            aria-expanded={symbolMenu?.item === item}
            onClick={(event) => {
              ticket.current += 1;
              setMenu(null);
              const anchor = event.currentTarget;
              setSymbolMenu((current) => current?.anchor === anchor ? null : { anchor, item });
            }}>
            <SymbolIcon kind={item.kind} size={14} />
            <span className="status-crumb-label">{item.name}</span>
          </button>
        </span>
      ))}
      <Popover anchor={symbolMenu?.anchor ?? null} onClose={() => setSymbolMenu(null)} minWidth={220} maxWidth={360} autoFocus>
        <div className="status-crumb-menu" role="menu" onKeyDown={navigateMenu}>
          {(symbolMenu?.item?.children ?? items).length === 0 ? <p className="status-crumb-empty">{t("breadcrumb.noSymbols")}</p> : null}
          {(symbolMenu?.item?.children ?? items).map((item) => (
            <button key={`${item.from}:${item.name}`} type="button" role="menuitem" className="popover-item" {...tooltipAttrs(item.name)}
              onClick={() => { setSymbolMenu(null); void openOutlineSymbol(file, item); }}>
              <SymbolIcon kind={item.kind} size={16} />
              <span className="status-crumb-name">{item.name}</span>
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={menu?.anchor ?? null} onClose={() => { ticket.current += 1; setMenu(null); }} minWidth={220} maxWidth={360} autoFocus>
        {/* 目录异步加载时先持有焦点，条目回来后方向键仍能进入菜单。 */}
        {menu ? (
          <div className="status-crumb-menu" role="menu" tabIndex={-1} data-autofocus onKeyDown={navigateMenu}>
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

/** 工程根始终可见；深路径省略中间层；根外文件仍可浏览父目录。 */
function crumbsOf(root: string, file: string): Crumb[] {
  const filePath = nativeSeparators(file);
  const rootPath = nativeSeparators(root).replace(/[\\/]+$/, "");
  if (!pathWithin(rootPath, filePath)) {
    const name = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    const parent = parentPath(filePath);
    return [...(parent ? [{ name: basenameOf(parent), path: parent }] : []), { name, path: filePath }];
  }
  const names = filePath.slice(rootPath.length).replace(/^[\\/]+/, "").split(/[\\/]/).filter(Boolean);
  let built = rootPath;
  const parts: Crumb[] = names.map((name) => {
    built = joinPath(built, name);
    return { name, path: built };
  });
  const dirs = parts.slice(0, -1);
  const shown = dirs.length > 4 ? [dirs[0], { name: "…", path: dirs[dirs.length - 3].path, collapsed: true }, ...dirs.slice(-2)] : dirs;
  return [{ name: basenameOf(rootPath), path: rootPath, root: true }, ...shown, ...parts.slice(-1)];
}

/** 子项菜单沿用原生按钮的焦点和 Enter，补齐上下键与首尾导航。 */
function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
}
