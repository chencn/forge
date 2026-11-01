import { describe, expect, it } from "vitest";
import {
  mergeProjectLspConfig,
  serverCandidates,
  serverForLanguage,
  type LspConfig,
  type LspServerConfig,
} from "../../src/lib/lspConfig";

function server(mode: "off" | "builtin" | "lsp", language: string): LspServerConfig {
  return {
    mode,
    program: `${language}-server`,
    path: "",
    args: "--stdio",
    languages: [language],
    rootMarkers: ["package.json"],
    installCommand: "",
    uninstallCommand: "",
    startupTimeoutMs: 30_000,
    initOptions: null,
    supportsBuiltin: false,
    homepage: "",
    installHint: "",
  };
}

describe("LSP server 候选", () => {
  it("按配置顺序返回启用候选，并排除 off", () => {
    const config: LspConfig = {
      version: 1,
      maxSessions: 5,
      idleTimeoutMin: 30,
      servers: {
        primary: server("lsp", "typescript"),
        disabled: server("off", "typescript"),
        fallback: server("lsp", "typescript"),
      },
    };

    expect(serverCandidates(config, "typescript").map((entry) => entry.id)).toEqual([
      "primary",
      "fallback",
    ]);
    expect(serverForLanguage(config, "typescript")?.id).toBe("primary");
    expect(serverCandidates(config, "python")).toEqual([]);
  });

  it("没有启用候选时不返回被禁用的第一项", () => {
    const config: LspConfig = {
      version: 1,
      servers: { only: server("off", "typescript") },
    };
    expect(serverForLanguage(config, "typescript")).toBeNull();
  });

  it("项目覆盖只改变运行时候选顺序和已有 server 字段", () => {
    const config: LspConfig = {
      version: 1,
      servers: {
        primary: server("lsp", "typescript"),
        fallback: server("lsp", "typescript"),
        python: server("lsp", "python"),
      },
    };
    const merged = mergeProjectLspConfig(config, {
      candidates: { typescript: ["python", "fallback", "unknown"] },
      servers: { fallback: { args: "--stdio --project" }, unknown: { mode: "lsp" } },
    });
    expect(serverCandidates(merged, "typescript").map((entry) => entry.id)).toEqual([
      "fallback",
      "primary",
    ]);
    expect(merged.servers.fallback.args).toBe("--stdio --project");
    expect(merged.servers.unknown).toBeUndefined();
    expect(config.servers.fallback.args).toBe("--stdio");
    expect(merged.maxSessions).toBeUndefined();
  });

  it("不让项目配置把非法 server patch 带入运行时", () => {
    const config: LspConfig = {
      version: 1,
      servers: { primary: server("lsp", "typescript") },
    };
    const merged = mergeProjectLspConfig(config, {
      servers: { primary: { mode: "invalid" as never, languages: [42 as never] } },
    });
    expect(merged.servers.primary.mode).toBe("lsp");
    expect(merged.servers.primary.languages).toEqual(["typescript"]);
  });
});
