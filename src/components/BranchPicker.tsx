import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Download, Folder, GitBranch, GitCommit, GitPullRequestArrow, Plus, RefreshCw, Settings, Star, Tag, Upload } from "lucide-react";
import { Popup } from "../ui/Popup";
import { List, firstSelectable, listNavigate } from "../ui/List";
import { Menu, MenuList, type MenuItem as UiMenuItem } from "../ui/Menu";
import { tooltipAttrs } from "../ui/Tooltip";
import { SearchField } from "../ui/Input";
import { HighlightedText } from "../ui/HighlightedText";
import { formatShortcut } from "../lib/shortcuts";
import type { GitState } from "../hooks/useGitState";
import { buildRefMenu, upstreamOf, type RefAction, type RefTarget } from "../lib/refMenu";
import type { MenuItem } from "./ContextMenu";
import { branchPopupRows, type BranchPopupRow } from "../lib/branchPopup";
import { canPush, canUpdate, canFetch } from "../lib/gitGates";
import { withFavoriteToggled, type BranchSettings } from "../lib/settings";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import "./BranchPicker.css";

export type BranchAction = "update" | "commit" | "push" | "fetch" | "newBranch" | "newTag" | "checkoutRev" | "initRepo";
interface BranchPickerProps {
  git: GitState;
  folder: string | null;
  recent: string[];
  onAction: (action: BranchAction) => void;
  onRefAction: (action: RefAction, target: RefTarget) => void;
  onRefInspect: (target: RefTarget, mode: "compare" | "worktree") => void;
  options: BranchSettings;
  onOptions: (next: BranchSettings) => void;
}
interface ActionRow { type: "action"; key: BranchAction; label: string; icon: ReactNode; aliases: string; disabled?: boolean; hint?: string }
type Row = BranchPopupRow | ActionRow | { type: "separator"; key: string };
const skipped = (row: Row) => row.type === "separator" || row.type === "action" && !!row.disabled;
const ROW_HEIGHT = 24;
const SEPARATOR_HEIGHT = 9;

/** 菜单模型沿用日志引用动作；弹窗只改变导航方式，不另写一套 Git 命令。 */
function menuItems(items: MenuItem[]): UiMenuItem[] {
  return items.map((item) => item.separator ? { kind: "separator" } : {
    label: item.label ?? "", icon: item.icon, shortcut: item.shortcut, disabled: item.disabled,
    hint: item.hint, checked: item.checked, danger: item.danger, run: item.onSelect,
    submenu: item.children ? menuItems(item.children) : undefined,
  });
}

export default function BranchPicker({ git, folder, recent, onAction, onRefAction, onRefInspect, options, onOptions }: BranchPickerProps) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const chipRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [submenu, setSubmenu] = useState<{ anchor: HTMLElement; target: RefTarget } | null>(null);
  const [gear, setGear] = useState<HTMLElement | null>(null);
  const busy = git.operation?.phase === "running";
  const needle = query.trim().toLocaleLowerCase();
  // 与列表的连续子串过滤保持一致；目录前缀命中时，叶子名称不误标字符。
  const highlighted = (label: string, className?: string) => {
    const start = needle ? label.toLocaleLowerCase().indexOf(needle) : -1;
    return <HighlightedText text={label} className={className} indices={start < 0 ? undefined : Array.from({ length: needle.length }, (_, i) => start + i)} />;
  };
  const shortcut = (action: BranchAction) => formatShortcut(`git.${action}`, settings.editor.keymap);

  useEffect(() => {
    setAnchor(null); setSubmenu(null); setGear(null); setQuery(""); setExpanded(new Map());
  }, [git.root]);

  const close = () => { setAnchor(null); setSubmenu(null); setGear(null); setQuery(""); setActiveKey(null); };
  const run = (action: BranchAction) => { close(); onAction(action); };
  const toggleGroup = (row: Extract<BranchPopupRow, { type: "group" }>, open = !row.expanded) => {
    if (!needle) setExpanded((previous) => new Map(previous).set(row.key, open));
  };

  const rows = useMemo<Row[]>(() => {
    if (!anchor) return [];
    const actions: ActionRow[] = [
      { type: "action", key: "update", label: t("git.updateProject"), icon: <RefreshCw size={14} />, aliases: "update project pull merge", disabled: busy || !canUpdate(git), hint: !git.status?.upstream ? t("git.noUpstream") : undefined },
      { type: "action", key: "commit", label: t("git.commit"), icon: <GitCommit size={14} />, aliases: "commit" },
      { type: "action", key: "push", label: t("git.push"), icon: <Upload size={14} />, aliases: "push", disabled: busy || !canPush(git), hint: !canPush(git) ? t("git.noRemotes") : undefined },
      { type: "action", key: "fetch", label: t("git.fetch"), icon: <Download size={14} />, aliases: "fetch", disabled: busy || !canFetch(git), hint: !canFetch(git) ? t("git.noRemotes") : undefined },
      { type: "action", key: "newBranch", label: t("git.newBranch"), icon: <Plus size={14} />, aliases: "new branch", disabled: busy },
      { type: "action", key: "newTag", label: t("git.newTag"), icon: <Tag size={14} />, aliases: "new tag", disabled: busy || git.lastCommit === null },
      { type: "action", key: "checkoutRev", label: t("git.checkoutRev"), icon: <GitPullRequestArrow size={14} />, aliases: "checkout revision tag", disabled: busy || git.lastCommit === null },
    ];
    const out: Row[] = [];
    for (const action of actions) {
      if (needle && (!options.actionsInSearch || !`${action.label} ${action.aliases}`.toLocaleLowerCase().includes(needle))) continue;
      if (action.key === "newBranch" && out.length && !needle) out.push({ type: "separator", key: "separator:actions" });
      out.push(action);
    }
    const tree = branchPopupRows(git.branches, git.tags, recent, query, options, expanded, {
      recent: t("git.recentBranches"), local: t("git.localBranches"), remote: t("git.remoteBranches"), tag: t("git.tags"),
    });
    if (tree.length && out.length) out.push({ type: "separator", key: "separator:tree" });
    return [...out, ...tree];
  }, [anchor, busy, git, recent, query, needle, options, expanded, t]);
  const activeIndex = rows.findIndex((row) => row.key === activeKey && !skipped(row));
  const active = activeIndex >= 0 ? activeIndex : firstSelectable(rows, (row) => skipped(row) || !!needle && row.type === "group");
  const setActive = (index: number) => setActiveKey(rows[index]?.key ?? null);

  const openRefMenu = (row: Extract<BranchPopupRow, { type: "ref" }>, element?: HTMLElement) => {
    if (busy) return;
    const el = element ?? [...(listRef.current?.querySelectorAll<HTMLElement>("[data-ref-key]") ?? [])].find((node) => node.dataset.refKey === row.key)?.closest<HTMLElement>('[role="option"]');
    if (el) setSubmenu({ anchor: el, target: row.target });
  };
  const activate = (row: Row, element?: HTMLElement) => {
    if (row.type === "action" && !row.disabled) run(row.key);
    else if (row.type === "group") toggleGroup(row);
    else if (row.type === "ref") openRefMenu(row, element);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    if (event.target !== inputRef.current && !(event.target as Element).closest('[role="listbox"]')) return;
    setKeyboard(true);
    const row = rows[active];
    if (event.key === "Enter" && row) { event.preventDefault(); activate(row); return; }
    const input = event.target === inputRef.current ? inputRef.current : null;
    // 保留搜索文本的左右移动；只有光标到边界时才展开树或进入子菜单。
    if (event.key === "ArrowRight" && (!input || input.selectionStart === input.value.length)) {
      if (row?.type === "group") toggleGroup(row, true);
      else if (row?.type === "ref") openRefMenu(row);
      else return;
      event.preventDefault(); return;
    }
    if (event.key === "ArrowLeft" && (!input || input.selectionStart === 0)) {
      if (row?.type === "group" && row.expanded && !needle) toggleGroup(row, false);
      else if (row && "parent" in row && row.parent) setActiveKey(row.parent);
      else return;
      event.preventDefault(); return;
    }
    if (input && (event.key === "Home" || event.key === "End")) return;
    const next = listNavigate(event.key, { items: rows, active, isSection: skipped, wrap: true });
    if (next !== null) { event.preventDefault(); setActive(next); }
  };
  const menu = submenu ? menuItems(buildRefMenu(submenu.target, {
    t, keymapScheme: settings.editor.keymap, current: git.status?.branch ?? "", upstream: upstreamOf(git.branches, submenu.target),
    detached: git.status?.detached ?? false, remotes: git.probe?.remotes.length ?? 0, fresh: git.lastCommit === null,
    onAction: (action, target) => { close(); onRefAction(action, target); },
    onCompareWith: (target) => { close(); onRefInspect(target, "compare"); },
    onDiffWithWorktree: (target) => { close(); onRefInspect(target, "worktree"); },
  })) : [];
  const closeSubmenu = () => { setSubmenu(null); inputRef.current?.focus({ preventScroll: true }); };
  if (!git.root && !folder) return null;
  const status = git.status;
  const operation = git.operation?.phase === "running" ? git.operation : null;
  const title = operation ? `${t(`git.operation.${operation.kind}`)} · ${operation.target}` : [git.root ?? folder,
    status?.ahead ? t("git.aheadN", { count: status.ahead }) : "", status?.behind ? t("git.behindN", { count: status.behind }) : ""].filter(Boolean).join(" · ");
  const listHeight = Math.min(440, rows.reduce((height, row) => height + (row.type === "separator" ? SEPARATOR_HEIGHT : ROW_HEIGHT), 0));

  return <div className="toolbar-chip-host">
    <button ref={chipRef} type="button" className={`toolbar-chip${anchor ? " is-open" : ""}`} {...tooltipAttrs(title ?? "")}
      aria-label={t(git.root ? "panel.sourceControl" : "git.vcs")} aria-haspopup="dialog" aria-expanded={!!anchor}
      onClick={(event) => {
        if (anchor) { close(); return; }
        setKeyboard(event.detail === 0); setAnchor(chipRef.current);
      }}>
      <GitBranch size={14} aria-hidden="true" />
      <span className="toolbar-chip-label">{git.root ? status?.branch ?? "—" : t("git.vcs")}</span>
      {!!status?.behind && <ArrowDownLeft size={12} aria-hidden="true" />}
      {!!status?.ahead && <ArrowUpRight size={12} aria-hidden="true" />}
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    <Popup open={!!anchor} anchor={anchor} onClose={close} autoFocus
      aria-label={t("git.branches")} className={`branch-popup${keyboard ? " is-keyboard" : ""}`}>
      {!git.root ? <button type="button" className="popover-item" onClick={() => run("initRepo")}><GitBranch size={14} />{t("git.initRepo")}</button> : <div className="branch-popup-content" onKeyDown={onKeyDown}>
        <div className="branch-popup-head">
          <SearchField className="branch-popup-search" ref={inputRef} data-autofocus value={query} placeholder={t("git.searchBranch")} aria-label={t("git.searchBranch")} spellCheck={false}
            onChange={(value) => { setQuery(value); setActiveKey(null); setSubmenu(null); }} />
          <button type="button" className="icon-button is-inline" aria-label={t("git.fetch")} disabled={busy || !canFetch(git)} {...tooltipAttrs(t(git.operation?.kind === "fetch" && busy ? "git.fetching" : "git.fetch"))}
            onClick={() => { void git.fetch(); }}><Download size={14} /></button>
          <button type="button" className="icon-button is-inline" aria-label={t("git.viewOptions")} aria-haspopup="menu" aria-expanded={!!gear} {...tooltipAttrs(t("git.viewOptions"))}
            onClick={(event) => setGear(gear ? null : event.currentTarget)}><Settings size={14} /></button>
        </div>
        <div ref={listRef} className="branch-popup-list-wrap" style={{ height: Math.max(48, listHeight) }}>
          <List items={rows} getKey={(row) => row.key} activeIndex={active} onActiveChange={(i) => { setActive(i); }}
            rowHeight={ROW_HEIGHT} sectionHeightOf={(row) => row.type === "separator" ? SEPARATOR_HEIGHT : ROW_HEIGHT}
            isSection={skipped} renderSection={(row) => row.type === "separator" ? <span className="branch-popup-separator" role="separator" /> : row.type === "action" ? <span className="branch-popup-row is-disabled" {...tooltipAttrs(row.hint ?? "")}>
              {row.icon}{highlighted(row.label, "branch-popup-label")}{shortcut(row.key) && <span className="branch-popup-keys">{shortcut(row.key)}</span>}</span> : null}
            focusable={false} hoverSelects aria-label={t("git.branches")} className="branch-popup-list"
            empty={<span>{t("git.searchNoHit")}</span>}
            onActivate={(row, _, event) => { setKeyboard(event.type === "keydown"); activate(row, event.currentTarget as HTMLElement); }}
            onContextMenu={(row, _, event) => { if (row.type === "ref") { event.preventDefault(); openRefMenu(row, event.currentTarget as HTMLElement); } }}
            renderItem={(row) => {
              if (row.type === "separator") return null;
              if (row.type === "action") return <span className="branch-popup-row">{row.icon}{highlighted(row.label, "branch-popup-label")}{shortcut(row.key) && <span className="branch-popup-keys">{shortcut(row.key)}</span>}</span>;
              if (row.type === "group") return <span className="branch-popup-row branch-popup-group" style={{ paddingLeft: row.depth * 16 }}>
                <ChevronRight size={12} className={row.expanded ? "is-expanded" : ""} aria-hidden="true" />{row.depth > 0 && <Folder size={14} aria-hidden="true" />}<span className="branch-popup-label">{row.label}</span></span>;
              return <span data-ref-key={row.key} className={`branch-popup-row${row.current ? " is-current" : ""}`} style={{ paddingLeft: row.depth * 16 }} {...tooltipAttrs(row.target.name)}>
                {/* 当前分支使用参考窗口的斜向引用标记，与普通标签图标区分。 */}
                {row.current ? <svg width={14} height={14} viewBox="0 0 16 16" className="branch-popup-current-icon" fill="none" aria-hidden="true">
                  <path d="M8.6 2.5h4.9v4.9l-6.1 6.1a1 1 0 0 1-1.41 0L2.5 10.01a1 1 0 0 1 0-1.41L8.6 2.5Z" stroke="currentColor" strokeLinejoin="round" />
                  <circle cx={11} cy={5} r={1} fill="currentColor" />
                </svg> : row.target.kind === "tag" ? <Tag size={14} aria-hidden="true" /> : <button type="button" className={`branch-popup-star${row.favorite ? " is-favorite" : ""}`} aria-label={t("git.toggleFavorite")} aria-pressed={row.favorite}
                  // 列表会阻止默认鼠标聚焦；星标保留按钮焦点，Enter 才会继续切换收藏。
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); onOptions(withFavoriteToggled(options, row.target.name)); }}>
                  <GitBranch size={14} className="branch-popup-branch-icon" /><Star size={14} className="branch-popup-star-icon" /></button>}
                {highlighted(row.label, "branch-popup-label branch-popup-name")}
                {row.current && <span className="branch-popup-current">{t("git.currentBranchBadge")}</span>}
                {row.target.kind !== "tag" && row.upstream && <span className="branch-popup-upstream">{row.upstream}</span>}
                <ChevronRight size={10} className="branch-popup-sub-arrow" aria-hidden="true" />
              </span>;
            }} />
        </div>
      </div>}
      {submenu && <Popup open anchor={submenu.anchor} placement="right-start" offset={2} autoFocus onClose={closeSubmenu} role="presentation" className="branch-popup-submenu">
        <MenuList items={menu} onDone={() => setSubmenu(null)} onCloseLevel={closeSubmenu} aria-label={submenu.target.name} />
      </Popup>}
      {gear && <Menu open anchor={gear} placement="bottom-end" onClose={() => { setGear(null); inputRef.current?.focus(); }} aria-label={t("git.viewOptions")} items={[
        { label: t("git.groupByDirectory"), checked: options.groupByDirectory, run: () => onOptions({ ...options, groupByDirectory: !options.groupByDirectory }) },
        { label: t("git.actionsInSearch"), checked: options.actionsInSearch, run: () => onOptions({ ...options, actionsInSearch: !options.actionsInSearch }) },
        { kind: "separator" },
        { label: t("git.showRecentBranches"), checked: options.showRecent, run: () => onOptions({ ...options, showRecent: !options.showRecent }) },
        { label: t("git.showTags"), checked: options.showTags, run: () => onOptions({ ...options, showTags: !options.showTags }) },
      ]} />}
    </Popup>
  </div>;
}
