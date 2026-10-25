import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, text: vi.fn() }));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../src/lib/aiManage", async (original) => {
  const manage = await original<typeof import("../../src/lib/aiManage")>();
  return { ...manage, readAiCliCodexCatalogText: h.text };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? initial() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? next(h.states[index]) : next; }];
    },
    // 服务端渲染不跑 effect：这里让它直接跑一遍，好验证「展开哪一行就取哪一行的提示词」。
    useEffect: (body: () => void | (() => void)) => { const cleanup = body(); if (typeof cleanup === "function") cleanup(); },
  };
});
import CodexCatalogSection from "../../src/components/CodexCatalogSection";
import { emptyCodexCatalogIntent, emptyCodexModelOverride } from "../../src/lib/aiManage";
import type { CodexCatalogIntent, CodexCatalogView } from "../../src/lib/aiManage";

const shellDomain = { values: ["default", "local", "shell_command", "unified_exec", "disabled"], nullable: false, verified: true };
const verbosityDomain = { values: ["low", "medium", "high"], nullable: true, verified: true };

function view(overrides: Partial<CodexCatalogView> = {}): CodexCatalogView {
  return {
    path: "C:/codex/forge-model-catalog.json",
    active: true,
    error: null,
    intent: emptyCodexCatalogIntent(),
    models: [
      // GPT 侧的真实形状（0.164 内置条目实测）：这五项就是兼容预设要改的东西。
      { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list", shell_type: "unified_exec", context_window: 272000,
        tool_mode: "code_mode_only", multi_agent_version: "v2", apply_patch_tool_type: "freeform",
        use_responses_lite: true, supports_image_detail_original: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    ],
    hidden: [],
    domains: { shell_type: shellDomain, default_verbosity: verbosityDomain },
    flags: ["use_responses_lite", "supports_reasoning_summary_parameter", "brand_new_flag"],
    flagsVerified: true,
    ...overrides,
  } as CodexCatalogView;
}

let onChange = vi.fn();
/**
 * 渲染清单面板。组件里的两个 useState 按调用次序落进槽位：`open`（第 0 个）与
 * 提示词缓存（第 1 个），所以想默认展开某一行就直接把 open 预置成那一行的 key。
 */
function renderCatalog(draft: CodexCatalogIntent, current: CodexCatalogView, openSlug: string | null, embedded = false) {
  let pane!: ReactElement<any>;
  function Harness() {
    pane = CodexCatalogSection({
      view: current, draft, loading: false, busy: false, dirty: false, currentModel: "gpt-6-astra", notice: null,
      embedded,
      onChange, onPickDefault: () => {}, onSave: () => {}, onClear: () => {}, onReload: () => {},
    });
    return null;
  }
  h.states = openSlug === null ? [] : [openSlug];
  h.index = 0;
  renderToStaticMarkup(createElement(Harness));
  return pane;
}

function find(node: ReactElement<any>, predicate: (node: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (predicate(node)) return node;
  for (const child of [node.props.children].flat(Infinity)) {
    if (child && typeof child === "object" && "props" in child) { const result = find(child, predicate); if (result) return result; }
  }
}
function collect(node: ReactElement<any>, predicate: (node: ReactElement<any>) => boolean, out: ReactElement<any>[] = []): ReactElement<any>[] {
  if (predicate(node)) out.push(node);
  for (const child of [node.props.children].flat(Infinity)) {
    if (child && typeof child === "object" && "props" in child) collect(child, predicate, out);
  }
  return out;
}
/** 按 label 找到某个字段的下拉，返回它的选项值列表。 */
function selectFor(pane: ReactElement<any>, label: string) {
  const node = find(pane, (child) => child.props.label === label);
  return node ? { node, values: (node.props.options as { value: string }[]).map((option) => option.value) } : undefined;
}

beforeEach(() => { onChange = vi.fn(); h.states = []; h.index = 0; h.text.mockReset(); h.text.mockResolvedValue("Codex 自带的提示词"); });

describe("Codex 模型清单编辑器", () => {
  it("下拉选项用后端实测的取值域，不是界面里写死的表", () => {
    const pane = renderCatalog(emptyCodexCatalogIntent(), view(), "gpt-6-astra");
    const shell = selectFor(pane, "ai.catalog.shellType");
    // `shell_command` 只存在于 CLI 报回来的取值里：能看见它就证明选项来自实测而不是兜底表。
    expect(shell?.values).toEqual(["\u0000inherit", "default", "local", "shell_command", "unified_exec", "disabled"]);
  });

  it("必填枚举不给「清除」，可选枚举才给", () => {
    const pane = renderCatalog(emptyCodexCatalogIntent(), view(), "gpt-6-astra");
    expect(selectFor(pane, "ai.catalog.shellType")?.values).not.toContain("\u0000clear");
    expect(selectFor(pane, "ai.catalog.verbosity")?.values).toContain("\u0000clear");
  });

  it("取值域没能问到 CLI 时把来源说清楚", () => {
    const unverified = view({ domains: { shell_type: { values: ["unified_exec", "disabled"], nullable: false, verified: false } }, flags: ["use_responses_lite"], flagsVerified: false });
    const pane = renderCatalog(emptyCodexCatalogIntent(), unverified, "gpt-6-astra");
    const html = renderToStaticMarkup(pane);
    expect(html).toContain("ai.catalog.unverified");
  });

  it("开关列表跟着这一版 Codex 走：探不到的不显示，新键原样报名字", () => {
    const pane = renderCatalog(emptyCodexCatalogIntent(), view(), "gpt-6-astra");
    const labels = collect(pane, (node) => node.props.className === "ai-cli-row-switch")
      .map((node) => String((node.props.children as { props: { children: unknown } }[])[0].props.children));
    expect(labels).toContain("ai.catalog.flagSummaryParam");
    // 后端不再返回的键（比如 0.164 已忽略的 supports_parallel_tool_calls）不该还有开关。
    expect(labels).not.toContain("ai.catalog.flagParallel");
    // 这版 CLI 新出现、Forge 还没配文案的键：原样显示它自己的名字，而不是替它编一个。
    expect(labels).toContain("brand_new_flag");
  });

  it("系统提示词按需取当前行的模板条目，改动才落成覆盖项", () => {
    renderCatalog(emptyCodexCatalogIntent(), view(), "gpt-6-astra");
    expect(h.text).toHaveBeenCalledWith("gpt-6-astra");
    const pane = renderCatalog({ ...emptyCodexCatalogIntent(), overrides: { "gpt-6-astra": { ...emptyCodexModelOverride(), baseInstructions: "只允许只读操作" } } }, view(), "gpt-6-astra");
    const box = find(pane, (node) => node.type === "textarea")!;
    expect(box.props.value).toBe("只允许只读操作");
    box.props.onChange({ target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ overrides: {} }));
  });

  it("两个添加入口分别对应原生 GPT 与 OpenAI 兼容预设", () => {
    const pane = renderCatalog(emptyCodexCatalogIntent(), view(), null);
    const buttons = collect(pane, (node) => node.props.className === "lsp-action" && typeof node.props.onClick === "function"
      && String(node.props.children[1] ?? "").startsWith("ai.catalog.add"));
    expect(buttons.map((node) => node.props.children[1])).toEqual(["ai.catalog.addGpt", "ai.catalog.addCompat"]);
    buttons[0].props.onClick({});
    expect(onChange.mock.calls.at(-1)?.[0].customs[0].overrides).toEqual(emptyCodexModelOverride());
    buttons[1].props.onClick({});
    const compat = onChange.mock.calls.at(-1)?.[0].customs[0].overrides;
    // 兼容预设要动的五件事：GPT 侧的工具方言清掉，responses-lite 与原图细节钉成 false。
    expect(compat.toolMode).toBe("");
    expect(compat.multiAgentVersion).toBe("");
    expect(compat.applyPatchToolType).toBe("");
    expect(compat.flags).toEqual({ use_responses_lite: false, supports_image_detail_original: false });
  });

  it("Codex 自己内部用的隐藏条目不进排除名单，但仍是可克隆的模板", () => {
    const withHidden = view({ models: [...view().models, { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide" }] });
    const pane = renderCatalog(emptyCodexCatalogIntent(), withHidden, null);
    const rows = collect(pane, (node) => ["ai-catalog-row", "ai-catalog-row is-excluded"].includes(String(node.props.className)))
      .map((node) => String(node.key));
    expect(rows).toEqual(["gpt-6-astra"]);
    // 模板下拉里仍然能选到它：自定义模型照 codeg 一样可以以任何官方条目为底。
    const custom = { ...emptyCodexCatalogIntent(), customs: [{ slug: "gw/opus", displayName: "Opus", description: "", base: "gpt-6-astra", overrides: emptyCodexModelOverride() }] };
    const opened = renderCatalog(custom, withHidden, "custom:0");
    const baseSelect = find(opened, (node) => node.props.label === "ai.catalog.base")!;
    expect((baseSelect.props.options as { value: string }[]).map((option) => option.value)).toEqual(["gpt-6-astra", "codex-auto-review"]);
  });

  it("显式清除是一个真实的覆盖项，不会被当成「没有改动」而丢掉", () => {
    const draft = { ...emptyCodexCatalogIntent(), overrides: { "gpt-6-astra": { ...emptyCodexModelOverride(), toolMode: "" } } };
    const pane = renderCatalog(draft, view(), "gpt-6-astra");
    const shell = selectFor(pane, "ai.catalog.shellType")!.node;
    shell.props.onChange("\u0000clear");
    const next = onChange.mock.calls.at(-1)?.[0].overrides["gpt-6-astra"];
    expect(next.toolMode).toBe("");
  });

  it("官方条目为空时依然允许添加自定义模型并保持按钮可用", () => {
    const emptyView = view({ models: [] });
    const pane = renderCatalog(emptyCodexCatalogIntent(), emptyView, null);
    const buttons = collect(pane, (node) => node.props.className === "lsp-action" && typeof node.props.onClick === "function"
      && String(node.props.children[1] ?? "").startsWith("ai.catalog.add"));
    expect(buttons[0].props.disabled).toBe(false);
    buttons[0].props.onClick({});
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      customs: [expect.objectContaining({ slug: "", base: "" })],
    }));
  });

  it("嵌入模式隐藏独立标题与独立保存按钮", () => {
    const pane = renderCatalog(emptyCodexCatalogIntent(), view(), null, true);
    const html = renderToStaticMarkup(pane);
    expect(html).not.toContain("ai.catalog.save");
    expect(html).not.toContain("ai.catalog.active");
  });

  it("第一行提供模型 ID、显示名与上下文长度，Star 键可设默认模型", () => {
    const custom = {
      ...emptyCodexCatalogIntent(),
      customs: [{ slug: "custom/gpt", displayName: "Custom GPT", contextWindow: 128000, description: "", base: "gpt-6-astra", overrides: emptyCodexModelOverride() }],
    };
    const pane = renderCatalog(custom, view(), null);
    const inputs = collect(pane, (node) => node.type === "input");
    expect(inputs.some((input) => input.props.value === "custom/gpt")).toBe(true);
    expect(inputs.some((input) => input.props.value === "Custom GPT")).toBe(true);
    expect(inputs.some((input) => input.props.value === 128000)).toBe(true);

    const customRow = find(pane, (node) => node.props.className === "ai-catalog-custom")!;
    const starBtn = find(customRow, (node) => node.props.className?.includes("ai-catalog-star") && node.props["aria-label"] === "ai.catalog.default");
    expect(starBtn).toBeDefined();
    starBtn!.props.onClick({});
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      default: "custom/gpt",
    }));
  });
});
