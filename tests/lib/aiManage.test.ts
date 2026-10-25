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

  it("下拉取值取自后端实测的取值域，兜底表只在问不到时用", async () => {
    const { codexFieldDomain } = await import("../../src/lib/aiManage");
    const view = { domains: { shell_type: { values: ["default", "local", "unified_exec", "disabled", "shell_command"], nullable: false, verified: true } } } as never;
    expect(codexFieldDomain(view, "shellType")).toEqual({
      values: ["default", "local", "unified_exec", "disabled", "shell_command"], nullable: false, verified: true,
    });
    // 没有 view（首次加载）或后端没探到这个字段时，退回 0.164 实测抄录的表并标未核实。
    const fallback = codexFieldDomain(null, "shellType");
    expect(fallback.verified).toBe(false);
    expect(fallback.values).toContain("unified_exec");
    // 必填枚举不给「清除」，否则写进去的 null 会让整份目录被 Codex 拒掉。
    expect(fallback.nullable).toBe(false);
    expect(codexFieldDomain(null, "defaultVerbosity").nullable).toBe(true);
  });

  it("显式清除与「跟随 Codex」是两个状态，不能被归一化成同一个", async () => {
    const { catalogIntentEquals, emptyCodexCatalogIntent } = await import("../../src/lib/aiManage");
    const empty = emptyCodexCatalogIntent();
    const cleared = { excluded: [], overrides: { "gpt-5.5": { toolMode: "", flags: {} } }, customs: [] };
    expect(catalogIntentEquals(empty, cleared as never)).toBe(false);
    expect(catalogIntentEquals(cleared as never, cleared as never)).toBe(true);
  });

  it("兼容预设只写差异，且能从基础条目已经等于目标值的字段上省掉", async () => {
    const { applyCodexCompatPreset, isCodexCompatModel, emptyCodexModelOverride } = await import("../../src/lib/aiManage");
    const model = { slug: "gw/opus", displayName: "", description: "", base: "gpt-6-astra", overrides: emptyCodexModelOverride() };
    // 这是 0.164 内置条目的真实形状：GPT 侧的五个值全都写死在条目里。
    const gpt = { tool_mode: "code_mode_only", multi_agent_version: "v2", apply_patch_tool_type: "freeform", use_responses_lite: true, supports_image_detail_original: true };
    const preset = applyCodexCompatPreset(model as never, gpt, true);
    expect(preset.toolMode).toBe("");
    expect(preset.multiAgentVersion).toBe("");
    expect(preset.applyPatchToolType).toBe("");
    expect(preset.flags.use_responses_lite).toBe(false);
    expect(preset.flags.supports_image_detail_original).toBe(false);
    expect(isCodexCompatModel({ ...model, overrides: preset } as never, gpt)).toBe(true);
    expect(isCodexCompatModel(model as never, gpt)).toBe(false);
    // 模板本来就等于目标值时不记覆盖项（稀疏写法，保存出来的文件不因预设多出无意义差异）。
    const already = { tool_mode: null, multi_agent_version: null, apply_patch_tool_type: null, use_responses_lite: false, supports_image_detail_original: false };
    expect(applyCodexCompatPreset(model as never, already, true)).toEqual({ flags: {} });
    // 开关缺省不等于 false：Codex 自己定默认值，条目里没写就得显式钉上。
    expect(applyCodexCompatPreset(model as never, {}, true).flags.use_responses_lite).toBe(false);
    // 取下预设只撤销自己写过的键，用户另外设的东西不能跟着没。
    const mixed = { slug: "gw/opus", displayName: "", description: "", base: "gpt-6-astra", overrides: { toolMode: "", shellType: "unified_exec", flags: { use_responses_lite: false } } };
    expect(applyCodexCompatPreset(mixed as never, gpt, false)).toEqual({ shellType: "unified_exec", flags: {} });
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
