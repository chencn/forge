import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

describe("模型供应商 / Skills / MCP 辅助函数", () => {
  it("新建供应商带合法 id 与指定类型", async () => {
    const { emptyModelProvider } = await import("../../src/lib/aiManage");
    const provider = emptyModelProvider("codex");
    expect(provider.kind).toBe("codex");
    expect(provider.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(provider.models).toEqual({});
  });

  it("技能模板包含 front matter 与名称", async () => {
    const { skillTemplate } = await import("../../src/lib/aiManage");
    const text = skillTemplate("my-skill");
    expect(text.startsWith("---\nname: my-skill")).toBe(true);
    expect(text).toContain("# my-skill");
  });

  it("MCP 摘要优先展示 URL，其次命令与参数", async () => {
    const { mcpSummary } = await import("../../src/lib/aiManage");
    expect(mcpSummary({ type: "http", url: "https://example.com/mcp" })).toBe("https://example.com/mcp");
    expect(mcpSummary({ type: "stdio", command: "npx", args: ["-y", "server"] })).toBe("npx -y server");
  });

  it("MCP JSON 解析区分空、非对象与语法错误", async () => {
    const { parseMcpSpec } = await import("../../src/lib/aiManage");
    expect("spec" in parseMcpSpec('{"command":"x"}')).toBe(true);
    expect(parseMcpSpec("")).toEqual({ error: "empty" });
    expect(parseMcpSpec("[]")).toEqual({ error: "object" });
    expect("error" in parseMcpSpec("{oops")).toBe(true);
  });

  it("远程 MCP 带 env 时给出忽略提示，stdio 不提示", async () => {
    const { hasRemoteMcpEnv } = await import("../../src/lib/aiManage");
    expect(hasRemoteMcpEnv({ url: "https://example.com", env: { TOKEN: "x" } })).toBe(true);
    expect(hasRemoteMcpEnv({ url: "https://example.com", env: {} })).toBe(false);
    expect(hasRemoteMcpEnv({ command: "npx", env: { TOKEN: "x" } })).toBe(false);
  });

  it("技能 front matter 检测忽略前导空白与 BOM", async () => {
    const { skillHasFrontMatter } = await import("../../src/lib/aiManage");
    expect(skillHasFrontMatter("\n  ---\nname: x\n---\n")).toBe(true);
    expect(skillHasFrontMatter("\uFEFF---\nname: x\n---\n")).toBe(true);
    expect(skillHasFrontMatter("# heading")).toBe(false);
  });

  it("清单意图归一化后比较，忽略写法差异", async () => {
    const { catalogIntentEquals, emptyCodexCatalogIntent } = await import("../../src/lib/aiManage");
    const empty = emptyCodexCatalogIntent();
    const touched = { excluded: ["gpt-6-astra"], overrides: {}, customs: [] };
    expect(catalogIntentEquals(empty, touched as never)).toBe(false);
    // 空覆盖项算“有改动”而不是“等于没有”：后端会直接拒掉空覆盖，界面必须在清空时把这条删掉。
    const blankOverride = { excluded: [], overrides: { "gpt-5.5": { toolMode: null, flags: {} } }, customs: [] };
    expect(catalogIntentEquals(empty, blankOverride as never)).toBe(false);
    // 开关顺序与未填字段都不该被当成改动。
    const left = { excluded: [], overrides: { x: { toolMode: "direct", flags: { a: true, b: false } } }, customs: [] };
    const right = { excluded: [], overrides: { x: { flags: { b: false, a: true }, toolMode: "direct" } }, customs: [] };
    expect(catalogIntentEquals(left as never, right as never)).toBe(true);
  });

  it("自定义模型必须带模板与 slug", async () => {
    const { normalizeCodexCatalogIntent, emptyCodexCatalogIntent } = await import("../../src/lib/aiManage");
    const intent = { ...emptyCodexCatalogIntent(), customs: [{ slug: "gw/opus", displayName: " Opus ", description: "", base: "gpt-5.5", overrides: { flags: {} } }] };
    const text = normalizeCodexCatalogIntent(intent as never);
    expect(JSON.parse(text).customs[0]).toEqual({ slug: "gw/opus", displayName: "Opus", description: "", base: "gpt-5.5", overrides: {} });
  });

  it("推理档位选项取自模型自己的 supported_reasoning_levels", async () => {
    const { codexModelEfforts } = await import("../../src/lib/aiManage");
    expect(codexModelEfforts({ supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { nope: 1 }] })).toEqual(["low", "high"]);
    expect(codexModelEfforts({})).toEqual([]);
  });

  it("市场安装参数的默认值转成草稿文本", async () => {
    const { defaultMarketParams } = await import("../../src/lib/aiManage");
    const option = {
      id: "official:package:0:stdio", protocol: "stdio", label: "", description: null, spec: {},
      parameters: [
        { key: "TOKEN", label: "TOKEN", description: null, required: true, secret: true, kind: "string", defaultValue: "abc", placeholder: null, enumValues: [], location: "env" },
        { key: "COUNT", label: "COUNT", description: null, required: false, secret: false, kind: "integer", defaultValue: 3, placeholder: null, enumValues: [], location: "env" },
        { key: "FLAG", label: "FLAG", description: null, required: false, secret: false, kind: "boolean", defaultValue: true, placeholder: null, enumValues: [], location: "env" },
        { key: "EXTRA", label: "EXTRA", description: null, required: false, secret: false, kind: "json", defaultValue: { a: 1 }, placeholder: null, enumValues: [], location: "env" },
        { key: "EMPTY", label: "EMPTY", description: null, required: false, secret: false, kind: "string", defaultValue: null, placeholder: null, enumValues: [], location: "env" },
      ],
    };
    expect(defaultMarketParams(option as never)).toEqual({ TOKEN: "abc", COUNT: "3", FLAG: "true", EXTRA: '{"a":1}' });
    expect(defaultMarketParams(null)).toEqual({});
  });
});
