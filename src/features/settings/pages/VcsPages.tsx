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
            label={t("vcs.nonModalCommit") ?? "使用非模态提交接口 (Use non-modal commit interface)"}
          />
          <p className="settings-hint" style={{ margin: "-4px 0 0 24px" }}>
            {t("vcs.nonModalHint") ??
              "关闭后，提交操作将以弹出独立模态对话框的形式呈现；开启后使用侧边栏提交工具窗口。"}
          </p>

          <Checkbox
            checked={v.clearInitialCommitMessage}
            onChange={(val) => update({ clearInitialCommitMessage: val })}
            label={t("vcs.clearInitialMessage") ?? "提交成功后清空初始提交消息 (Clear initial commit message)"}
          />
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "8px 0" }} />

        {/* 提交信息规范 Commit Message Inspections */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.messageInspections") ?? "提交消息检查规范 (Commit Message Inspections)"}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Checkbox
            checked={v.blankLineAfterSubject}
            onChange={(val) => update({ blankLineAfterSubject: val })}
            label={t("vcs.blankLineAfterSubject") ?? "首行（主题行）与正文之间保留空行"}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={v.limitSubjectLine}
              onChange={(val) => update({ limitSubjectLine: val })}
              label={t("vcs.limitSubjectLine") ?? "限制主题行长度:"}
            />
            <input
              type="number"
              className="text-input"
              value={v.subjectLineLimit}
              disabled={!v.limitSubjectLine}
              onChange={(e) => update({ subjectLineLimit: parseInt(e.target.value) || 72 })}
              style={{ width: 70, height: 24, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>{t("vcs.characters") ?? "字符"}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={v.limitBodyLine}
              onChange={(val) => update({ limitBodyLine: val })}
              label={t("vcs.limitBodyLine") ?? "限制正文行长度:"}
            />
            <input
              type="number"
              className="text-input"
              value={v.bodyLineLimit}
              disabled={!v.limitBodyLine}
              onChange={(e) => update({ bodyLineLimit: parseInt(e.target.value) || 72 })}
              style={{ width: 70, height: 24, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>{t("vcs.characters") ?? "字符"}</span>
          </div>

          <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={v.showRightMargin}
              disabled={!v.limitSubjectLine && !v.limitBodyLine}
              onChange={(val) => update({ showRightMargin: val })}
              label={t("vcs.showRightMargin") ?? "在提交文本框中显示右边界参考线 (Show right margin)"}
            />
            <Checkbox
              checked={v.wrapRightMargin}
              disabled={!v.limitBodyLine}
              onChange={(val) => update({ wrapRightMargin: val })}
              label={t("vcs.wrapRightMargin") ?? "输入达到右边界时自动换行 (Wrap when typing reaches right margin)"}
            />
          </div>
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "8px 0" }} />

        {/* 提交前检查 Commit Checks */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.commitChecksTitle") ?? "提交前检查 (Before Commit Checks)"}
        </h4>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={v.checkAnalyzeCode}
              onChange={(val) => update({ checkAnalyzeCode: val })}
              label={t("git.analyzeCode") ?? "分析代码 (Analyze code)"}
            />
            <Checkbox
              checked={v.checkTodo}
              onChange={(val) => update({ checkTodo: val })}
              label={t("git.checkTodo") ?? "检查 TODO (Check TODO)"}
            />
            <Checkbox
              checked={v.checkCleanup}
              onChange={(val) => update({ checkCleanup: val })}
              label={t("git.cleanup") ?? "深度清理代码 (Cleanup)"}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={v.checkReformatCode}
              onChange={(val) => update({ checkReformatCode: val })}
              label={t("git.reformatCode") ?? "重新格式化代码 (Reformat code)"}
            />
            <Checkbox
              checked={v.checkOptimizeImports}
              onChange={(val) => update({ checkOptimizeImports: val })}
              label={t("git.optimizeImports") ?? "优化导入依赖 (Optimize imports)"}
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
            {t("vcs.gitPath") ?? "Git 可执行文件路径 (Path to Git executable):"}
          </span>
          <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 600 }}>
            <Button size="small" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 size={13} className="is-spinning" style={{ marginRight: 4 }} /> : null}
              <span>{t("vcs.testButton") ?? "测试 (Test)"}</span>
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
          {t("vcs.commitWarnings") ?? "提交警告与签名 (Commit Warnings & Sign-off)"}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.warnCrlf}
            onChange={(val) => update({ warnCrlf: val })}
            label={t("vcs.warnCrlf") ?? "提交包含 CRLF 换行符的文件前发出警告"}
          />
          <Checkbox
            checked={v.warnDetachedHead}
            onChange={(val) => update({ warnDetachedHead: val })}
            label={t("vcs.warnDetachedHead") ?? "在游离 HEAD (Detached HEAD) 或变基中提交时发出警告"}
          />
          <Checkbox
            checked={v.signOffCommit}
            onChange={(val) => update({ signOffCommit: val })}
            label={t("git.signOff") ?? "默认签名提交 (添加 Signed-off-by trailer)"}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={v.warnLargeFiles}
              onChange={(val) => update({ warnLargeFiles: val })}
              label={t("vcs.warnLargeFiles") ?? "提交大于以下大小的文件时发出警告:"}
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
            label={t("vcs.warnBadFileNames") ?? "提交在其他操作系统上可能导致问题的特殊文件名时发出警告"}
          />
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "6px 0" }} />

        {/* Push 推送控制 */}
        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.pushSettings") ?? "推送与受保护分支 (Push & Protected Branches)"}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="settings-row">
            <span className="settings-label">{t("vcs.showPushDialog") ?? "显示 Push 推送确认对话框:"}</span>
            <Select
              label={t("vcs.showPushDialog") ?? "显示 Push 推送确认对话框"}
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
            <span className="settings-label">{t("vcs.protectedBranches") ?? "受保护分支模式 (Protected branches):"}</span>
            <input
              type="text"
              className="text-input"
              value={v.protectedBranches}
              placeholder="master;main;release/*"
              onChange={(e) => update({ protectedBranches: e.target.value })}
              style={{ width: "100%", maxWidth: 500 }}
            />
            <span className="settings-hint">
              {t("vcs.protectedHint") ??
                "禁止向受保护分支执行强制推送 (force push)。支持用分号 ; 分隔多个模式，支持 * 和 ? 通配符。"}
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
          {t("vcs.confirmationsTitle") ?? "文件操作确认策略 (File Operations Confirmation)"}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.showUpdateOptions}
            onChange={(val) => update({ showUpdateOptions: val })}
            label={t("vcs.showUpdateOptions") ?? "执行项目更新前显示选项确认对话框"}
          />
        </div>

        <div style={{ height: 1, background: "var(--border-subtle, rgba(255, 255, 255, 0.08))", margin: "6px 0" }} />

        <h4 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 600, color: "var(--fg-strong, #dfe1e5)" }}>
          {t("vcs.changesTitle") ?? "变更展示与历史上限 (Changes & History Limit)"}
        </h4>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Checkbox
            checked={v.highlightDirtyDirectories}
            onChange={(val) => update({ highlightDirtyDirectories: val })}
            label={t("vcs.highlightDirtyDirs") ?? "在项目目录树中高亮显示包含已修改文件的父目录"}
          />

          <div className="settings-row">
            <span className="settings-label">{t("vcs.onPatchCreated") ?? "创建补丁后的行为:"}</span>
            <Select
              label={t("vcs.onPatchCreated") ?? "创建补丁后的行为"}
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
              {t("vcs.limitHistoryTo") ?? "文件历史记录行数限制 (Limit history rows):"}
            </span>
            <input
              type="number"
              className="text-input"
              value={v.limitHistoryRows}
              onChange={(e) => update({ limitHistoryRows: parseInt(e.target.value) || 1000 })}
              style={{ width: 80, height: 26, padding: "2px 6px" }}
            />
            <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)" }}>{t("vcs.rows") ?? "行 (rows)"}</span>
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
          {t("vcs.issueHint") ??
            "在 Git 提交信息与日志中匹配工单 ID 正则表达式，自动渲染为超链接。$0 代表完整匹配，$1… 代表括号内的正则捕获组。"}
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
                <th style={{ padding: "6px 12px", width: "40%" }}>{t("vcs.issueRegex") ?? "工单 ID 正则 (Issue ID)"}</th>
                <th style={{ padding: "6px 12px" }}>{t("vcs.issueUrlTemplate") ?? "链接模板 (Issue Link)"}</th>
                <th style={{ padding: "6px 12px", width: 50 }}>{t("vcs.action") ?? "操作"}</th>
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
                    {t("vcs.noPatterns") ?? "暂无配置任何工单导航规则"}
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
                        title={t("dialog.delete") ?? "删除"}
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
            <span>{t("vcs.add") ?? "添加"}</span>
          </Button>
        </div>

        {/* 预设规则一键添加 */}
        <div style={{ marginTop: 16 }}>
          <span style={{ fontSize: 12, color: "var(--fg-secondary, #9fa2a8)", marginRight: 8 }}>
            {t("vcs.quickPresets") ?? "常用快速预设:"}
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
