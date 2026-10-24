import { ArrowDown } from "lucide-react";
import { useI18n } from "../i18n";

/**
 * 「回到底部」浮动入口。
 *
 * 有待读时把它压成一个数字，避免长串输出把气泡撑歪；没有待读时只剩一个箭头，
 * 告诉用户此刻并没有贴着底部。文案始终走 title/aria-label，图形不承载信息。
 */
export default function AiJumpToBottom({ unseen, onClick }: { unseen: number; onClick: () => void }) {
  const { t } = useI18n();
  const label = unseen ? t("ai.chat.newMessages", { count: unseen }) : t("ai.chat.scrollToBottom");
  return <button type="button" className={`ai-jump-bottom${unseen ? " has-count" : ""}`} onClick={onClick} title={label} aria-label={label}>
    <ArrowDown size={14} aria-hidden="true" />
    {unseen ? <span>{unseen > 99 ? "99+" : unseen}</span> : null}
  </button>;
}
