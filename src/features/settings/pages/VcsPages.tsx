import { useState } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { useI18n } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { Checkbox } from "../../../ui/Checkbox";
import Select from "../../../components/Select";
import { gitProbe } from "../../../lib/git";
import type { IssueNavigationPattern } from "../../../lib/settings";
import { Plus, Trash2, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

/**
 * 2. 提交设置页 (Commit)
 * 提交前检查、提交消息长度规范与 72 列参考线
 */
export function VcsCommitPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;

  const update = (diff: Partial<typeof v>) => {
    patch({ vcs: { ...v, ...diff } });
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        {/* 提交通用行为 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.nonModalCommit}
            onChange={(val) => update({ nonModalCommit: val })}
            label={t("vcs.nonModalCommit")}
          />
          <p className="settings-hint" style={{ margin: "-4px 0 0 24px" }}>
            {t("vcs.nonModalHint")}
          </p>

          <Checkbox
            checked={v.clearInitialCommitMessage}
            onChange={(val) => update({ clearInitialCommitMessage: val })}
            label={t("vcs.clearInitialMessage")}
          />
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "8px 0" }} />

        {/* 提交信息规范 Commit Message Inspections */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.messageInspections")}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Checkbox
            checked={v.blankLineAfterSubject}
            onChange={(val) => update({ blankLineAfterSubject: val })}
            label={t("vcs.blankLineAfterSubject")}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={v.limitSubjectLine}
              onChange={(val) => update({ limitSubjectLine: val })}
              label={t("vcs.limitSubjectLine")}
            />
            <input
              type="number"
              className="text-input"
              value={v.subjectLineLimit}
              disabled={!v.limitSubjectLine}
              onChange={(e) => update({ subjectLineLimit: parseInt(e.target.value) || 72 })}
              style={{ width: 70, height: 24, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>{t("vcs.characters")}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={v.limitBodyLine}
              onChange={(val) => update({ limitBodyLine: val })}
              label={t("vcs.limitBodyLine")}
            />
            <input
              type="number"
              className="text-input"
              value={v.bodyLineLimit}
              disabled={!v.limitBodyLine}
              onChange={(e) => update({ bodyLineLimit: parseInt(e.target.value) || 72 })}
              style={{ width: 70, height: 24, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>{t("vcs.characters")}</span>
          </div>

          <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={v.showRightMargin}
              disabled={!v.limitSubjectLine && !v.limitBodyLine}
              onChange={(val) => update({ showRightMargin: val })}
              label={t("vcs.showRightMargin")}
            />
            <Checkbox
              checked={v.wrapRightMargin}
              disabled={!v.limitBodyLine}
              onChange={(val) => update({ wrapRightMargin: val })}
              label={t("vcs.wrapRightMargin")}
            />
          </div>
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "8px 0" }} />

        {/* 提交前检查 Commit Checks */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.commitChecksTitle")}
        </h4>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={v.checkAnalyzeCode}
              onChange={(val) => update({ checkAnalyzeCode: val })}
              label={t("git.analyzeCode")}
            />
            <Checkbox
              checked={v.checkTodo}
              onChange={(val) => update({ checkTodo: val })}
              label={t("git.checkTodo")}
            />
            <Checkbox
              checked={v.checkCleanup}
              onChange={(val) => update({ checkCleanup: val })}
              label={t("git.cleanup")}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={v.checkReformatCode}
              onChange={(val) => update({ checkReformatCode: val })}
              label={t("git.reformatCode")}
            />
            <Checkbox
              checked={v.checkOptimizeImports}
              onChange={(val) => update({ checkOptimizeImports: val })}
              label={t("git.optimizeImports")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 3. Git 设置页 (Git)
 * Git 可执行文件路径与测试、警告拦截、Push 对话框与受保护分支、更新方式
 */
export function VcsGitPage({ workspace }: { workspace?: string | null }) {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;

  const [testStatus, setTestStatus] = useState<{
    tested: boolean;
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const update = (diff: Partial<typeof v>) => {
    patch({ vcs: { ...v, ...diff } });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      // 通过 gitProbe 探测系统 git 状态
      const probe = await gitProbe(workspace || ".");
      if (probe.available) {
        setTestStatus({
          tested: true,
          ok: true,
          msg: `Git 测试成功！系统 Git 可正常调用 (仓库根: ${probe.repoRoot ?? "无"})`,
        });
      } else {
        setTestStatus({
          tested: true,
          ok: false,
          msg: "未检测到可用的 Git 可执行文件，请检查系统 PATH 环境变量或指定绝对路径。",
        });
      }
    } catch (err) {
      setTestStatus({
        tested: true,
        ok: false,
        msg: `Git 检测失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        {/* Git 可用性探测：路径输入框已删（后端固定用系统 PATH 里的 git），按钮只做探测。 */}
        <div className="settings-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
          <span className="settings-label" style={{ fontWeight: 600 }}>
            {t("vcs.gitPath")}
          </span>
          <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 600 }}>
            <Button size="small" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 size={13} className="is-spinning" style={{ marginRight: 4 }} /> : null}
              <span>{t("vcs.testButton")}</span>
            </Button>
          </div>

          {testStatus && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                marginTop: 4,
                color: testStatus.ok ? "var(--success, #57965c)" : "var(--danger, #f57e84)",
              }}
            >
              {testStatus.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
              <span>{testStatus.msg}</span>
            </div>
          )}
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "6px 0" }} />

        {/* Commit 提交警告 */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.commitWarnings")}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.warnCrlf}
            onChange={(val) => update({ warnCrlf: val })}
            label={t("vcs.warnCrlf")}
          />
          <Checkbox
            checked={v.warnDetachedHead}
            onChange={(val) => update({ warnDetachedHead: val })}
            label={t("vcs.warnDetachedHead")}
          />
          <Checkbox
            checked={v.signOffCommit}
            onChange={(val) => update({ signOffCommit: val })}
            label={t("git.signOff")}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={v.warnLargeFiles}
              onChange={(val) => update({ warnLargeFiles: val })}
              label={t("vcs.warnLargeFiles")}
            />
            <input
              type="number"
              className="text-input"
              value={v.largeFilesLimitMb}
              disabled={!v.warnLargeFiles}
              onChange={(e) => update({ largeFilesLimitMb: parseInt(e.target.value) || 50 })}
              style={{ width: 70, height: 24, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>MB</span>
          </div>

          <Checkbox
            checked={v.warnBadFileNames}
            onChange={(val) => update({ warnBadFileNames: val })}
            label={t("vcs.warnBadFileNames")}
          />
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "6px 0" }} />

        {/* Push 推送控制 */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.pushSettings")}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="settings-row">
            <span className="settings-label">{t("vcs.showPushDialog")}</span>
            <Select
              label={t("vcs.showPushDialog")}
              placeholder="—"
              value={v.showPushDialog}
              options={[
                { value: "always", label: "总是显示 (Always)" },
                { value: "protected", label: "仅限向受保护分支提交时 (Only protected branches)" },
                { value: "never", label: "从不显示 (Never)" },
              ]}
              onChange={(val) => update({ showPushDialog: val as any })}
            />
          </div>

          <div className="settings-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
            <span className="settings-label">{t("vcs.protectedBranches")}</span>
            <input
              type="text"
              className="text-input"
              value={v.protectedBranches}
              placeholder="master;main;release/*"
              onChange={(e) => update({ protectedBranches: e.target.value })}
              style={{ width: "100%", maxWidth: 500 }}
            />
            <span className="settings-hint">
              {t("vcs.protectedHint")}
            </span>
          </div>
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "6px 0" }} />

        <p className="settings-hint" style={{ margin: "0 0 6px 0" }}>
          项目更新（拉取远端并整合本地提交）走工具栏的更新动作；forge 的 Git 固定取系统
          PATH 中的可执行文件，无需配置路径。
        </p>
      </div>
    </div>
  );
}

/**
 * 4. 确认与变更设置页 (Confirmation & Changes)
 */
export function VcsConfirmationPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;

  const update = (diff: Partial<typeof v>) => {
    patch({ vcs: { ...v, ...diff } });
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.confirmationsTitle")}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.showUpdateOptions}
            onChange={(val) => update({ showUpdateOptions: val })}
            label={t("vcs.showUpdateOptions")}
          />
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "6px 0" }} />

        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.changesTitle")}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.highlightDirtyDirectories}
            onChange={(val) => update({ highlightDirtyDirectories: val })}
            label={t("vcs.highlightDirtyDirs")}
          />

          <div className="settings-row">
            <span className="settings-label">{t("vcs.onPatchCreated")}</span>
            <Select
              label={t("vcs.onPatchCreated")}
              placeholder="—"
              value={v.onPatchCreated}
              options={[
                { value: "clipboard", label: "直接复制到剪贴板 (Copy to clipboard)" },
                { value: "open", label: "在编辑器中打开差异 (Open in editor)" },
                { value: "file", label: "在文件管理器中定位 (Show in Files)" },
              ]}
              onChange={(val) => update({ onPatchCreated: val as any })}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="settings-label" style={{ minWidth: "auto" }}>
              {t("vcs.limitHistoryTo")}
            </span>
            <input
              type="number"
              className="text-input"
              value={v.limitHistoryRows}
              onChange={(e) => update({ limitHistoryRows: parseInt(e.target.value) || 1000 })}
              style={{ width: 80, height: 26, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>{t("vcs.rows")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 6. 事务工单导航设置页 (Issue Navigation)
 * 提交说明中的工单 ID 正则映射为外部超链接（JIRA, YouTrack, GitHub 等）
 */
export function VcsIssueNavigationPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const v = settings.vcs;
  const patterns = v.issueNavigationPatterns ?? [];

  const [issueId, setIssueId] = useState("");
  const [issueLink, setIssueLink] = useState("");

  const updatePatterns = (next: IssueNavigationPattern[]) => {
    patch({ vcs: { ...v, issueNavigationPatterns: next } });
  };

  const handleAdd = () => {
    if (!issueId.trim() || !issueLink.trim()) return;
    const next: IssueNavigationPattern = {
      id: Date.now().toString(),
      issueId: issueId.trim(),
      issueLink: issueLink.trim(),
    };
    updatePatterns([...patterns, next]);
    setIssueId("");
    setIssueLink("");
  };

  const handleRemove = (id: string) => {
    updatePatterns(patterns.filter((p) => p.id !== id));
  };

  const addPreset = (presetId: string, presetLink: string) => {
    const next: IssueNavigationPattern = {
      id: Date.now().toString(),
      issueId: presetId,
      issueLink: presetLink,
    };
    updatePatterns([...patterns, next]);
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint" style={{ margin: "0 0 8px 0" }}>
          {t("vcs.issueHint")}
        </p>

        {/* 规则表格 */}
        <div
          style={{
            border: "1px solid var(--border-color, #43454a)",
            borderRadius: 6,
            overflow: "hidden",
            background: "var(--bg-secondary, #26282c)",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
              fontSize: 12,
            }}
          >
            <thead>
              <tr
                style={{
                  background: "var(--bg-hover, rgba(255, 255, 255, 0.04))",
                  borderBottom: "1px solid var(--border-color, #43454a)",
                  color: "var(--fg-secondary, #9fa2a8)",
                }}
              >
                <th style={{ padding: "6px 12px", width: "40%" }}>{t("vcs.issueRegex")}</th>
                <th style={{ padding: "6px 12px" }}>{t("vcs.issueUrlTemplate")}</th>
                <th style={{ padding: "6px 12px", width: 50 }}>{t("vcs.action")}</th>
              </tr>
            </thead>
            <tbody>
              {patterns.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    style={{
                      padding: "16px 12px",
                      textAlign: "center",
                      color: "var(--fg-muted, #6c707e)",
                    }}
                  >
                    {t("vcs.noPatterns")}
                  </td>
                </tr>
              ) : (
                patterns.map((item) => (
                  <tr
                    key={item.id}
                    style={{
                      borderBottom: "1px solid var(--border-subtle, rgba(255, 255, 255, 0.05))",
                    }}
                  >
                    <td style={{ padding: "6px 12px", fontFamily: "var(--font-mono, monospace)" }}>
                      {item.issueId}
                    </td>
                    <td style={{ padding: "6px 12px", fontFamily: "var(--font-mono, monospace)", color: "var(--accent, #3871e1)" }}>
                      {item.issueLink}
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <button
                        type="button"
                        className="icon-button is-inline"
                        title={t("dialog.delete")}
                        onClick={() => handleRemove(item.id)}
                        style={{ color: "var(--danger, #f57e84)" }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 自定义添加一行 */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input
            type="text"
            className="text-input"
            placeholder="Issue ID (如: [A-Z]+-\\d+)"
            value={issueId}
            onChange={(e) => setIssueId(e.target.value)}
            style={{ width: "35%", fontFamily: "var(--font-mono, monospace)" }}
          />
          <input
            type="text"
            className="text-input"
            placeholder="Issue Link (如: https://jira.example.com/browse/$0)"
            value={issueLink}
            onChange={(e) => setIssueLink(e.target.value)}
            style={{ flex: 1, fontFamily: "var(--font-mono, monospace)" }}
          />
          <Button size="small" onClick={handleAdd} disabled={!issueId.trim() || !issueLink.trim()}>
            <Plus size={13} style={{ marginRight: 4 }} />
            <span>{t("vcs.add")}</span>
          </Button>
        </div>

        {/* 预设规则一键添加 */}
        <div style={{ marginTop: 16 }}>
          <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)", marginRight: 8 }}>
            {t("vcs.quickPresets")}
          </span>
          <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            <Button
              size="small"
              onClick={() =>
                addPreset("([A-Z][A-Z0-9]+-\\d+)", "https://jira.example.com/browse/$0")
              }
            >
              + JIRA 预设
            </Button>
            <Button
              size="small"
              onClick={() =>
                addPreset("([A-Z][A-Z0-9]+-\\d+)", "https://youtrack.example.com/issue/$0")
              }
            >
              + YouTrack 预设
            </Button>
            <Button
              size="small"
              onClick={() =>
                addPreset("#(\\d+)", "https://github.com/owner/repo/issues/$1")
              }
            >
              + GitHub 预设
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
