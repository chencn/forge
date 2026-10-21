import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";

export type DialogKind =
  | "newFolder"
  | "newFile"
  | "newBranch"
  | "renameBranch"
  | "newTag"
  | "checkoutRev"
  | "worktree"
  | "patch"
  | "rename"
  | "delete"
  | "rollback"
  | "deleteRef"
  | "resetHard"
  | "pushUpTo"
  | "discard"
  | "closeRoot"
  | "resetSettings"
  | "installUpdate"
  | "restartUpdate";

export interface DialogRequest {
  kind: DialogKind;
  /** 新建时是预填名；重命名、删除和两种 git 确认框里是当前要写在文案上的名字（提交短哈希）。 */
  name: string;
  /** 删除确认里显示的完整路径；创建补丁时是要落进补丁的那个文件。 */
  path?: string;
  /**
   * 回滚确认里要移入回收站的新文件清单（仓库相对路径）：删除与回滚在 Git 面板是同一个动作，
   * 用户得先看见这一次会带走哪些文件。
   */
  fileList?: string[];
  /** 回滚时除了删新文件，还有已跟踪的改动要恢复成索引内容，确认框里多提一句。 */
  restoreTracked?: boolean;
  /** 删除对象是否为目录，决定用哪句告警文案。 */
  isDirectory?: boolean;
  /** 一次删一批时的条数；大于 1 时文案改成「某某 等 N 项」。 */
  count?: number;
  /** 新建分支的起点、工作树要签出的引用；「推送此前所有提交」里是目标分支名；空表示从当前 HEAD 起。 */
  from?: string;
  /** 创建补丁时的差异右侧（那次提交），左侧走 `from`；硬重置与推送那两句确认框里是交给 git 的完整哈希。 */
  revision?: string;
  /** 删除引用的确认：删的是本地分支、远端分支还是标签，决定用哪句告警。 */
  refKind?: "local" | "remote" | "tag";
  /** 填的是落盘位置那几类，画一句「落点：…」，省得写相对名时不知道会落到哪个目录。 */
  hint?: string;
  /** 关闭文件夹确认框的原因：有未保存修改、有运行中后台任务，或两者兼有。 */
  closeReason?: "dirty" | "running" | "both";
}

interface PromptDialogProps {
  request: DialogRequest;
  onSubmit: (name: string, extra: string) => void;
  onCancel: () => void;
}

const TITLE_KEY: Record<DialogKind, TranslationKey> = {
  newFolder: "dialog.newFolder",
  newFile: "dialog.newFile",
  newBranch: "dialog.newBranch",
  renameBranch: "git.dialogRenameBranch",
  newTag: "git.dialogNewTag",
  checkoutRev: "git.dialogCheckoutRev",
  worktree: "git.dialogWorktree",
  patch: "git.dialogPatch",
  rename: "dialog.rename",
  delete: "dialog.delete",
  rollback: "git.rollback",
  deleteRef: "git.dialogDeleteRef",
  resetHard: "git.dialogResetHard",
  pushUpTo: "git.dialogPushUpTo",
  discard: "dialog.discardTitle",
  closeRoot: "dialog.closeRootTitle",
  resetSettings: "dialog.resetAllTitle",
  installUpdate: "dialog.updateTitle",
  restartUpdate: "update.restartConfirmTitle",
};

/** 只有这几类需要输入名字，其余是确认框。 */
const INPUT_KINDS: DialogKind[] = [
  "newFolder",
  "newFile",
  "newBranch",
  "renameBranch",
  "newTag",
  "checkoutRev",
  "worktree",
  "patch",
  "rename",
];

/** 这两类填的是一个落盘位置，不是名字，字段标题和提示语都换掉。 */
const PATH_KINDS: Partial<Record<DialogKind, TranslationKey>> = {
  worktree: "git.worktreePathPlaceholder",
  patch: "git.patchPathPlaceholder",
};

/** 这一类在落盘位置之外还收一个可选名字：填了先开一个新分支再签出，留空直接签出所选那条。 */
const SECOND_FIELD: Partial<Record<DialogKind, { label: TranslationKey; placeholder: TranslationKey }>> =
  {
    worktree: {
      label: "git.worktreeBranchField",
      placeholder: "git.worktreeBranchPlaceholder",
    },
  };

/** 更新询问的否定项是「稍后再更新」，不是放弃一次操作，所以不用通用「取消」。 */
const UPDATE_KINDS: DialogKind[] = ["installUpdate", "restartUpdate"];

/**
 * 主按钮文案。没列进来的那几类（新建文件夹、文件、分支、标签、工作树、补丁）都是「创建」。
 */
const CONFIRM_KEY: Partial<Record<DialogKind, TranslationKey>> = {
  delete: "dialog.confirm",
  rollback: "dialog.confirm",
  deleteRef: "dialog.confirm",
  resetHard: "dialog.confirm",
  pushUpTo: "dialog.confirm",
  rename: "dialog.confirm",
  restartUpdate: "dialog.confirm",
  resetSettings: "dialog.resetAll",
  discard: "dialog.discard",
  closeRoot: "dialog.closeRootConfirm",
  installUpdate: "dialog.installNow",
  checkoutRev: "git.checkoutShort",
  renameBranch: "dialog.rename",
};

export function confirmKey(kind: DialogKind): TranslationKey {
  return CONFIRM_KEY[kind] ?? "dialog.create";
}

export function cancelKey(kind: DialogKind): TranslationKey {
  return UPDATE_KINDS.includes(kind) ? "dialog.updateLater" : "dialog.cancel";
}

export default function PromptDialog({ request, onSubmit, onCancel }: PromptDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.name);
  const [extra, setExtra] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const withInput = INPUT_KINDS.includes(request.kind);
  /** 非空说明这一类填的是落盘位置，字段标题和提示语跟着换。 */
  const pathPlaceholder = PATH_KINDS[request.kind];
  /** 非空说明这一类在落盘位置之外还收一个可选名字。 */
  const secondField = SECOND_FIELD[request.kind];
  const danger =
    request.kind === "delete" ||
    request.kind === "rollback" ||
    request.kind === "deleteRef" ||
    request.kind === "resetHard" ||
    request.kind === "discard" ||
    request.kind === "closeRoot" ||
    request.kind === "resetSettings";

  /** 确认框那句话，按要删的是文件、文件夹还是哪种引用挑。 */
  const bodyText = () => {
    if (request.kind === "resetSettings") return t("dialog.resetAllBody");
    // 更新安装询问：name 里带的是新版本号。
    if (request.kind === "installUpdate") return t("dialog.updateBody", { version: request.name });
    if (request.kind === "restartUpdate")
      return t("update.restartConfirmBody", { version: request.name });
    if (request.kind === "discard") return t("dialog.discardBody", { name: request.name });
    if (request.kind === "closeRoot") {
      if (request.closeReason === "both") {
        return t("dialog.closeRootDirtyAndRunning", { name: request.name });
      }
      if (request.closeReason === "dirty") {
        return t("dialog.closeRootDirty", { name: request.name });
      }
      return t("dialog.closeRootRunning", { name: request.name });
    }
    if (request.kind === "resetHard") return t("git.resetHardWarning", { rev: request.name });
    if (request.kind === "pushUpTo")
      return t("git.pushUpToWarning", { rev: request.name, branch: request.from ?? "" });
    if (request.kind === "deleteRef") {
      return request.refKind === "remote"
        ? t("git.deleteRemoteWarning", { name: request.name })
        : t("git.deleteRefWarning", { name: request.name });
    }
    if (request.kind === "rollback") {
      return (request.count ?? 0) > 1
        ? t("git.rollbackNewFilesWarning", { name: request.name, count: request.count ?? 0 })
        : t("git.rollbackNewFileWarning", { name: request.name });
    }
    if (request.kind === "delete" && request.count !== undefined && request.count > 1) {
      return t("dialog.deleteManyWarning", { name: request.name, count: request.count });
    }
    return request.isDirectory
      ? t("dialog.deleteFolderWarning", { name: request.name })
      : t("dialog.deleteFileWarning", { name: request.name });
  };

  useEffect(() => {
    if (!withInput) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = request.name.lastIndexOf(".");
    // 重命名默认只选中主名，扩展名留着不动。
    input.setSelectionRange(0, request.kind === "rename" && dot > 0 ? dot : request.name.length);
  }, [request.kind, request.name, withInput]);

  const submit = () => {
    const next = value.trim();
    if (withInput && !next) return;
    onSubmit(next || request.name, extra.trim());
  };

  // 重命名只能点取消关掉。点遮罩、点输入框都会把同一次点击送到遮罩上，对话框刚出来就被收掉。
  const sticky = request.kind === "rename";

  return (
    <div
      className="dialog-backdrop is-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !sticky) onCancel();
      }}
    >
      <div
        className="dialog-scrim"
        onMouseDown={(event) => {
          event.preventDefault();
          if (sticky) return;
          onCancel();
        }}
      />
      <div
        className={`dialog${danger ? " is-danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t(TITLE_KEY[request.kind])}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !withInput) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <p className="dialog-title">{t(TITLE_KEY[request.kind])}</p>

        {!withInput ? (
          <>
            <p className="dialog-body">{bodyText()}</p>
            {request.fileList && request.fileList.length > 0 ? (
              <ul className="dialog-file-list">
                {request.fileList.map((item) => (
                  <li key={item} title={item}>
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
            {request.restoreTracked ? (
              <p className="dialog-body">{t("git.rollbackTrackedNote")}</p>
            ) : null}
            {request.path ? (
              <p className="dialog-note" title={request.path}>
                {request.path}
              </p>
            ) : null}
          </>
        ) : (
          <label className="dialog-field">
            <span>{pathPlaceholder ? t("git.pathField") : t("dialog.name")}</span>
            <input
              ref={inputRef}
              className="text-input"
              value={value}
              placeholder={pathPlaceholder ? t(pathPlaceholder) : t("dialog.namePlaceholder")}
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        )}

        {withInput && secondField ? (
          <label className="dialog-field">
            <span>{t(secondField.label)}</span>
            <input
              className="text-input"
              value={extra}
              placeholder={t(secondField.placeholder)}
              spellCheck={false}
              onChange={(event) => setExtra(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        ) : null}

        {withInput && request.hint ? (
          <p className="dialog-note" title={request.hint}>
            {t("git.dialogTarget", { dir: request.hint })}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            {t(cancelKey(request.kind))}
          </button>
          <button
            type="button"
            className={`button ${danger ? "is-danger" : "is-primary"}`}
            onClick={submit}
            // 空名点确认本来就会被 submit 挡掉，摆一颗点不动的按钮不如直接置灰。
            disabled={withInput && value.trim() === ""}
            autoFocus={!withInput}
          >
            {t(confirmKey(request.kind))}
          </button>
        </div>
      </div>
    </div>
  );
}
