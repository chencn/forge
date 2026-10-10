import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../i18n";

interface Props {
  /** 要写进剪贴板的那段文本。 */
  text: string;
}

/**
 * 一小段可复制文本的复制开关（报错原因、命令输出等）。
 *
 * 剪贴板只能在用户动作中写入，因此需要提供可点击的按钮，而不能只把文本设为可选中。
 * 浏览器与 Tauri 都使用 `navigator.clipboard`；写入失败时不修改标签，避免给出已复制的错觉。
 */
export default function CopyButton({ text }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="copy-button"
      title={t(copied ? "action.copied" : "action.copy")}
      aria-label={t(copied ? "action.copied" : "action.copy")}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
