import { useState, type ReactNode } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { useI18n } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { Checkbox } from "../../../ui/Checkbox";
import Select from "../../../components/Select";
import { gitProbe } from "../../../lib/git";
import type { VcsSettings } from "../../../lib/settings";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

function VcsForm({ children }: { children: ReactNode }) {
  return (
    <div className="settings-rows vcs-settings">
      <div className="settings-rows-limit">{children}</div>
    </div>
  );
}

function NumberLimit({
  checked,
  label,
  value,
  unit,
  disabled,
  onChecked,
  onValue,
}: {
  checked: boolean;
  label: string;
  value: number;
  unit: string;
  disabled?: boolean;
  onChecked: (value: boolean) => void;
  onValue: (value: number) => void;
}) {
  return (
    <div className="vcs-inline">
      <Checkbox checked={checked} disabled={disabled} onChange={onChecked} label={label} />
      <input
        type="number"
        className="text-input vcs-number"
        value={value}
        disabled={disabled || !checked}
        onChange={(event) => onValue(parseInt(event.target.value, 10) || value)}
      />
      <span className="vcs-unit">{unit}</span>
    </div>
  );
}

/**
 * 提交：非模态提交、说明检查、提交前检查。
 */
export function VcsCommitPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;
  const update = (diff: Partial<VcsSettings>) => patch({ vcs: { ...v, ...diff } });

  return (
    <VcsForm>
      <div className="vcs-group">
        <div className="vcs-options">
          <div className="vcs-choice">
            <Checkbox
              checked={v.nonModalCommit}
              onChange={(value) => update({ nonModalCommit: value })}
              label={t("vcs.nonModalCommit")}
            />
            <p className="vcs-hint is-indent">{t("vcs.nonModalHint")}</p>
          </div>
          <Checkbox
            checked={v.clearInitialCommitMessage}
            onChange={(value) => update({ clearInitialCommitMessage: value })}
            label={t("vcs.clearInitialMessage")}
          />
        </div>
      </div>

      <section className="vcs-group">
        <h4 className="vcs-group-title">{t("vcs.messageInspections")}</h4>
        <div className="vcs-options">
          <Checkbox
            checked={v.blankLineAfterSubject}
            onChange={(value) => update({ blankLineAfterSubject: value })}
            label={t("vcs.blankLineAfterSubject")}
          />
          <NumberLimit
            checked={v.limitSubjectLine}
            label={t("vcs.limitSubjectLine")}
            value={v.subjectLineLimit}
            unit={t("vcs.characters")}
            onChecked={(value) => update({ limitSubjectLine: value })}
            onValue={(subjectLineLimit) => update({ subjectLineLimit })}
          />
          <NumberLimit
            checked={v.limitBodyLine}
            label={t("vcs.limitBodyLine")}
            value={v.bodyLineLimit}
            unit={t("vcs.characters")}
            onChecked={(value) => update({ limitBodyLine: value })}
            onValue={(bodyLineLimit) => update({ bodyLineLimit })}
          />
          <div className="vcs-nested">
            <Checkbox
              checked={v.showRightMargin}
              disabled={!v.limitSubjectLine && !v.limitBodyLine}
              onChange={(value) => update({ showRightMargin: value })}
              label={t("vcs.showRightMargin")}
            />
            <Checkbox
              checked={v.wrapRightMargin}
              disabled={!v.limitBodyLine}
              onChange={(value) => update({ wrapRightMargin: value })}
              label={t("vcs.wrapRightMargin")}
            />
          </div>
        </div>
      </section>

      <section className="vcs-group">
        <h4 className="vcs-group-title">{t("vcs.commitChecksTitle")}</h4>
        <Checkbox
          checked={v.checkTodo}
          onChange={(value) => update({ checkTodo: value })}
          label={t("git.checkTodo")}
        />
      </section>
    </VcsForm>
  );
}

/**
 * Git：探测可执行文件、提交警告、推送、更新方式。
 */
export function VcsGitPage({ workspace }: { workspace?: string | null }) {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;
  const [testStatus, setTestStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const update = (diff: Partial<VcsSettings>) => patch({ vcs: { ...v, ...diff } });

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
    <VcsForm>
      <div className="vcs-group">
        <div className="vcs-field">
          <span className="vcs-field-label">{t("vcs.gitPath")}</span>
          <Button size="small" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 size={13} className="is-spinning" /> : null}
            {t("vcs.testButton")}
          </Button>
        </div>
        <p className="vcs-hint">{t("vcs.gitPathHint")}</p>
        {testStatus ? (
          <p className={`vcs-status${testStatus.ok ? " is-ok" : " is-bad"}`}>
            {testStatus.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            <span>{testStatus.msg}</span>
          </p>
        ) : null}
      </div>

      <section className="vcs-group">
        <h4 className="vcs-group-title">{t("vcs.commitWarnings")}</h4>
        <div className="vcs-options">
          <Checkbox checked={v.warnCrlf} onChange={(value) => update({ warnCrlf: value })} label={t("vcs.warnCrlf")} />
          <Checkbox
            checked={v.warnDetachedHead}
            onChange={(value) => update({ warnDetachedHead: value })}
            label={t("vcs.warnDetachedHead")}
          />
          <Checkbox
            checked={v.signOffCommit}
            onChange={(value) => update({ signOffCommit: value })}
            label={t("git.signOff")}
          />
          <NumberLimit
            checked={v.warnLargeFiles}
            label={t("vcs.warnLargeFiles")}
            value={v.largeFilesLimitMb}
            unit="MB"
            onChecked={(value) => update({ warnLargeFiles: value })}
            onValue={(largeFilesLimitMb) => update({ largeFilesLimitMb })}
          />
          <Checkbox
            checked={v.warnBadFileNames}
            onChange={(value) => update({ warnBadFileNames: value })}
            label={t("vcs.warnBadFileNames")}
          />
        </div>
      </section>

      <section className="vcs-group">
        <h4 className="vcs-group-title">{t("vcs.pushSettings")}</h4>
        <div className="vcs-options">
          <div className="vcs-field">
            <span className="vcs-field-label">{t("vcs.showPushDialog")}</span>
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
                if (value === "always" || value === "protected" || value === "never") {
                  update({ showPushDialog: value });
                }
              }}
            />
          </div>
          <div className="vcs-stack">
            <span className="vcs-field-label">{t("vcs.protectedBranches")}</span>
            <input
              type="text"
              className="text-input vcs-text"
              value={v.protectedBranches}
              placeholder={t("vcs.protectedPlaceholder")}
              onChange={(event) => update({ protectedBranches: event.target.value })}
            />
            <p className="vcs-hint">{t("vcs.protectedHint")}</p>
          </div>
        </div>
      </section>

      <section className="vcs-group">
        <h4 className="vcs-group-title">{t("vcs.updateTitle")}</h4>
        <div className="vcs-options">
          <Checkbox
            checked={v.autoUpdateOnPushRejected}
            onChange={(value) => update({ autoUpdateOnPushRejected: value })}
            label={t("git.autoUpdateOnPushRejected")}
          />
          <div className="vcs-field">
            <span className="vcs-field-label">{t("git.updateMethod")}</span>
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
          <p className="vcs-hint">{t("vcs.updateHint")}</p>
        </div>
      </section>
    </VcsForm>
  );
}

/**
 * 确认对话框，以及变更树、补丁和历史上限。
 */
export function VcsConfirmationPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;
  const update = (diff: Partial<VcsSettings>) => patch({ vcs: { ...v, ...diff } });

  return (
    <VcsForm>
      <section className="vcs-group">
        <Checkbox
          checked={v.showUpdateOptions}
          onChange={(value) => update({ showUpdateOptions: value })}
          label={t("vcs.showUpdateOptions")}
        />
      </section>

      <section className="vcs-group">
        <h4 className="vcs-group-title">{t("vcs.changesTitle")}</h4>
        <div className="vcs-options">
          <Checkbox
            checked={v.highlightDirtyDirectories}
            onChange={(value) => update({ highlightDirtyDirectories: value })}
            label={t("vcs.highlightDirtyDirs")}
          />
          <div className="vcs-field">
            <span className="vcs-field-label">{t("vcs.onPatchCreated")}</span>
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
                if (value === "clipboard" || value === "open" || value === "file") {
                  update({ onPatchCreated: value });
                }
              }}
            />
          </div>
          <div className="vcs-inline">
            <span className="vcs-field-label">{t("vcs.limitHistoryTo")}</span>
            <input
              type="number"
              className="text-input vcs-number"
              value={v.limitHistoryRows}
              onChange={(event) => update({ limitHistoryRows: parseInt(event.target.value, 10) || 1000 })}
            />
            <span className="vcs-unit">{t("vcs.rows")}</span>
          </div>
        </div>
      </section>
    </VcsForm>
  );
}
