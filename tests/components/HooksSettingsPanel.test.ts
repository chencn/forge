import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[], invoke: vi.fn(), dirty: (): boolean => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke, isTauri: () => true }));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({
  t: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${Object.values(vars).join(",")}` : key,
}) }));
vi.mock("../../src/hooks/useUnsavedGuard", () => ({ useUnsavedGuard: (check: () => boolean) => { h.dirty = check; } }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [h.slots[index], (next: unknown) => {
      h.slots[index] = typeof next === "function" ? next(h.slots[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    return h.slots[index] ?? (h.slots[index] = { current: initial });
  },
  useEffect: (body: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const previous = h.effects.get(index);
    if (previous && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    h.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = body();
      h.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  },
}));
import HooksSettingsPanel from "../../src/components/HooksSettingsPanel";
import Select from "../../src/components/Select";
import AiActionDialog from "../../src/components/AiActionDialog";

type Node = ReactElement<any>;
let tree: Node;
const command = (text = "echo old") => ({ type: "command", command: text });
const initial = () => ({ Stop: [{ hooks: [command()] }] });
const file = (provider: string, hooks: unknown = {}) => ({ path: `C:/${provider}/${provider === "codex" ? "hooks" : "settings"}.json`, hooks });
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...nodes(element.props.children)];
}
function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Node).props.children) : "";
}
function find(predicate: (node: Node) => boolean): Node {
  const found = nodes(tree).find(predicate);
  if (!found) throw new Error("UI control missing");
  return found;
}
function draw() {
  h.cursor = 0; h.pending = [];
  function Harness() { tree = HooksSettingsPanel(); return null; }
  renderToStaticMarkup(createElement(Harness));
  // 跑真实组件登记的 effect，控制响应顺序；不渲染子组件或依赖浏览器布局。
  h.pending.forEach((effect) => effect());
}
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  draw();
}
const button = (label: string) => find((node) => node.type === "button" && text(node.props.children).trim() === label);
const input = (label: string) => find((node) => (node.type === "input" || node.type === "textarea") && node.props["aria-label"] === label);
const change = (label: string, value: string) => { input(label).props.onChange({ target: { value } }); draw(); };
const choose = (provider: string) => { find((node) => node.type === Select).props.onChange(provider); draw(); };
const confirm = () => { find((node) => node.type === AiActionDialog).props.onConfirm(""); draw(); };
function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  h.effects.forEach((effect) => effect.cleanup?.());
  h.slots = []; h.cursor = 0; h.effects.clear(); h.pending = []; h.dirty = () => false;
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (name: string, args?: any) => {
    if (name === "ai_cli_hooks_read") return file(args.provider, initial());
    if (name === "ai_cli_hooks_save") return file(args.provider, args.hooks);
    if (name === "ai_cli_codex_hooks_status") return { data: [] };
    throw new Error(`Unexpected IPC: ${name}`);
  });
});

describe("Hooks 配置交互与 IPC 契约", () => {
  it("保存当前提供商、原生树和基线，保留其它类型与未知字段", async () => {
    const hooks = { Stop: [{ custom: true, hooks: [command(), { type: "prompt", prompt: "keep" }] }],
      Future: [{ hooks: [{ type: "future", value: 42 }] }] };
    h.invoke.mockResolvedValueOnce(file("claude", hooks));
    draw(); await settle();
    const changed = "echo changed\n  echo second";
    change("Stop command", changed);
    expect(h.dirty()).toBe(true);
    await button("hooks.save").props.onClick(); await settle();
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_hooks_save", {
      provider: "claude", expected: hooks,
      hooks: { ...hooks, Stop: [{ custom: true, hooks: [command(changed), { type: "prompt", prompt: "keep" }] }] },
    });
    expect(h.dirty()).toBe(false);
    expect(button("hooks.save").props.disabled).toBe(true);
  });

  it("读取失败不能保存空配置，重新读取成功后恢复编辑", async () => {
    h.invoke.mockRejectedValueOnce(new Error("invalid JSON"));
    draw(); await settle();
    expect(button("hooks.save").props.disabled).toBe(true);
    expect(h.dirty()).toBe(false);
    expect(nodes(tree).filter((node) => node.props.role === "alert").map((node) => text(node.props.children)))
      .toEqual(["Error: invalid JSON"]);
    button("hooks.reload").props.onClick(); draw(); await settle();
    change("Stop command", "echo recovered");
    expect(button("hooks.save").props.disabled).toBe(false);
  });

  it("有草稿时取消切换保留内容，确认后才读取另一个提供商", async () => {
    draw(); await settle(); change("Stop command", "echo draft");
    choose("codex");
    find((node) => node.type === AiActionDialog).props.onCancel(); draw();
    expect(input("Stop command").props.value).toBe("echo draft");
    expect(h.invoke).not.toHaveBeenCalledWith("ai_cli_hooks_read", { provider: "codex" });
    choose("codex"); confirm(); await settle();
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_hooks_read", { provider: "codex" });
    expect(input("Stop command").props.value).toBe("echo old");
    expect(h.dirty()).toBe(false);
  });

  it("慢读取不能覆盖后来选中的 CLI", async () => {
    const old = defer<ReturnType<typeof file>>();
    h.invoke.mockReturnValueOnce(old.promise);
    draw(); choose("codex"); await settle();
    old.resolve(file("claude", { Stop: [{ hooks: [command("stale claude")] }] }));
    await settle(); change("Stop command", "echo codex");
    button("hooks.save").props.onClick(); await settle();
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_hooks_save", {
      provider: "codex", hooks: { Stop: [{ hooks: [command("echo codex")] }] }, expected: initial(),
    });
  });

  it("保存失败保留草稿，可重试；保存期间拦截导航与重复保存", async () => {
    const saving = defer<ReturnType<typeof file>>();
    draw(); await settle(); change("Stop command", "echo draft");
    h.invoke.mockReturnValueOnce(saving.promise);
    const click = button("hooks.save").props.onClick;
    click(); click(); choose("codex");
    expect(h.invoke.mock.calls.filter(([name]) => name === "ai_cli_hooks_save")).toHaveLength(1);
    expect(find((node) => node.type === Select).props.value).toBe("claude");
    saving.reject(new Error("conflict")); await settle();
    expect(h.dirty()).toBe(true);
    expect(input("Stop command").props.value).toBe("echo draft");
    button("hooks.save").props.onClick(); await settle();
    expect(h.dirty()).toBe(false);
  });

  it.each(["1.5", "-1", "1e2", "9007199254740992"])("非法超时 %s 阻止保存且不截断", async (value) => {
    draw(); await settle(); change("Stop timeout", value);
    expect(input("Stop timeout").props.value).toBe(value);
    expect(button("hooks.save").props.disabled).toBe(true);
    button("hooks.save").props.onClick(); await settle();
    expect(h.invoke.mock.calls.some(([name]) => name === "ai_cli_hooks_save")).toBe(false);
    change("Stop timeout", "30"); button("hooks.save").props.onClick(); await settle();
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_hooks_save", expect.objectContaining({
      hooks: { Stop: [{ hooks: [{ ...command(), timeout: 30 }] }] },
    }));
  });

  it("Codex 的异步、matcher 和事件超时遵守原生约束", async () => {
    draw(); await settle(); choose("codex"); await settle();
    find((node) => node.type === "button" && node.props["aria-label"] === "SessionEnd hooks.addRule").props.onClick(); draw();
    change("SessionEnd command", "echo end");
    expect(input("SessionEnd async").props.disabled).toBe(true);
    expect(input("Stop matcher").props.disabled).toBe(true);
    change("SessionEnd timeout", "4");
    expect(button("hooks.save").props.disabled).toBe(true);
    change("SessionEnd timeout", "3");
    input("Stop async").props.onChange({ target: { checked: true } }); draw();
    button("hooks.save").props.onClick(); await settle();
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_hooks_save", expect.objectContaining({ provider: "codex", hooks: {
      Stop: [{ hooks: [{ ...command(), async: true }] }],
      SessionEnd: [{ matcher: "", hooks: [{ ...command("echo end"), timeout: 3 }] }],
    } }));
  });

  it("删除命令时保留同一规则的非命令类型", async () => {
    const prompt = { type: "prompt", prompt: "keep" };
    const hooks = { Stop: [{ matcher: "", hooks: [command(), prompt] }] };
    h.invoke.mockResolvedValueOnce(file("claude", hooks));
    draw(); await settle();
    find((node) => node.type === "button" && node.props["aria-label"] === "hooks.delete").props.onClick(); draw();
    button("hooks.save").props.onClick(); await settle();
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_hooks_save", {
      provider: "claude", expected: hooks, hooks: { Stop: [{ matcher: "", hooks: [prompt] }] },
    });
  });

  it("原生状态查询失败与保存结果分开，失败后草稿仍正确清除", async () => {
    const implementation = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation((name: string, args?: any) => name === "ai_cli_codex_hooks_status"
      ? Promise.reject(new Error("method unavailable")) : implementation(name, args));
    draw(); await settle(); choose("codex"); await settle();
    change("Stop command", "echo saved"); button("hooks.save").props.onClick(); await settle();
    expect(h.dirty()).toBe(false);
    const alerts = nodes(tree).filter((node) => node.props.role === "alert").map((node) => text(node.props.children));
    expect(alerts).toEqual(["hooks.statusFailed:Error: method unavailable"]);
    expect(nodes(tree).some((node) => node.props.role === "status" && text(node.props.children).startsWith("hooks.saved:"))).toBe(true);
  });

  it("状态查询未返回时保存失败，取消草稿后不能残留加载状态", async () => {
    const pending = defer<{ data: [] }>();
    const implementation = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation((name: string, args?: any) => {
      if (name === "ai_cli_codex_hooks_status") return pending.promise;
      if (name === "ai_cli_hooks_save") return Promise.reject(new Error("external edit"));
      return implementation(name, args);
    });
    draw(); await settle(); choose("codex"); await settle();
    change("Stop command", "echo draft"); button("hooks.save").props.onClick(); await settle();
    change("Stop command", "echo old");
    expect(h.dirty()).toBe(false);
    expect(nodes(tree).some((node) => node.props.role === "status" && text(node.props.children) === "hooks.checking")).toBe(false);
    pending.resolve({ data: [] }); await settle();
    expect(nodes(tree).filter((node) => node.props.role === "alert").map((node) => text(node.props.children))).toEqual(["Error: external edit"]);
  });
});
