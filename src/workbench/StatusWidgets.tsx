/**
 * 状态栏里跟着活动编辑器走的两段（对齐 openidea StatusItems 的 CaretStatus / IndentStatus）：
 * Line:Column 与缩进。数据来自 lib/caretStatus 的外部存储，订阅者只有这两个小组件，
 * 按键不会牵动整棵 App 树。
 */
import { useSyncExternalStore } from "react";
import { caretSnapshot, subscribeCaret } from "../lib/caretStatus";
import { useI18n } from "../i18n";

/** Line:Column 段：选中多行/多字符时附在后面（IDEA 的口径）。 */
export function CaretStatus({ path }: { path: string | null }) {
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
    <span className="status-note" title={t("status.caretTip")}>
      {text}
    </span>
  );
}

/** 缩进段：forge 全工程一把尺（空格 × tabSize），点开设置页改。 */
export function IndentStatus({ tabSize, onOpenSettings }: { tabSize: number; onOpenSettings?: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="status-note"
      title={t("status.indentTip")}
      onClick={onOpenSettings}
    >
      {t("status.indentSpaces", { count: tabSize })}
    </button>
  );
}
