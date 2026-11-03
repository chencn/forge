import { useState, type ReactNode } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { useI18n } from "../../../i18n";
import { Button } from "../../../ui/Button";
import Select from "../../../components/Select";
import { gitProbe } from "../../../lib/git";
import type { VcsSettings } from "../../../lib/settings";
import { Loader2 } from "lucide-react";

function useVcs() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;
  const update = (diff: Partial<VcsSettings>) => patch({ vcs: { ...v, ...diff } });
  return { t, v, update };
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">{children}</div>
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <Select
        label={label}
        placeholder="—"
        value={checked ? "yes" : "no"}
        disabled={disabled}
        options={[
          { value: "yes", label: t("common.yes") },
          { value: "no", label: t("common.no") },
        ]}
        onChange={(next) => onChange(next === "yes")}
      />
    </div>
  );
}

function LimitRow({
  label,
  checked,
  value,
  unit,
  onChecked,
  onValue,
}: {
  label: string;
  checked: boolean;
  value: number;
  unit: string;
  onChecked: (value: boolean) => void;
  onValue: (value: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <Select
        label={label}
        placeholder="—"
        value={checked ? "yes" : "no"}
        options={[
          { value: "yes", label: t("common.yes") },
          { value: "no", label: t("common.no") },
        ]}
        onChange={(next) => onChecked(next === "yes")}
      />
      <input
        type="number"
        className="text-input"
        value={value}
        disabled={!checked}
        onChange={(event) => onValue(parseInt(event.target.value, 10) || value)}
      />
      <span className="settings-unit">{unit}</span>
    </div>
  );
}

/** 提交：非模态提交、清空初始说明。 */
export function VcsCommitPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow
        label={t("vcs.nonModalCommit")}
        checked={v.nonModalCommit}
        onChange={(value) => update({ nonModalCommit: value })}
      />
      <p className="settings-note">{t("vcs.nonModalHint")}</p>
      <SwitchRow
        label={t("vcs.clearInitialMessage")}
        checked={v.clearInitialCommitMessage}
        onChange={(value) => update({ clearInitialCommitMessage: value })}
      />
    </Rows>
  );
}

/** 提交说明检查。 */
export function VcsMessageInspectionsPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow
        label={t("vcs.blankLineAfterSubject")}
        checked={v.blankLineAfterSubject}
        onChange={(value) => update({ blankLineAfterSubject: value })}
      />
      <LimitRow
        label={t("vcs.limitSubjectLine")}
        checked={v.limitSubjectLine}
        value={v.subjectLineLimit}
        unit={t("vcs.characters")}
        onChecked={(value) => update({ limitSubjectLine: value })}
        onValue={(subjectLineLimit) => update({ subjectLineLimit })}
      />
      <LimitRow
        label={t("vcs.limitBodyLine")}
        checked={v.limitBodyLine}
        value={v.bodyLineLimit}
        unit={t("vcs.characters")}
        onChecked={(value) => update({ limitBodyLine: value })}
        onValue={(bodyLineLimit) => update({ bodyLineLimit })}
      />
      <SwitchRow
        label={t("vcs.showRightMargin")}
        checked={v.showRightMargin}
        disabled={!v.limitSubjectLine && !v.limitBodyLine}
        onChange={(value) => update({ showRightMargin: value })}
      />
      <SwitchRow
        label={t("vcs.wrapRightMargin")}
        checked={v.wrapRightMargin}
        disabled={!v.limitBodyLine}
        onChange={(value) => update({ wrapRightMargin: value })}
      />
    </Rows>
  );
}

/** 提交前检查。 */
export function VcsCommitChecksPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow
        label={t("git.checkTodo")}
        checked={v.checkTodo}
        onChange={(value) => update({ checkTodo: value })}
      />
    </Rows>
  );
}

/** Git 可执行文件探测。 */
export function VcsGitPage({ workspace }: { workspace?: string | null }) {
  const { t } = useI18n();
  const [testStatus, setTestStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      const probe = await gitProbe(workspace || ".");
      if (probe.available) {
        setTestStatus({
          ok: true,
          msg: probe.repoRoot ? t("vcs.testOk", { root: probe.repoRoot }) : t("vcs.testNoRoot"),
        });
      } else {
        setTestStatus({ ok: false, msg: t("vcs.testMissing") });
      }
    } catch (err) {
      setTestStatus({
        ok: false,
        msg: t("vcs.testFailed", { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Rows>
      <div className="settings-row">
        <span className="settings-label">{t("vcs.gitPath")}</span>
        <Button size="small" onClick={handleTest} disabled={testing}>
          {testing ? <Loader2 size={13} className="is-spinning" /> : null}
          {t("vcs.testButton")}
        </Button>
      </div>
      <p className="settings-note">{t("vcs.gitPathHint")}</p>
      {testStatus ? (
        <p className={`settings-note ${testStatus.ok ? "is-pass" : "is-fail"}`}>{testStatus.msg}</p>
      ) : null}
    </Rows>
  );
}

/** 提交警告与签名。 */
export function VcsCommitWarningsPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow label={t("vcs.warnCrlf")} checked={v.warnCrlf} onChange={(value) => update({ warnCrlf: value })} />
      <SwitchRow
        label={t("vcs.warnDetachedHead")}
        checked={v.warnDetachedHead}
        onChange={(value) => update({ warnDetachedHead: value })}
      />
      <SwitchRow label={t("git.signOff")} checked={v.signOffCommit} onChange={(value) => update({ signOffCommit: value })} />
      <LimitRow
        label={t("vcs.warnLargeFiles")}
        checked={v.warnLargeFiles}
        value={v.largeFilesLimitMb}
        unit="MB"
        onChecked={(value) => update({ warnLargeFiles: value })}
        onValue={(largeFilesLimitMb) => update({ largeFilesLimitMb })}
      />
      <SwitchRow
        label={t("vcs.warnBadFileNames")}
        checked={v.warnBadFileNames}
        onChange={(value) => update({ warnBadFileNames: value })}
      />
    </Rows>
  );
}

/** 推送与受保护分支。 */
export function VcsPushPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <div className="settings-row">
        <span className="settings-label">{t("vcs.showPushDialog")}</span>
        <Select
          label={t("vcs.showPushDialog")}
          placeholder="—"
          value={v.showPushDialog}
          options={[
            { value: "always", label: t("vcs.pushDialog.always") },
            { value: "protected", label: t("vcs.pushDialog.protected") },
            { value: "never", label: t("vcs.pushDialog.never") },
          ]}
          onChange={(value) => {
            if (value === "always" || value === "protected" || value === "never") update({ showPushDialog: value });
          }}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">{t("vcs.protectedBranches")}</span>
        <input
          type="text"
          className="text-input"
          value={v.protectedBranches}
          placeholder={t("vcs.protectedPlaceholder")}
          onChange={(event) => update({ protectedBranches: event.target.value })}
        />
      </div>
      <p className="settings-note">{t("vcs.protectedHint")}</p>
    </Rows>
  );
}

/** 更新方式。 */
export function VcsUpdatePage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow
        label={t("git.autoUpdateOnPushRejected")}
        checked={v.autoUpdateOnPushRejected}
        onChange={(value) => update({ autoUpdateOnPushRejected: value })}
      />
      <div className="settings-row">
        <span className="settings-label">{t("git.updateMethod")}</span>
        <Select
          value={v.updateMethod}
          label={t("git.updateMethod")}
          placeholder={t("git.updateMethod")}
          onChange={(value) => update({ updateMethod: value === "rebase" ? "rebase" : "merge" })}
          options={[
            { value: "merge", label: t("git.updateMerge") },
            { value: "rebase", label: t("git.updateRebase") },
          ]}
        />
      </div>
      <p className="settings-note">{t("vcs.updateHint")}</p>
    </Rows>
  );
}

/** 确认对话框。 */
export function VcsConfirmationPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow
        label={t("vcs.showUpdateOptions")}
        checked={v.showUpdateOptions}
        onChange={(value) => update({ showUpdateOptions: value })}
      />
    </Rows>
  );
}

/** 变更与历史。 */
export function VcsChangesPage() {
  const { t, v, update } = useVcs();
  return (
    <Rows>
      <SwitchRow
        label={t("vcs.highlightDirtyDirs")}
        checked={v.highlightDirtyDirectories}
        onChange={(value) => update({ highlightDirtyDirectories: value })}
      />
      <div className="settings-row">
        <span className="settings-label">{t("vcs.onPatchCreated")}</span>
        <Select
          label={t("vcs.onPatchCreated")}
          placeholder="—"
          value={v.onPatchCreated}
          options={[
            { value: "clipboard", label: t("vcs.patchClipboard") },
            { value: "open", label: t("vcs.patchOpen") },
            { value: "file", label: t("vcs.patchFile") },
          ]}
          onChange={(value) => {
            if (value === "clipboard" || value === "open" || value === "file") update({ onPatchCreated: value });
          }}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">{t("vcs.limitHistoryTo")}</span>
        <input
          type="number"
          className="text-input"
          value={v.limitHistoryRows}
          onChange={(event) => update({ limitHistoryRows: parseInt(event.target.value, 10) || 1000 })}
        />
        <span className="settings-unit">{t("vcs.rows")}</span>
      </div>
    </Rows>
  );
}
