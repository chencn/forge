import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../ui/Dialog";
import { Checkbox } from "../../ui/Checkbox";
import { useI18n } from "../../i18n";
import type { FsEntry } from "../../lib/fs";
import styles from "./FileRefactor.module.css";

export type RefactorDialogState =
  | {
      kind: "rename";
      entry: FsEntry;
      onConfirm: (newName: string, searchInComments: boolean) => void;
    }
  | {
      kind: "move";
      entries: FsEntry[];
      targetDir: string;
      onConfirm: (newTargetDir: string, searchInComments: boolean) => void;
    }
  | {
      kind: "safeDelete";
      entries: FsEntry[];
      onConfirm: (searchInComments: boolean) => void;
    }
  | null;

export interface FileRefactorDialogsProps {
  state: RefactorDialogState;
  onClose: () => void;
}

export function FileRefactorDialogs({ state, onClose }: FileRefactorDialogsProps) {
  const { t } = useI18n();

  const [nameValue, setNameValue] = useState("");
  const [targetDirValue, setTargetDirValue] = useState("");
  const [searchInComments, setSearchInComments] = useState(true);
  const [searchInStrings, setSearchInStrings] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state) return;

    if (state.kind === "rename") {
      setNameValue(state.entry.name);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        // 对标 IDEA：重命名文件时仅选中文件名主体，不包含后缀扩展名
        const dotIndex = state.entry.name.lastIndexOf(".");
        if (state.entry.kind === "file" && dotIndex > 0) {
          input.setSelectionRange(0, dotIndex);
        } else {
          input.select();
        }
      });
    } else if (state.kind === "move") {
      setTargetDirValue(state.targetDir);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [state]);

  if (!state) return null;

  if (state.kind === "rename") {
    return (
      <Dialog
        open
        title={t("project.view.rename")}
        onClose={onClose}
        buttons={[
          {
            label: t("dialog.confirm"),
            role: "default",
            disabled: !nameValue.trim() || nameValue === state.entry.name,
            onClick: () => {
              state.onConfirm(nameValue.trim(), searchInComments);
              onClose();
            },
          },
          {
            label: t("dialog.cancel"),
            role: "cancel",
            onClick: onClose,
          },
        ]}
      >
        <div className={styles.form}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("dialog.rename")}:</label>
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameValue.trim() && nameValue !== state.entry.name) {
                  state.onConfirm(nameValue.trim(), searchInComments);
                  onClose();
                }
              }}
            />
          </div>
          <div className={styles.options}>
            <label className={styles.checkboxLabel}>
              <Checkbox checked={searchInComments} onChange={setSearchInComments} />
              <span>{t("project.view.searchInComments")}</span>
            </label>
          </div>
        </div>
      </Dialog>
    );
  }

  if (state.kind === "move") {
    return (
      <Dialog
        open
        title={t("project.view.move")}
        onClose={onClose}
        buttons={[
          {
            label: t("dialog.confirm"),
            role: "default",
            disabled: !targetDirValue.trim(),
            onClick: () => {
              state.onConfirm(targetDirValue.trim(), searchInComments);
              onClose();
            },
          },
          {
            label: t("dialog.cancel"),
            role: "cancel",
            onClick: onClose,
          },
        ]}
      >
        <div className={styles.form}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              {t("project.view.moveToDirectory", { count: state.entries.length })}
            </label>
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              value={targetDirValue}
              onChange={(e) => setTargetDirValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && targetDirValue.trim()) {
                  state.onConfirm(targetDirValue.trim(), searchInComments);
                  onClose();
                }
              }}
            />
          </div>
          <div className={styles.options}>
            <label className={styles.checkboxLabel}>
              <Checkbox checked={searchInComments} onChange={setSearchInComments} />
              <span>{t("project.view.searchForReferences")}</span>
            </label>
          </div>
        </div>
      </Dialog>
    );
  }

  if (state.kind === "safeDelete") {
    return (
      <Dialog
        open
        title={t("project.view.safeDelete")}
        onClose={onClose}
        buttons={[
          {
            label: t("dialog.confirm"),
            role: "default",
            onClick: () => {
              state.onConfirm(searchInComments);
              onClose();
            },
          },
          {
            label: t("dialog.cancel"),
            role: "cancel",
            onClick: onClose,
          },
        ]}
      >
        <div className={styles.form}>
          <div>
            {t("project.view.safeDeletePrompt", { count: state.entries.length })}
          </div>
          <div className={styles.options}>
            <label className={styles.checkboxLabel}>
              <Checkbox checked={searchInComments} onChange={setSearchInComments} />
              <span>{t("project.view.searchInComments")}</span>
            </label>
            <label className={styles.checkboxLabel}>
              <Checkbox checked={searchInStrings} onChange={setSearchInStrings} />
              <span>{t("project.view.viewUsagesBeforeDelete")}</span>
            </label>
          </div>
        </div>
      </Dialog>
    );
  }

  return null;
}
