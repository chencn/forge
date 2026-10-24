import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCapabilities, AiRunOptions } from "../../src/lib/aiRuntime";
import type { AiComposerHandle } from "../../src/components/AiComposerOptions";
import { NO_COMPACT_DECISION } from "../../src/lib/aiCompact";
const h = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), loadConfig: vi.fn(), updateConfig: vi.fn(), states: [] as unknown[], index: 0 }));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../src/lib/aiRuntime", () => ({ loadAiCapabilities: h.load, saveAiCustomModel: h.save, loadAiProjectConfig: h.loadConfig, updateAiProjectConfig: h.updateConfig }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? initial() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? next(h.states[index]) : next; }];
    },
    useImperativeHandle: (ref: { current: unknown }, factory: () => unknown) => { if (ref) ref.current = factory(); },
  };
});
import AiComposerOptions from "../../src/components/AiComposerOptions";
import AiContextChip from "../../src/components/AiContextChip";
import AiCompactPanel from "../../src/components/AiCompactPanel";
const catalog: AiCapabilities = { models: [
  { id: "fast-model", name: "Fast model", isDefault: true, efforts: ["low", "high"], serviceTiers: [{ name: "Fast", id: "priority", description: "fixture" }] },
  { id: "slow-model", name: "Slow model", efforts: ["low"], isDefault: false },
], efforts: ["low", "high"], customModel: false, authoritative: true, remote: false };
let onChange = vi.fn();
/** 压缩判定由面板算，这里只给中性值：这些用例测的是模型、权限和参数校验。 */
const compactProps = { compact: NO_COMPACT_DECISION, autoCompact: false, compacting: false, onCompact: () => {}, onCompactLater: () => {}, onAutoCompact: () => {} };
function render(value: AiRunOptions = {}, disabled = false, provider: "claude" | "codex" = "codex") {
  const ref = { current: null as AiComposerHandle | null };
  let pane!: ReactElement<any>;
  h.index = 0;
  function Harness() { pane = AiComposerOptions({ commandRef: ref, provider, workspace: "D:/fixture", value, onChange, disabled }); return null; }
  renderToStaticMarkup(createElement(Harness));
  return { pane, execute: ref.current!.execute };
}
/** 上下文芯片独立渲染；压缩面板在点开后的弹出层里。 */
function renderChip(provider: "claude" | "codex", overrides: Partial<typeof compactProps> = {}) {
  let pane!: ReactElement<any>;
  // 每次都从干净状态开始：上一个引擎点开的弹层不能泄漏到这一轮的初始 open。
  h.states = []; h.index = 0;
  const props = { ...compactProps, ...overrides };
  function Harness() { pane = AiContextChip({ provider, ...props }); return pane; }
  const first = renderToStaticMarkup(createElement(Harness));
  const trigger = find(pane, (node) => node.type === "button" && String(node.props.className).startsWith("ai-context-trigger"))!;
  trigger.props.onClick({ currentTarget: trigger });
  // 槽位 mock 按调用次序取值：重渲染前把序号拨回去，第二次渲染才会读到点击后的状态。
  h.index = 0;
  const html = renderToStaticMarkup(createElement(Harness));
  return { pane, html, first };
}
function find(node: ReactElement<any>, predicate: (node: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (predicate(node)) return node;
  for (const child of [node.props.children].flat(Infinity)) {
    if (child && typeof child === "object" && "props" in child) { const result = find(child, predicate); if (result) return result; }
  }
}
beforeEach(() => { h.states = []; h.index = 0; h.load.mockReset(); h.load.mockResolvedValue(catalog); h.save.mockReset(); h.save.mockResolvedValue(catalog); h.loadConfig.mockReset(); h.loadConfig.mockResolvedValue({ permission: "ask" }); h.updateConfig.mockReset(); h.updateConfig.mockImplementation(async (_workspace, patch) => ({ permission: "ask", ...patch })); onChange = vi.fn(); });
describe("composer slash parameter execution", () => {
  it("selects the canonical ID for a display name or differently cased model without creating a custom entry", async () => {
    h.load.mockResolvedValue({ ...catalog, models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", catalogId: "astra-picker", efforts: ["high"] }], customModel: true });
    for (const input of ["GPT-6-Astra", "GPT-6 Astra", "astra-picker"]) {
      await render().execute("model", input);
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-6-astra" }));
    }
    expect(h.save).not.toHaveBeenCalled();
  });
  it("shows the context percentage from turn usage when the classification snapshot is absent", () => {
    let pane!: ReactElement<any>;
    function Harness() {
      pane = AiContextChip({ provider: "claude", usage: { context: 250, window: 1000, total: 8000 }, compact: NO_COMPACT_DECISION, autoCompact: false, compacting: false, onCompact: () => {}, onCompactLater: () => {}, onAutoCompact: () => {} });
      return pane;
    }
    h.states = []; h.index = 0;
    const html = renderToStaticMarkup(createElement(Harness));
    // 没有分类快照时，折叠状态的芯片也必须报出比例，而不是只剩「--」。
    expect(html).toContain("25%");
    // 与弹层同一格式：整数值不带小数位，避免出现 15% / 14.9% 这种两套写法。
    expect(html).not.toContain("25.0%");
  });
  it("gives both engines the context chip and the compaction entry inside it", async () => {
    for (const provider of ["codex", "claude"] as const) {
      const chip = renderChip(provider);
      expect(chip.first).toContain("ai-context-trigger");
      // 空闲且未开自动时不占弹层：压缩建议只在值得做时出现。
      expect(chip.html).not.toContain("ai-compact-panel");
      // Codex 没有分类明细，但压缩照样能点：开过自动后入口就在弹层里。
      const withAuto = renderChip(provider, { autoCompact: true });
      expect(find(withAuto.pane, (node) => node.type === AiCompactPanel)).toBeDefined();
    }
  });
  it.each(["claude", "codex"] as const)("persists a custom %s model and retains the selected ID", async (provider) => {
    h.load.mockResolvedValue({ ...catalog, customModel: true });
    await render({}, false, provider).execute("model", "my-model");
    expect(h.save).toHaveBeenCalledWith(provider, "my-model");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ model: "my-model" }));
  });
  it("keeps Claude effort levels available even when the active alias declares none", async () => {
    h.load.mockResolvedValue({ ...catalog, models: [{ id: "haiku", name: "Haiku", efforts: [], isDefault: true }], efforts: ["low", "medium", "high", "xhigh", "max"], customModel: true });
    // --effort 是 Claude 的会话级参数；Haiku 的目录项没写档位也不能把入口藏掉。
    await render({ model: "haiku" }, false, "claude").execute("effort", "high");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "high" }));
  });
  it("uses the capability catalog for model and effort and clears incompatible settings", async () => {
    await render({ model: "fast-model", effort: "high", fast: true }).execute("model", "slow-model");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ model: "slow-model", fast: false }));
    await expect(render({ model: "slow-model" }).execute("effort", "high")).rejects.toThrow("ai.commands.invalidArgs");
    await render({ model: "slow-model" }).execute("effort", "low");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low" }));
    await expect(render().execute("model", "invented")).rejects.toThrow("ai.commands.invalidArgs");
    await expect(render().execute("model", '"fast-model" extra')).rejects.toThrow("ai.commands.invalidArgs");
  });
  it("keeps full permissions behind the existing explicit risk confirmation", async () => {
    await render().execute("permissions", "full");
    expect(onChange).not.toHaveBeenCalled();
    const dialog = find(render().pane, (node) => node.props.confirm === "ai.chat.confirmFull");
    expect(dialog).toBeDefined(); dialog!.props.onConfirm();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ permission: "full", planMode: false }));
  });
  it("accepts ask/auto and Codex read-only but rejects unknown permissions", async () => {
    await render().execute("permissions", "auto");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ permission: "auto" }));
    // 只读是 Codex 的独立档位，必须能选并原样交给发送逻辑；Claude 没有这一档。
    await render().execute("permissions", "read");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ permission: "read" }));
    await expect(render({}, false, "claude").execute("permissions", "read")).rejects.toThrow();
    await expect(render().execute("permissions", "bypass")).rejects.toThrow();
    expect(h.load).not.toHaveBeenCalled();
  });
  it("enables Fast only with a supported model and can turn it off without discovery", async () => {
    await render().execute("fast", "on");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fast: true }));
    await expect(render({}, false, "claude").execute("fast", "on")).rejects.toThrow();
    h.load.mockClear(); await render({ fast: true }).execute("fast", "off");
    expect(h.load).not.toHaveBeenCalled(); expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fast: false }));
  });
  it("opens no-argument controls or reports unavailable controls instead of silent success", async () => {
    // 无参 /model、/effort 现在改为打开设置芯片的弹出层，不再点击旧选择器。
    await expect(render().execute("model", "")).resolves.toBeUndefined();
    await expect(render({}, true).execute("effort", "")).rejects.toThrow("ai.commands.busy");
    await expect(render({}, true).execute("permissions", "auto")).rejects.toThrow("ai.commands.busy");
    await expect(render().execute("context", "unexpected")).rejects.toThrow("ai.commands.invalidArgs");
  });
});
