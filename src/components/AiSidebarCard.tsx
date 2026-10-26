import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveX, Loader2, Pin, PinOff } from "lucide-react";
import { useI18n } from "../i18n";
import { AI_NAMES } from "../lib/aiCli";
import type { AiSession } from "../lib/aiSessions";
import type { AiSessionActivity } from "../lib/aiRuntime";
import AiProviderIcon from "./AiProviderIcon";

/** 指针要在行上停留多久才弹详情气泡；扫过列表时不该一路开花。 */
const HOVER_OPEN_DELAY_MS = 500;
/** 指针离开后的宽限：跨进行内缝隙或小抖动不该把气泡闪灭。 */
const HOVER_CLOSE_DELAY_MS = 120;

function formatAbsolute(timestamp: number | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 侧栏会话卡片：竖向导轨线、供应商图标、标题、相对时间，
 * 悬停时右侧时间换成「置顶 / 归档」两颗快捷按钮，停住 0.5s 浮出详情气泡。
 *
 * 结构与视觉对照参考实现（sidebar-conversation-card）：行高 2rem、内层胶囊 1.9375rem、
 * 图标轴线 0.875rem、标题左缩进 1.75rem。右键菜单与重命名/删除对话框由上层统一持有。
 */
export const AiSidebarCard = memo(function AiSidebarCard({
  session,
  selected,
  openInTab,
  timeLabel,
  activity,
  workspace,
  onOpen,
  onMenu,
  onPin,
  onArchive,
}: {
  session: AiSession;
  /** 当前激活标签就是它。 */
  selected: boolean;
  /** 已在编辑区开着标签（未激活），标题染主色。 */
  openInTab: boolean;
  /** 行尾相对时间；由上层按该行所属章节与排序模式决定读哪个时间戳。 */
  timeLabel?: string;
  activity: AiSessionActivity;
  workspace: string | null;
  onOpen: (id: string) => void;
  onMenu: (session: AiSession, x: number, y: number) => void;
  onPin: (session: AiSession) => void;
  onArchive: (session: AiSession) => void;
}) {
  const { t } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const pinned = session.pinned === true;
  const archived = session.archived === true;
  // 原生历史里提不出标题时 meta 就是空的；列表上不能显示一条空白。
  const title = session.title || t("ai.untitledSession");

  const clearTimers = () => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  useEffect(() => clearTimers, []);
  const hoverEnter = useCallback(() => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => { openTimer.current = null; setHoverOpen(true); }, HOVER_OPEN_DELAY_MS);
  }, []);
  const hoverLeave = useCallback(() => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setHoverOpen(false); }, HOVER_CLOSE_DELAY_MS);
  }, []);
  /**
   * 键盘可达性：只有「键盘方式」获得的焦点才打开气泡（对照参考的 `:focus-visible` 守卫）。
   * 鼠标点击行内按钮同样送来 focus，那时不该弹气泡——指针自己会走悬停路径打开它。
   */
  const hoverFocus = useCallback((event: React.FocusEvent) => {
    let keyboard = false;
    try { keyboard = event.target instanceof Element && event.target.matches(":focus-visible"); } catch { keyboard = false; }
    if (keyboard) hoverEnter();
  }, [hoverEnter]);

  // 气泡贴着行右侧、与行顶对齐展开；列表滚动或窗口缩放时跟着走，不能漂在原地。
  const [rowBox, setRowBox] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!hoverOpen) { setRowBox(null); return; }
    const measure = () => {
      const rect = row.current?.getBoundingClientRect();
      if (!rect) return;
      const next = { left: rect.right + 8, top: Math.max(12, Math.min(rect.top, window.innerHeight - 32)) };
      setRowBox((current) => current && current.left === next.left && current.top === next.top ? current : next);
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => { window.removeEventListener("scroll", measure, true); window.removeEventListener("resize", measure); };
  }, [hoverOpen]);

  return (
    <div
      ref={row}
      className={`ai-scard${archived ? " is-archived" : ""}`}
      data-session-id={session.id}
      onMouseEnter={hoverEnter}
      onMouseLeave={hoverLeave}
      onFocus={hoverFocus}
      onBlur={hoverLeave}
      onContextMenu={(event) => {
        event.preventDefault();
        // 右键菜单接管这一行：先收掉气泡，两层浮层不该叠在同一处（对照参考）。
        clearTimers();
        setHoverOpen(false);
        onMenu(session, event.clientX, event.clientY);
      }}
    >
      <div className={`ai-scard-pill${selected ? " is-selected" : ""}`}>
        <button
          type="button"
          className="ai-scard-main"
          onClick={() => onOpen(session.id)}
          title={`${AI_NAMES[session.provider]} · ${title}`}
          aria-current={selected ? "page" : undefined}
        >
          {/* 只保留供应商图标与连续导轨；运行中图标呼吸闪动指示状态。 */}
          <span aria-hidden className="ai-scard-rail" />
          <span aria-hidden className={`ai-scard-icon${activity === "running" ? " is-running" : ""}`}>
            <AiProviderIcon provider={session.provider} size={12} />
          </span>
          <span className={`ai-scard-title${openInTab ? " is-open" : ""}`}>{title}</span>
        </button>
        <div className="ai-scard-side">
          <span className="ai-scard-meta">
            {activity === "running" ? (
              <span className="ai-scard-spinner" title={t("ai.runtime.running")}>
                <Loader2 size={14} aria-hidden className="is-spinning" />
              </span>
            ) : timeLabel ? <span className="ai-scard-time">{timeLabel}</span> : null}
          </span>
          <div className="ai-scard-actions">
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => { event.stopPropagation(); onPin(session); }}
              title={pinned ? t("ai.sidebar.unpin") : t("ai.sidebar.pin")}
              aria-label={pinned ? t("ai.sidebar.unpin") : t("ai.sidebar.pin")}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => { event.stopPropagation(); onArchive(session); }}
              title={archived ? t("ai.archived.restoreHint") : t("ai.archived.button")}
              aria-label={archived ? t("ai.archived.restore") : t("ai.archived.button")}
            >
              {archived ? <ArchiveX size={14} /> : <Archive size={14} />}
            </button>
          </div>
        </div>
      </div>
      {hoverOpen && rowBox ? (
        <div className="ai-scard-hover" role="tooltip" style={{ left: rowBox.left, top: rowBox.top }}>
          <div className="ai-scard-hover-body">
            <div className="ai-scard-hover-head">
              <p className="ai-scard-hover-title">{title}</p>
              <div className="ai-scard-hover-chips">
                <span className="ai-chip"><AiProviderIcon provider={session.provider} size={11} />{AI_NAMES[session.provider]}</span>
                {archived ? <span className="ai-chip is-muted"><Archive size={11} />{t("ai.archived.view")}</span> : null}
              </div>
            </div>
            <dl className="ai-scard-hover-facts">
              <div className="ai-scard-hover-fact"><dt>{t("ai.sidebar.factWorkspace")}</dt><dd dir="ltr">{workspace ?? "—"}</dd></div>
              <div className="ai-scard-hover-fact"><dt>{t("ai.sidebar.factCreated")}</dt><dd>{formatAbsolute(session.createdAt)}</dd></div>
              <div className="ai-scard-hover-fact"><dt>{t("ai.sidebar.factActivity")}</dt><dd>{formatAbsolute(session.lastActivity ?? session.createdAt)}</dd></div>
              <div className="ai-scard-hover-fact"><dt>{t("ai.sidebar.factSessionId")}</dt><dd dir="ltr" className="ai-scard-hover-mono">{session.id}</dd></div>
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default AiSidebarCard;
