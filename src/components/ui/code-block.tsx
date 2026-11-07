import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../../i18n";
import "./ai-elements.css";

/** 代码块：复制按钮 + 自定义语法渲染插槽；`terminal` 时按终端配色呈现。 */
export function CodeBlock({ text, language, children, terminal = false }: { text: string; language?: string; children?: ReactNode; terminal?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setCopied(false);
    return () => { revision.current++; clearTimeout(timer.current); };
  }, [text]);
  const copy = async () => {
    const current = revision.current;
    try {
      await navigator.clipboard.writeText(text);
      if (current !== revision.current) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { /* Clipboard denial must never report success. */ }
  };
  return <section data-slot={terminal ? "terminal" : "code-block"} className="ai-element-code" dir="ltr">
    <header><span>{language}</span><button type="button" onClick={() => void copy()} aria-label={t(copied ? "action.copied" : "action.copy")} title={t(copied ? "action.copied" : "action.copy")}>
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button></header>
    {children ?? <pre><code>{text}</code></pre>}
  </section>;
}
