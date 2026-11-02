/**
 * 状态栏里跟着活动编辑器走的两段（对齐 openidea StatusItems 的 CaretStatus / IndentStatus）：
 * Line:Column 与缩进。数据来自 lib/caretStatus 的外部存储，订阅者只有这两个小组件，
 * 按键不会牵动整棵 App 树。
 */
import { useRef, useState, useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import { caretSnapshot, subscribeCaret } from "../lib/caretStatus";
import { indentOverrideOf, indentRevision, setIndentOverride, subscribeIndent } from "../lib/indentOverride";
import { Popup } from "../ui/Popup";
import { useI18n } from "../i18n";

/** Line:Column 段：选中多行/多字符时附在后面；点击打开 Go to Line（IDEA 的口径）。 */
export function CaretStatus({
  path,
  onJump,
}: {
  path: string | null;
  onJump?: () => void;
}) {
  const { t } = useI18n();
  const info = useSyncExternalStore(subscribeCaret, caretSnapshot);
  if (!path || !info || info.path !== path) return null;
  const text =
    info.carets > 1
      ? t("status.carets", { count: info.carets })
      : info.selectedChars > 0
        ? `${info.line}:${info.col} (${info.selectedChars})`
        : `${info.line}:${info.col}`;
  return (
    <button type="button" className="status-note" title={t("status.caretTip")} onClick={onJump}>
      {text}
    </button>
  );
}

const INDENT_CHOICES = [2, 4, 8] as const;

/**
 * 缩进段：显示当前生效档（每文件覆盖 > .editorconfig > 全局），点开菜单按文件切。
 * 切换只写进 lib/indentOverride 的覆盖表，编辑器那边订阅同一张表重装配。
 */
export function IndentStatus({
  path,
  defaultTabSize,
}: {
  /** 活动文档路径；null（没有活动编辑器）时只显示全局档，不可点。 */
  path: string | null;
  /** 不算覆盖时的档位（.editorconfig 或全局设置），由调用方算好传入。 */
  defaultTabSize: number;
}) {
  const { t } = useI18n();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // 订阅版本号：菜单里切一档，这里重渲染拿最新覆盖，编辑器也靠同一版本号重装配。
  useSyncExternalStore(subscribeIndent, indentRevision);
  const override = path ? indentOverrideOf(path) : null;
  const useTabs = override?.useTabs ?? false;
  const spaces = override?.spaces ?? defaultTabSize;
  const label = useTabs
    ? t("status.indentTabs")
    : t("status.indentSpaces", { count: spaces });
  const pick = (choice: { spaces?: number; useTabs?: boolean } | null) => {
    if (path) setIndentOverride(path, choice);
    setMenuOpen(false);
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="status-note"
        title={path ? t("status.indentTip") : t("status.indentTipGlobal")}
        onClick={path ? () => setMenuOpen(true) : undefined}
        disabled={!path}
      >
        {label}
      </button>
      {menuOpen && path ? (
        <Popup
          open
          anchor={anchorRef}
          onClose={() => setMenuOpen(false)}
          placement="top"
          role="menu"
          aria-label={t("status.indentTip")}
        >
          {INDENT_CHOICES.map((count) => (
            <button
              key={count}
              type="button"
              role="menuitemradio"
              aria-checked={!useTabs && spaces === count}
              className="menu-item"
              onClick={() => pick({ spaces: count })}
            >
              {!useTabs && spaces === count ? <Check size={13} /> : <span className="menu-check-gap" />}
              {t("status.indentSpaces", { count })}
            </button>
          ))}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={useTabs}
            className="menu-item"
            onClick={() => pick({ useTabs: true })}
          >
            {useTabs ? <Check size={13} /> : <span className="menu-check-gap" />}
            {t("status.indentTabs")}
          </button>
          {override ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => pick(null)}
            >
              <span className="menu-check-gap" />
              {t("status.indentReset")}
            </button>
          ) : null}
        </Popup>
      ) : null}
    </>
  );
}
