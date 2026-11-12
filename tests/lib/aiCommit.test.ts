import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { GitChange, GitCommitSelection } from "../../src/lib/git";
import {
  AI_COMMIT_CONFIG_CHANGED_EVENT,
  DEFAULT_AI_COMMIT_CONFIG,
  collectFilesDiff,
  formatAiCommitError,
  getCommitFormatPreview,
  isSensitiveCommitFile,
  listAiCommitModels,
  loadAiCommitConfig,
  saveAiCommitConfig,
} from "../../src/lib/aiCommit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const change = (path: string, indexStatus: string, workStatus: string): GitChange => ({
  path, indexStatus, workStatus, oldPath: null, untracked: false, conflicted: false,
});
const select = (path: string, source: GitCommitSelection["source"]): GitCommitSelection => ({ path, oldPath: null, source });

describe("AI 提交差异输入", () => {
  it("按每个文件的提交范围读取索引或 HEAD 到工作区的完整差异", async () => {
    const staged = "@@ -1 +1 @@\n-before\n+staged";
    const worktree = "@@ -1 +1 @@\n-before\n+first\n@@ -1000 +1000 @@\n-last\n+second";
    vi.mocked(invoke).mockImplementation(async (_command, args) =>
      (args as { cached: boolean }).cached ? staged : worktree);
    const files = await collectFilesDiff("D:/repo", [change("a.ts", "M", "M"), change("b.ts", "M", "M")], [select("a.ts", "index"), select("b.ts", "worktree")]);
    expect(files).toEqual([
      { path: "a.ts", changeKind: "M", diff: staged },
      { path: "b.ts", changeKind: "M", diff: worktree },
    ]);
    expect(invoke).toHaveBeenCalledWith("git_diff_text", {
      root: "D:/repo", left: "", right: "", path: "D:/repo/a.ts", oldPath: "", cached: true, worktreeOnly: false,
    });
    expect(invoke).toHaveBeenCalledWith("git_diff_text", {
      root: "D:/repo", left: "HEAD", right: "", path: "D:/repo/b.ts", oldPath: "", cached: false, worktreeOnly: false,
    });
  });

  it("新增及未跟踪文件从磁盘读取，已删除的新增文件不伪造变更", async () => {
    vi.mocked(invoke).mockResolvedValue({ contents: "first\nsecond" });
    const fresh = { ...change("new.ts", "", "?"), untracked: true };
    const files = await collectFilesDiff("D:/repo", [fresh, change("added.ts", "A", "M"), change("gone.ts", "A", "D")], ["new.ts", "added.ts", "gone.ts"].map((path) => select(path, "worktree")));
    expect(files.map((file) => file.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))))
      .toEqual([["+first", "+second"], ["+first", "+second"]]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("空的新增文件也包含在输入中", async () => {
    vi.mocked(invoke).mockResolvedValue({ contents: "" });
    const files = await collectFilesDiff("D:/repo", [change("empty.ts", "A", "")], [select("empty.ts", "worktree")]);
    expect(files).toEqual([{ path: "empty.ts", changeKind: "A", diff: '--- /dev/null\n+++ "b/empty.ts"\n' }]);
  });

  it("重命名带上旧路径，敏感来源不发送，读取失败中止生成", async () => {
    vi.mocked(invoke).mockResolvedValue("rename from old.ts\nrename to new.ts");
    await collectFilesDiff("D:/repo", [{ ...change("new.ts", "R", ""), oldPath: "old.ts" }], [select("new.ts", "index")]);
    expect(invoke).toHaveBeenCalledWith("git_diff_text", expect.objectContaining({ oldPath: "old.ts", cached: true }));
    expect(await collectFilesDiff("D:/repo", [{ ...change("safe.txt", "R", ""), oldPath: ".env" }], [select("safe.txt", "index")])).toEqual([]);
    vi.mocked(invoke).mockRejectedValue(new Error("read failed"));
    await expect(collectFilesDiff("D:/repo", [change("a.ts", "M", "")], [select("a.ts", "index")])).rejects.toThrow("read failed");
  });

  it("只选未暂存修改时使用提交预览，不读取完整工作区", async () => {
    vi.mocked(invoke).mockResolvedValue("@@ -20 +20 @@\n-old\n+working only");
    const files = await collectFilesDiff("D:/repo", [change("a.ts", "M", "M")], [select("a.ts", "worktreeOnly")]);
    expect(files[0].diff).toContain("+working only");
    expect(invoke).toHaveBeenCalledWith("git_diff_text", expect.objectContaining({ worktreeOnly: true, cached: false }));
  });
});

describe("aiCommit", () => {
  it("default config leaves the provider unset and keeps generation preferences", () => {
    expect(DEFAULT_AI_COMMIT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AI_COMMIT_CONFIG.language).toBe("simplifiedChinese");
    expect(DEFAULT_AI_COMMIT_CONFIG.format).toBe("conventional");
    expect(DEFAULT_AI_COMMIT_CONFIG.providerId).toBeNull();
    expect(DEFAULT_AI_COMMIT_CONFIG.model).toBeNull();
    expect(DEFAULT_AI_COMMIT_CONFIG.codexProtocol).toBe("responses");
    expect(DEFAULT_AI_COMMIT_CONFIG.includeBody).toBe(true);
    expect(DEFAULT_AI_COMMIT_CONFIG.subjectMaximumLength).toBe(0);
    expect(DEFAULT_AI_COMMIT_CONFIG.maximumDiffCharacters).toBe(0);
    expect(DEFAULT_AI_COMMIT_CONFIG.maximumOutputTokens).toBe(0);
  });

  it("加载旧配置保留用户限制，补齐输出预算，并保存超过旧上限的新配置", async () => {
    const { maximumOutputTokens: _output, ...legacy } = DEFAULT_AI_COMMIT_CONFIG;
    vi.mocked(invoke).mockResolvedValueOnce({ ...legacy, includeBody: false, subjectMaximumLength: 500, maximumDiffCharacters: 320_000 });
    const loaded = await loadAiCommitConfig();
    expect(loaded).toEqual({ ...DEFAULT_AI_COMMIT_CONFIG, includeBody: false, subjectMaximumLength: 500, maximumDiffCharacters: 320_000 });
    const next = { ...loaded, subjectMaximumLength: 10_000, maximumDiffCharacters: 50_000_000, maximumOutputTokens: 65_536 };
    await saveAiCommitConfig(next);
    expect(invoke).toHaveBeenLastCalledWith("ai_commit_config_save", { config: next });
  });

  it("模型清单按供应商读取并原样透传，默认模型带标记", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { id: "claude-sonnet-4-5", name: "claude-sonnet-4-5", isDefault: true },
      { id: "claude-haiku-4-5", name: "claude-haiku-4-5", isDefault: false },
    ]);
    const models = await listAiCommitModels("p1");
    expect(invoke).toHaveBeenCalledWith("ai_commit_list_models", { providerId: "p1" });
    expect(models.map((model) => [model.id, model.isDefault])).toEqual([
      ["claude-sonnet-4-5", true],
      ["claude-haiku-4-5", false],
    ]);
  });

  it("getCommitFormatPreview returns sample text and badges for formats", () => {
    const conventionalZh = getCommitFormatPreview("conventional", "simplifiedChinese", false);
    expect(conventionalZh.badge).toBe("Conventional Commits");
    expect(conventionalZh.sample).toContain("feat(");

    const conventionalZhWithBody = getCommitFormatPreview("conventional", "simplifiedChinese", true);
    expect(conventionalZhWithBody.sample).toContain("\n\n");

    const conciseEn = getCommitFormatPreview("concise", "english", false);
    expect(conciseEn.sample.length).toBeGreaterThan(0);

    const customWithInstructions = getCommitFormatPreview(
      "custom",
      "simplifiedChinese",
      false,
      "Commit prefix [MOD]"
    );
    expect(customWithInstructions.sample).toContain("Commit prefix [MOD]");
  });

  it("isSensitiveCommitFile detects credentials, private keys and environment files", () => {
    expect(isSensitiveCommitFile(".env")).toBe(true);
    expect(isSensitiveCommitFile(".env.local")).toBe(true);
    expect(isSensitiveCommitFile("config/.env.test")).toBe(true);
    expect(isSensitiveCommitFile("auth.json")).toBe(true);
    expect(isSensitiveCommitFile("credentials.json")).toBe(true);
    expect(isSensitiveCommitFile("id_rsa")).toBe(true);
    expect(isSensitiveCommitFile("id_ed25519")).toBe(true);
    expect(isSensitiveCommitFile("server.key")).toBe(true);
    expect(isSensitiveCommitFile("cert.pem")).toBe(true);
    expect(isSensitiveCommitFile("cert.p12")).toBe(true);

    expect(isSensitiveCommitFile("src/main.rs")).toBe(false);
    expect(isSensitiveCommitFile("package.json")).toBe(false);
    expect(isSensitiveCommitFile("README.md")).toBe(false);
  });

  it("formatAiCommitError formats known error codes and http status codes", () => {
    const mockT = (key: string, values?: Record<string, string | number>) => {
      if (key === "aiCommit.httpError") return `HTTP ${values?.status}`;
      if (key === "aiCommit.AI_COMMIT_TIMEOUT") return "Timeout Error";
      if (key === "aiCommit.failed") return "Default Failed";
      return key;
    };

    expect(formatAiCommitError("AI_COMMIT_HTTP_401", mockT)).toBe("HTTP 401");
    expect(formatAiCommitError("AI_COMMIT_TIMEOUT", mockT)).toBe("Timeout Error");
    expect(formatAiCommitError("UNKNOWN_CODE", mockT)).toBe("Default Failed");
  });

  it("exports AI_COMMIT_CONFIG_CHANGED_EVENT event name", () => {
    expect(AI_COMMIT_CONFIG_CHANGED_EVENT).toBe("forge:ai-commit-config-changed");
  });
});
