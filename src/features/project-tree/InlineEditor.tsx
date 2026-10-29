/**
 * 树节点行内就地编辑组件 (InlineEditor)
 *
 * 1:1 对标 openidea / IntelliJ IDEA：
 * 1. 挂载时自动聚焦并选中主文件名（重命名时自动排除扩展名，如 `App.tsx` 选中 `App`）；
 * 2. 实时校验合法性，遇到非法字符或重名在下方以气泡弹窗 (Popup) 显示具体原因；
 * 3. 敲击 Enter 提交，Esc 取消；新建条目失焦时自动取消，重命名有效失焦时自动提交。
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Popup } from "../../ui/Popup";
import {
  splitExtension,
  validateName,
  type EditingState,
  type NameCheck,
} from "./model";
import styles from "./ProjectTree.module.css";

export interface InlineEditorProps {
  /** 当前编辑态 */
  readonly editing: EditingState;
  /** 同级已存在的文件名/文件夹名列表 */
  readonly siblings: Iterable<string>;
  /** 提交编辑回调，返回 true 表示成功完成并退出编辑态 */
  readonly onCommit: (value: string) => Promise<boolean> | boolean;
  /** 取消编辑回调 */
  readonly onCancel: () => void;
}

export function InlineEditor({
  editing,
  siblings,
  onCommit,
  onCancel,
}: InlineEditorProps) {
  const initialValue =
    editing.kind === "rename" ? editing.currentName : editing.initial ?? "";
  const [value, setValue] = useState(initialValue);
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);

  // 实时校验文件名合法性与重名检测
  const check: NameCheck = useMemo(() => {
    return validateName(value, {
      siblings,
      current: editing.kind === "rename" ? editing.currentName : undefined,
      caseInsensitive: true,
      windows: true,
    });
  }, [value, siblings, editing]);

  const showError =
    check.error !== null &&
    (submitted || value !== initialValue) &&
    !(editing.kind === "new" && !value);

  // 初始选中处理：重命名仅选中文件名主名（排除扩展名）
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });

    if (editing.kind === "rename") {
      const [stem] = splitExtension(initialValue);
      input.setSelectionRange(0, stem.length);
    } else {
      input.setSelectionRange(0, value.length);
    }
  }, [editing.kind, initialValue, value.length]);

  const handleFinish = async (commit: boolean) => {
    if (finishedRef.current) return;
    if (!commit) {
      finishedRef.current = true;
      onCancel();
      return;
    }
    setSubmitted(true);
    if (check.error !== null) return;

    finishedRef.current = true;
    const ok = await onCommit(value.trim());
    if (!ok) {
      finishedRef.current = false;
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className={clsx(styles.inlineInput, showError && styles.inlineInvalid)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={
          editing.kind === "rename"
            ? "New name"
            : editing.nodeKind === "dir"
            ? "New folder name"
            : "New file name"
        }
        aria-invalid={showError ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void handleFinish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            void handleFinish(false);
          }
        }}
        onBlur={() => {
          // IDEA 规则：新建失焦取消；重命名有效且变更则提交
          if (editing.kind === "new") {
            void handleFinish(false);
            return;
          }
          const valid = check.error === null && !!value.trim();
          void handleFinish(valid && value.trim() !== initialValue);
        }}
      />

      {showError && (
        <Popup
          open
          anchor={inputRef}
          placement="bottom-start"
          offset={2}
          role="alert"
          autoFocus={false}
          restoreFocus={false}
          closeOnOutsideClick={false}
          onClose={() => void handleFinish(false)}
          className={styles.inlineError}
        >
          {check.error}
        </Popup>
      )}
    </>
  );
}
