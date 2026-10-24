import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n";

interface AiActionDialogProps {
  /** 对话框标题，通常是「重命名」「删除会话」这类动作名。 */
  title: string;
  /** 标题下方的正文；删除确认那句提示放在这里。 */
  children?: ReactNode;
  /** 确认按钮文案。 */
  confirm: string;
  /** 危险动作用红色按钮，并把初始焦点放在取消上。 */
  danger?: boolean;
  /** 传了值就渲染输入框（重命名用）；不传则只做确认（删除用）。 */
  initialValue?: string;
  /** 确认时回调，参数是去掉首尾空白的输入值；无输入框时为空串。 */
  onConfirm: (value: string) => void;
  /** 取消、按 Escape 或点关闭时回调，由调用方决定能否真的关掉。 */
  onCancel: () => void;
}

/**
 * 原生模态层负责焦点圈定、Escape 和关闭后的焦点恢复。
 *
 * 重命名与删除共用一个组件：两者都要二次确认，差别只在有没有输入框和是否用危险样式。
 */
export default function AiActionDialog({ title, children, confirm, danger, initialValue, onConfirm, onCancel }: AiActionDialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [value, setValue] = useState(initialValue ?? "");
  // 用原生 showModal/close 而不是自己画遮罩：焦点圈定、Escape、惰性背景都由浏览器负责。
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog ai-action-dialog" aria-labelledby={titleId}
      // Escape 走 onCancel：统一交给上层决定能否关闭（例如安装进行中不允许关）。
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <form onSubmit={(event) => { event.preventDefault(); onConfirm(value.trim()); }}>
        <h2 id={titleId} className="dialog-title">{title}</h2>
        {children}
        {initialValue !== undefined ? (
          <label className="dialog-field">
            <span>{t("ai.sessionName")}</span>
            {/* 传了 initialValue 就渲染输入框；此时初始焦点落在输入框，而不是取消按钮。 */}
            <input autoFocus className="text-input" value={value} maxLength={120}
              onChange={(event) => setValue(event.target.value)} />
          </label>
        ) : null}
        <div className="dialog-actions">
          {/* 纯确认框（无输入框）把焦点放在取消上，避免误触危险操作。 */}
          <button type="button" autoFocus={initialValue === undefined} className="button" onClick={onCancel}>{t("dialog.cancel")}</button>
          {/* 有输入框时，名字为空白不允许提交。 */}
          <button type="submit" className={`button ${danger ? "is-danger" : "is-primary"}`}
            disabled={initialValue !== undefined && !value.trim()}>{confirm}</button>
        </div>
      </form>
    </dialog>
  );
}
