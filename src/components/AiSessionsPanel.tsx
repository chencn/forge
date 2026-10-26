import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsUp, Copy, Crosshair, Ellipsis, Eye, ListChevronsDownUp, ListChevronsUpDown, Loader2, RefreshCw, Search, Settings, SquarePen, X } from "lucide-react";
import { useI18n } from "../i18n";
import { AI_NAMES, cliDesktopAvailable, refreshAiCli, useAiCli } from "../lib/aiCli";
import type { AiSession, AiSessionAction } from "../lib/aiSessions";
import { AI_SEARCH_MIN_QUERY, isSearchQueryActive } from "../lib/aiSearch";
import { useAiSessionSearch } from "../hooks/useAiSessionSearch";
import { getAiSessionActivity, subscribeAiChanges } from "../lib/aiRuntime";
import {
  formatAiRelativeTime,
  moveAiSidebarSection,
  RECENT_PAGE_SIZE,
  registerAiSidebarListCommands,
  resetAiSidebarRecentLimit,
  revealMoreAiSidebarRecent,
  setAiSidebarRecentFilter,
  setAiSidebarSortMode,
  setAllAiSidebarSections,
  setShowAiSidebarArchived,
  setShowAiSidebarRecent,
  toggleAiSidebarSection,
  useAiSidebarListCommands,
  useAiSidebarView,
} from "../lib/aiSidebarView";
import type { AiSidebarSectionId, AiSidebarSectionKey } from "../lib/aiSidebarView";
import AiActionDialog from "./AiActionDialog";
import AiSearchResults from "./AiSearchResults";
import AiSidebarCard from "./AiSidebarCard";
import ContextMenu, { flatMenu } from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import Popover from "./Popover";
import { refreshAiSessionHistory } from "../hooks/useAiSessions";

/**
 * AI 会话侧栏列表。结构与视觉对照参考实现（codeg 的 sidebar + conversation list）：
 * 固定的「新建会话 / 搜索」两行不随列表滚动，其下是「置顶 / 会话 / 最近」三个可折叠章节，
 * 会话行是带导轨线与状态点的胶囊卡片，悬停可置顶、归档并浮出详情气泡。
 *
 * forge 只支持单个项目：没有参考实现里的项目（文件夹）分组与 worktree 层级，
 * 全部会话直接落在「会话」章节；章节顺序、排序模式与「显示最近 / 已归档」
 * 的偏好存在本地（`lib/aiSidebarView`）。真正的动作仍交给上层 `onAction`。
 */
export default function AiSessionsPanel({ sessions, openIds, activeId, storageError, workspace, onOpen, onAction, onNew }: {
  /** 该工作区的全部会话，含标签已关闭与已归档的记录。 */
  sessions: AiSession[];
  /** 当前打开着的会话 id。 */
  openIds: string[];
  /** 当前激活的标签 id，形如 `ai|<sessionId>`。 */
  activeId: string | null;
  /** 本地存储读写失败；为真时列表上方显示错误提示。 */
  storageError: boolean;
  /** 当前项目根；非桌面端为 null，此时搜索不可用。 */
  workspace: string | null;
  /** 点会话行时回调，由上层打开或聚焦对应标签。 */
  onOpen: (id: string) => void;
  /** 重命名/归档/置顶/删除的意图，由上层先落后端再改本地状态。 */
  onAction: (action: AiSessionAction) => void;
  /** 「新建会话」：打开草稿欢迎页。 */
  onNew: () => void;
}) {
  const { t } = useI18n();
  const cli = useAiCli();
  const desktop = cliDesktopAvailable();
  const view = useAiSidebarView();
  /** 搜索框原文；节流与归属判定在 `useAiSessionSearch` 里。 */
  const [query, setQuery] = useState("");
  const search = useAiSessionSearch(workspace, query, false);
  const searching = desktop && workspace !== null && isSearchQueryActive(query);
  /** 共享的当前时刻：每分钟走一次，让相对时间标签不至停滞。 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  /** 任务状态在 lib/aiRuntime 的全局 store 里；订阅它的变更让状态点与旋转图标即时跟上。 */
  const [, bumpActivity] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => subscribeAiChanges(bumpActivity), []);
  /** 等待确认的重命名/删除目标；非空时弹出对话框。 */
  const [pending, setPending] = useState<{ action: "rename" | "delete"; session: AiSession } | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [recentFilterAnchor, setRecentFilterAnchor] = useState<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  /** 「最近」章节的行按钮；从行尾小图标收起列表后把焦点还给它。 */
  const recentMoreButton = useRef<HTMLButtonElement>(null);

  // 「定位当前会话」：标题行按钮经命令总线驱动；列表不在时静默无效。
  useEffect(() => {
    registerAiSidebarListCommands({
      scrollToActive: () => {
        if (!activeId) return;
        list.current?.querySelector(`[data-session-id="${activeId.slice(3)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      },
    });
    return () => registerAiSidebarListCommands(null);
  }, [activeId]);

  /** 子代理只从右侧子代理栏进入，左侧的所有章节都只展示顶层会话。 */
  const isChild = (session: AiSession) => !!session.parentSessionId;
  const pinned = useMemo(() => sessions
    .filter((session) => session.pinned === true && session.archived !== true && !isChild(session))
    .sort((a, b) => (b.pinnedAt ?? b.createdAt) - (a.pinnedAt ?? a.createdAt)), [sessions]);
  /** 「会话」章节：全部未置顶会话，按当前排序模式；已归档的仅在开关打开时带出。 */
  const listed = useMemo(() => sessions
    .filter((session) => session.pinned !== true && !isChild(session) && (view.showArchived || session.archived !== true))
    .sort((a, b) => view.sortMode === "updated"
      ? (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt) || b.createdAt - a.createdAt
      : b.createdAt - a.createdAt), [sessions, view.sortMode, view.showArchived]);
  /** 「最近」章节：未置顶未归档，按最近活动；可用工具筛选（全部 / Claude / Codex）。 */
  const recent = useMemo(() => sessions
    .filter((session) => session.pinned !== true && session.archived !== true && !isChild(session) &&
      (view.recentFilter === "all" || session.provider === view.recentFilter))
    .sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt)), [sessions, view.recentFilter]);
  const recentShown = recent.slice(0, view.recentLimit ?? RECENT_PAGE_SIZE);
  const recentRemaining = recent.length - recentShown.length;

  /** 行尾相对时间读哪个时间戳，由该行所在章节与排序模式共同决定（对照参考实现）。 */
  const timeLabelFor = (session: AiSession, section: AiSidebarSectionKey): string =>
    formatAiRelativeTime(section === "recent" || view.sortMode === "updated"
      ? session.lastActivity ?? session.createdAt
      : session.createdAt, now);

  const openCardMenu = (session: AiSession, x: number, y: number) => {
    const pinnedNow = session.pinned === true;
    const archivedNow = session.archived === true;
    const items: MenuItem[][] = [
      [{ icon: SquarePen, label: t("ai.newSession"), onSelect: onNew }],
      [
        // Codex 的改名会同步写回原生线程名；Claude 没有写入口，只落 Forge 侧并加锁。
        { label: t("menu.rename"), onSelect: () => setPending({ action: "rename", session }) },
        // 跨会话提问要把另一条会话的 ID 贴进来；侧栏详情气泡不吃指针，只能从这里复制。
        { icon: Copy, label: t("ai.copySessionId"), onSelect: () => void navigator.clipboard.writeText(session.id) },
        pinnedNow
          ? { label: t("ai.sidebar.unpin"), onSelect: () => onAction({ type: "pin", id: session.id, pinned: false }) }
          : { label: t("ai.sidebar.pin"), onSelect: () => onAction({ type: "pin", id: session.id, pinned: true }) },
        archivedNow
          ? { label: t("ai.archived.restore"), onSelect: () => onAction({ type: "archive", id: session.id, archived: false }) }
          : { label: t("ai.archived.button"), onSelect: () => onAction({ type: "archive", id: session.id, archived: true }) },
      ],
      [{ label: t("menu.delete"), danger: true, onSelect: () => setPending({ action: "delete", session }) }],
    ];
    setMenu({ x, y, items: flatMenu(items) });
  };
  const openBackgroundMenu = (x: number, y: number) => {
    const items: MenuItem[][] = [
      [{ icon: SquarePen, label: t("ai.newSession"), onSelect: onNew }],
      [{ label: t("ai.sidebar.showArchived"), checked: view.showArchived, onSelect: () => setShowAiSidebarArchived(!view.showArchived) }],
    ];
    setMenu({ x, y, items: flatMenu(items) });
  };

  const card = (session: AiSession, section: AiSidebarSectionKey): ReactNode => (
    <AiSidebarCard
      key={`${section}:${session.id}`}
      session={session}
      selected={activeId === `ai|${session.id}`}
      openInTab={openIds.includes(session.id)}
      timeLabel={timeLabelFor(session, section)}
      activity={getAiSessionActivity(session.id)}
      workspace={workspace}
      onOpen={onOpen}
      onMenu={openCardMenu}
      onPin={(target) => onAction({ type: "pin", id: target.id, pinned: target.pinned !== true })}
      onArchive={(target) => onAction({ type: "archive", id: target.id, archived: target.archived !== true })}
    />
  );

  const sectionLabel = (section: AiSidebarSectionKey): string =>
    section === "pinned" ? t("ai.sidebar.sectionPinned")
      : section === "recent" ? t("ai.sidebar.sectionRecent")
        : t("ai.sidebar.sectionSessions");

  const recentFilterLabel = view.recentFilter === "claude" ? AI_NAMES.claude
    : view.recentFilter === "codex" ? AI_NAMES.codex : t("ai.sidebar.recentFilterAll");

  /** 一个章节：标题行（悬停露出「新建」按钮——仅会话/最近章节，对照参考；「最近」另带筛选菜单）+ 行列表或空提示。 */
  const sectionBlock = (section: AiSidebarSectionKey, rows: ReactNode[], emptyHint: string): ReactNode => {
    const expanded = view.collapsed[section] !== true;
    const showNewChat = section === "sessions" || section === "recent";
    // 类型类名负责分配章节高度；展开类名让每个章节只滚自己的行列表。
    return <section key={section} className={`ai-ssection has-gap is-${section}${expanded ? " is-expanded" : ""}`}>
      <div className="ai-ssection-head">
        <button type="button" className="ai-ssection-toggle" aria-expanded={expanded} onClick={() => toggleAiSidebarSection(section)}>
          <span>{sectionLabel(section)}</span>
          <ChevronRight aria-hidden size={12} className={`ai-ssection-chevron${expanded ? " is-expanded" : ""}`} />
        </button>
        <div className="ai-ssection-actions">
          {section === "recent" ? (
            <button
              type="button"
              className={`ai-ssection-action${view.recentFilter !== "all" ? " is-on" : ""}${recentFilterAnchor ? " is-open" : ""}`}
              onClick={(event) => { event.stopPropagation(); setRecentFilterAnchor(event.currentTarget); }}
              title={t("ai.sidebar.recentFilterTitle", { filter: recentFilterLabel })}
              aria-label={t("ai.sidebar.recentFilterTitle", { filter: recentFilterLabel })}
            >
              <Ellipsis size={14} aria-hidden />
            </button>
          ) : null}
          {showNewChat ? (
            <button
              type="button"
              className="ai-ssection-action"
              onClick={(event) => { event.stopPropagation(); onNew(); }}
              title={t("ai.newSession")}
              aria-label={t("ai.newSession")}
            >
              <SquarePen size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {expanded ? rows.length ? <div className="ai-ssection-rows">{rows}</div>
        : <div className="ai-ssection-empty">{emptyHint}</div> : null}
    </section>;
  };

  const sections: ReactNode[] = [];
  if (pinned.length > 0) sections.push(sectionBlock("pinned", pinned.map((session) => card(session, "pinned")), ""));
  for (const id of view.sectionOrder) {
    if (id === "sessions") {
      sections.push(sectionBlock("sessions", listed.map((session) => card(session, "sessions")),
        view.showArchived ? t("ai.noSessions") : t("ai.sidebar.noUnarchived")));
      continue;
    }
    if (id === "recent" && view.showRecent) {
      const rows: ReactNode[] = recentShown.map((session) => card(session, "recent"));
      // 已展开超过第一页才给「收起」入口；展开数被删到一页以内时收起按钮就该消失，
      // 否则留下一个点了没有可见效果的开关（对照参考的 canReset 判定）。
      const canReset = view.recentLimit !== null && recentShown.length > RECENT_PAGE_SIZE;
      if (recentRemaining > 0 || canReset) {
        const showMore = recentRemaining > 0;
        const reset = () => {
          resetAiSidebarRecentLimit();
          // 被点的是行尾那颗小图标，收起后它自己消失；焦点先交回行按钮，别落回页面。
          recentMoreButton.current?.focus();
        };
        rows.push(<div key="recent-more" className={`ai-srecent-more${showMore && canReset ? " has-reset" : ""}`}>
          <button ref={recentMoreButton} type="button" className="ai-srecent-button" onClick={showMore ? revealMoreAiSidebarRecent : reset}>
            <span aria-hidden className="ai-srecent-icon">{showMore ? <ChevronDown size={12} /> : <ChevronsUp size={12} />}</span>
            <span className="ai-srecent-label">{showMore ? t("ai.sidebar.showMoreRecent", { count: recentRemaining }) : t("ai.sidebar.resetRecentLimit", { count: RECENT_PAGE_SIZE })}</span>
          </button>
          {showMore && canReset ? (
            <button type="button" className="ai-srecent-reset" title={t("ai.sidebar.resetRecentLimit", { count: RECENT_PAGE_SIZE })} aria-label={t("ai.sidebar.resetRecentLimit", { count: RECENT_PAGE_SIZE })} onClick={reset}>
              <ChevronsUp size={14} aria-hidden />
            </button>
          ) : null}
        </div>);
      }
      const emptyHint = view.recentFilter === "claude" ? t("ai.sidebar.noRecentFor", { name: AI_NAMES.claude })
        : view.recentFilter === "codex" ? t("ai.sidebar.noRecentFor", { name: AI_NAMES.codex })
          : t("ai.sidebar.noRecent");
      sections.push(sectionBlock("recent", rows, emptyHint));
    }
  }

  return (
    <div className="ai-sessions-panel ai-sidebar">
      {/* 探测失败与本地存储失败是两类问题，分别提示，不合并成一条笼统错误。 */}
      {cli.error ? <p className="ai-error" role="alert">{cli.error}</p> : null}
      {storageError ? <p className="ai-error" role="alert">{t("ai.storageError")}</p> : null}
      {/* 固定动作区：不随列表滚动。「新建会话」是主入口，搜索沿用原功能、按参考的行样式重画。 */}
      <div className="ai-sidebar-fixed">
        <button type="button" className="ai-sidebar-nav" onClick={onNew} title={t("ai.newSession")}>
          <SquarePen size={14} aria-hidden />
          <span>{t("ai.newSession")}</span>
        </button>
        {desktop && workspace ? <label className="ai-sidebar-nav ai-sidebar-search">
          <Search size={14} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t("ai.search.placeholder")} aria-label={t("ai.search.placeholder")} spellCheck={false} />
          {query ? <button type="button" className="icon-button is-inline" onClick={() => setQuery("")}
            title={t("ai.search.clear")} aria-label={t("ai.search.clear")}><X size={12} /></button> : null}
        </label> : null}
        {query && !searching ? <p className="ai-search-status">{t("ai.search.tooShort", { count: AI_SEARCH_MIN_QUERY })}</p> : null}
      </div>
      <div
        ref={list}
        className="ai-sidebar-scroll"
        onContextMenu={(event) => { event.preventDefault(); openBackgroundMenu(event.clientX, event.clientY); }}
      >
        {searching ? <AiSearchResults state={search} query={query} archived={false} onOpen={onOpen} />
          : cli.checking && !cli.checked && sessions.length === 0 ? (
            // 首检骨架（对照参考实现）：六条与行同高的占位，比一颗孤立转圈更早说出「这里是列表」。
            <div className="ai-sidebar-loading" role="status" aria-label={t("ai.runtime.loading")}>
              {Array.from({ length: 6 }, (_, index) => <span key={index} className="ai-sidebar-skeleton" aria-hidden="true" />)}
            </div>
          ) : sections}
      </div>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {recentFilterAnchor ? (
        <Popover anchor={recentFilterAnchor} onClose={() => setRecentFilterAnchor(null)} minWidth={160}>
          <div className="ai-view-group" role="radiogroup" aria-label={t("ai.sidebar.recentFilterMenuLabel")}>
            <p className="ai-view-label">{t("ai.sidebar.recentFilterMenuLabel")}</p>
            {([["all", t("ai.sidebar.recentFilterAll")], ["claude", AI_NAMES.claude], ["codex", AI_NAMES.codex]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={view.recentFilter === value}
                className={`ai-view-option${view.recentFilter === value ? " is-on" : ""}`}
                onClick={() => { setAiSidebarRecentFilter(value); setRecentFilterAnchor(null); }}
              >
                <span className="ai-view-check" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
      {pending ? <AiActionDialog title={t(pending.action === "rename" ? "menu.rename" : "ai.deleteSession")}
        confirm={t(pending.action === "rename" ? "dialog.confirm" : "menu.delete")}
        initialValue={pending.action === "rename" ? pending.session.title : undefined} danger={pending.action === "delete"}
        onCancel={() => setPending(null)} onConfirm={(title) => {
          onAction(pending.action === "rename" ? { type: "rename", id: pending.session.id, title } : { type: "delete", id: pending.session.id });
          setPending(null);
        }}>
        {pending.action === "delete" ? <p className="dialog-body">{t("ai.deleteConfirm", { name: pending.session.title || t("ai.untitledSession") })}</p> : null}
      </AiActionDialog> : null}
    </div>
  );
}

/**
 * 侧栏标题行工具组：定位当前会话、展开/收起全部章节、视图选项（排序、章节顺序、
 * 显示最近/已归档、重新检测与设置入口）。视图状态与列表共享（`lib/aiSidebarView`）。
 */
export function AiSessionsToolbar({ onSettings }: { onSettings: () => void }) {
  const { t } = useI18n();
  const cli = useAiCli();
  const view = useAiSidebarView();
  const list = useAiSidebarListCommands();
  const allExpanded = Object.keys(view.collapsed).length === 0;
  const [viewAnchor, setViewAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => { void refreshAiCli(); }, []);
  return <div className="ai-sessions-tools">
    <button type="button" className="icon-button is-inline" title={t("ai.sidebar.locate")} aria-label={t("ai.sidebar.locate")}
      onClick={() => list.scrollToActive?.()}>
      <Crosshair size={14} />
    </button>
    <button type="button" className="icon-button is-inline"
      title={allExpanded ? t("ai.sidebar.collapseAll") : t("ai.sidebar.expandAll")}
      aria-label={allExpanded ? t("ai.sidebar.collapseAll") : t("ai.sidebar.expandAll")}
      onClick={() => setAllAiSidebarSections(!allExpanded)}>
      {allExpanded ? <ListChevronsDownUp size={14} /> : <ListChevronsUpDown size={14} />}
    </button>
    <button type="button" className="icon-button is-inline" onClick={(event) => setViewAnchor(event.currentTarget)}
      title={t("ai.sidebar.viewOptions")} aria-label={t("ai.sidebar.viewOptions")} aria-expanded={viewAnchor !== null}>
      <Eye size={14} />
    </button>
    {viewAnchor ? (
      <Popover anchor={viewAnchor} onClose={() => setViewAnchor(null)} minWidth={224}>
        <div className="ai-view-menu">
          <p className="ai-view-label">{t("ai.sidebar.sortBy")}</p>
          {([["created", t("ai.sidebar.sortByCreatedAt")], ["updated", t("ai.sidebar.sortByUpdatedAt")]] as const).map(([value, label]) => (
            <button key={value} type="button" className={`ai-view-option${view.sortMode === value ? " is-on" : ""}`}
              role="radio" aria-checked={view.sortMode === value} onClick={() => setAiSidebarSortMode(value)}>
              <span className="ai-view-check" aria-hidden />{label}
            </button>
          ))}
          <hr className="ai-view-sep" />
          <p className="ai-view-label">{t("ai.sidebar.sectionOrder")}</p>
          {view.sectionOrder.map((id: AiSidebarSectionId, index) => (
            <div key={id} className="ai-view-order-row">
              <span className="ai-view-position" aria-hidden>{index + 1}</span>
              <span className="ai-view-order-name">{id === "sessions" ? t("ai.sidebar.sectionSessions") : t("ai.sidebar.sectionRecent")}</span>
              <span className="ai-view-order-actions">
                <button type="button" disabled={index === 0} aria-label={t("ai.sidebar.moveUp")} onClick={() => moveAiSidebarSection(id, -1)}>▲</button>
                <button type="button" disabled={index === view.sectionOrder.length - 1} aria-label={t("ai.sidebar.moveDown")} onClick={() => moveAiSidebarSection(id, 1)}>▼</button>
              </span>
            </div>
          ))}
          <hr className="ai-view-sep" />
          <button type="button" className={`ai-view-option${view.showRecent ? " is-on" : ""}`} role="menuitemcheckbox" aria-checked={view.showRecent}
            onClick={() => setShowAiSidebarRecent(!view.showRecent)}>
            <span className="ai-view-check" aria-hidden />{t("ai.sidebar.showRecent")}
          </button>
          <button type="button" className={`ai-view-option${view.showArchived ? " is-on" : ""}`} role="menuitemcheckbox" aria-checked={view.showArchived}
            onClick={() => setShowAiSidebarArchived(!view.showArchived)}>
            <span className="ai-view-check" aria-hidden />{t("ai.sidebar.showArchived")}
          </button>
          <hr className="ai-view-sep" />
          <button type="button" className="ai-view-option" onClick={() => { refreshAiSessionHistory(); void refreshAiCli(true); setViewAnchor(null); }}>
            {cli.checking ? <Loader2 size={14} className="is-spinning" aria-hidden /> : <RefreshCw size={14} aria-hidden />}{t("ai.check")}
          </button>
          <button type="button" className="ai-view-option" onClick={() => { setViewAnchor(null); onSettings(); }}>
            <Settings size={14} aria-hidden />{t("ai.manageCli")}
          </button>
        </div>
      </Popover>
    ) : null}
  </div>;
}
