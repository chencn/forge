/**
 * 提交选项弹层：仅保留已接通的作者、Sign-off、Git 钩子和 TODO 检查。
 */
import type { ReactNode, RefObject } from "react";
import { Checkbox } from "../../ui/Checkbox";
import { Input } from "../../ui/Input";
import { Popup } from "../../ui/Popup";
import { useI18n } from "../../i18n";
import styles from "./CommitView.module.css";

/** 提交选项的持久化状态。 */
export interface CommitOptionsState {
  author: string;
  signOff: boolean;
  runHooks: boolean;
  checkTodo: boolean;
}

/** localStorage 键（v1：结构变更时升版本）。 */
const STORAGE_KEY = "forge:vcs:commitOptions:v1";

/** 出厂默认：不指定作者、跑钩子、其余关。 */
export const DEFAULT_COMMIT_OPTIONS: CommitOptionsState = {
  author: "",
  signOff: false,
  runHooks: true,
  checkTodo: false,
};

/** 读回提交选项；缺键/解析失败/字段类型不符逐项回退默认值。 */
export function loadCommitOptions(): CommitOptionsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COMMIT_OPTIONS;
    const saved = JSON.parse(raw);
    // 显式读取仍支持的字段，避免旧存储中的已移除选项再次进入状态和保存结果。
    return {
      author: typeof saved.author === "string" ? saved.author : DEFAULT_COMMIT_OPTIONS.author,
      signOff: typeof saved.signOff === "boolean" ? saved.signOff : DEFAULT_COMMIT_OPTIONS.signOff,
      runHooks: typeof saved.runHooks === "boolean" ? saved.runHooks : DEFAULT_COMMIT_OPTIONS.runHooks,
      checkTodo: typeof saved.checkTodo === "boolean" ? saved.checkTodo : DEFAULT_COMMIT_OPTIONS.checkTodo,
    };
  } catch {
    return DEFAULT_COMMIT_OPTIONS;
  }
}

/** 持久化提交选项；存储不可用时静默忽略。 */
export function saveCommitOptions(options: CommitOptionsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // ignore
  }
}

/** 弹层里的一个分组小节。 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.optSection}>
      <h3 className={styles.optTitle}>
        <span>{title}</span>
      </h3>
      <div className={styles.optBody}>{children}</div>
    </section>
  );
}

/** {@link CommitOptionsBody} 的入参。 */
export interface CommitOptionsBodyProps {
  options: CommitOptionsState;
  onChange: (options: CommitOptionsState) => void;
}

/** 选项表单体：改动即回传 onChange 并落盘。 */
export function CommitOptionsBody({ options, onChange }: CommitOptionsBodyProps) {
  const { t } = useI18n();

  const update = (partial: Partial<CommitOptionsState>) => {
    const next = { ...options, ...partial };
    onChange(next);
    saveCommitOptions(next);
  };

  return (
    <>
      <Section title="Git">
        <label className={styles.optField}>
          <span>{t("git.author")}</span>
          <Input
            value={options.author}
            placeholder={t("git.authorPlaceholder")}
            title={t("git.authorHint")}
            aria-label={t("git.author")}
            onChange={(e) => update({ author: e.target.value })}
          />
        </label>
        <Checkbox
          checked={options.signOff}
          onChange={(v) => update({ signOff: v })}
          label={t("git.signOff")}
        />
      </Section>

      <Section title={t("git.commitChecks")}>
        <div className={styles.optRow}>
          <Checkbox
            checked={options.runHooks}
            onChange={(v) => update({ runHooks: v })}
            label={t("git.runHooks")}
          />
        </div>
        <div className={styles.optRow}>
          <Checkbox
            checked={options.checkTodo}
            onChange={(v) => update({ checkTodo: v })}
            label={t("git.checkTodo")}
          />
        </div>
      </Section>
    </>
  );
}

/** {@link CommitOptionsPopup} 的入参。 */
export interface CommitOptionsPopupProps {
  anchor: RefObject<HTMLElement | null> | HTMLElement | null;
  open: boolean;
  onClose: () => void;
  options: CommitOptionsState;
  onChange: (options: CommitOptionsState) => void;
}

/** 锚定在提交按钮上方的选项弹层。 */
export function CommitOptionsPopup({
  anchor,
  open,
  onClose,
  options,
  onChange,
}: CommitOptionsPopupProps) {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <Popup
      open={open}
      anchor={anchor}
      placement="top-start"
      offset={6}
      onClose={() => onClose()}
      role="dialog"
      aria-label={t("git.commitOptions")}
      className={styles.options}
    >
      <div tabIndex={-1} data-autofocus className={styles.optFocus} />
      <CommitOptionsBody options={options} onChange={onChange} />
    </Popup>
  );
}
