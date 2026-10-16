import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_COMMIT_CONFIG,
  formatAiCommitError,
  getCommitFormatPreview,
  isSensitiveCommitFile,
  newAiCommitProvider,
} from "../../src/lib/aiCommit";

describe("aiCommit", () => {
  it("default config does not preset deepseek and defaults to empty providers", () => {
    expect(DEFAULT_AI_COMMIT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AI_COMMIT_CONFIG.language).toBe("simplifiedChinese");
    expect(DEFAULT_AI_COMMIT_CONFIG.format).toBe("conventional");
    expect(DEFAULT_AI_COMMIT_CONFIG.providers).toEqual([]);
    expect(DEFAULT_AI_COMMIT_CONFIG.activeProviderId).toBeNull();
  });

  it("newAiCommitProvider creates unique valid provider profile", () => {
    const p1 = newAiCommitProvider("Provider 1");
    const p2 = newAiCommitProvider("Provider 2");
    expect(p1.id).not.toBe(p2.id);
    expect(p1.name).toBe("Provider 1");
    expect(p1.apiProtocol).toBe("chatCompletions");
    expect(p1.allowsInsecureHttp).toBe(false);
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
});
