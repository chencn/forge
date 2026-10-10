import { FileWarning } from "lucide-react";

interface PaneNoticeProps {
  /** 说明文字，通常是 describeError 翻好的那句。 */
  text: string;
}

/**
 * 正文区中央的一则说明：打不开的文件、比对不了的二进制都摆在这里。
 *
 * 不用底部横幅是因为横幅只闪一下，人还没看就走了；这类「这份东西就是不给你看」
 * 的原因得一直留在原处，直到用户关掉标签。
 */
export default function PaneNotice({ text }: PaneNoticeProps) {
  return (
    <div className="doc-notice" role="alert">
      <FileWarning size={30} aria-hidden="true" />
      <p className="doc-notice-text">{text}</p>
    </div>
  );
}
