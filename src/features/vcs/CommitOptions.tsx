/**
 * 提交选项弹层：仅保留已接通的作者、Sign-off、Git 钩子和 TODO 检查。
 */
import type { ReactNode, RefObject } from "react";
import { Checkbox } from "../../ui/Checkbox";
import { Input } from "../../ui/Input";
import { Popup } from "../../ui/Popup";
import { useI18n } from "../../i18n";
import styles from "./CommitView.module.css";

export interface CommitOptionsState {
  author: string;
  signOff: boolean;
  runHooks: boolean;
  checkTodo: boolean;
}

const STORAGE_KEY = "forge:vcs:commitOptions:v1";

export const DEFAULT_COMMIT_OPTIONS: CommitOptionsState = {
  author: "",
  signOff: false,
  runHooks: true,
  checkTodo: false,
};

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

export function saveCommitOptions(options: CommitOptionsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // ignore
  }
}

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

export interface CommitOptionsBodyProps {
  options: CommitOptionsState;
  onChange: (options: CommitOptionsState) => void;
}

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

export interface CommitOptionsPopupProps {
  anchor: RefObject<HTMLElement | null> | HTMLElement | null;
  open: boolean;
  onClose: () => void;
  options: CommitOptionsState;
  onChange: (options: CommitOptionsState) => void;
}

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
