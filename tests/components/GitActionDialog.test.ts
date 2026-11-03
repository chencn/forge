// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import GitActionDialog from "../../src/components/GitActionDialog";
import type { GitState } from "../../src/hooks/useGitState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/hooks/useSettings", () => ({ useSettings: () => ({ settings: { vcs: { protectedBranches: "main;release/*", updateMethod: "rebase" } } }) }));
vi.mock("../../src/i18n", async (original) => ({ ...await original<typeof import("../../src/i18n")>(), useI18n: () => ({ t: (key: string) => key, locale: "zh-CN" }) }));

// 现有 PromptDialog 测试只有按钮键映射；推送表单需独立验证提交、确认及持久化边界。
let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof GitActionDialog>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => command === "git_push_target"
    ? { branch: "feature/a", remote: "origin", target: "feature/a", tracked: true } : []);
  props = { request: { kind: "push" }, git: {
    root: "D:/repo", status: { branch: "feature/a", detached: false }, probe: { remotes: ["origin", "backup"] }, branches: [], tags: [],
  } as unknown as GitState, onCancel: vi.fn(), onSubmit: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(GitActionDialog, props))); }
function button(key: string, scope: ParentNode = document) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === key)!; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function edit(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="git.targetBranch"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function checkbox(key: string) { return [...document.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent === key)!.querySelector<HTMLInputElement>("input")!; }

describe("推送表单公开行为", () => {
  it("更新使用保存的策略，确认时提交用户选择且不直接执行 Git", async () => {
    props.request = { kind: "update" };
    await render();
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    await click(radios[0]); await click(button("dialog.ok"));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ method: "merge" }));
    expect(invoke).not.toHaveBeenCalled();
  });
  it("编辑目标后提交真实参数，双击只提交一次", async () => {
    await render(); await edit(" review/a ");
    await click(button("git.push")); await click(button("git.push"));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ push: {
      branch: "feature/a", remote: "origin", target: "review/a", forceWithLease: false, setUpstream: false,
    } }));
  });
  it("标签与上游选项进入提交参数", async () => {
    props.request.target = { kind: "local", name: "feature/a" };
    await render(); await click(checkbox("git.setUpstream")); await click(checkbox("git.pushTags"));
    await click(button("git.push"));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ push: expect.objectContaining({ setUpstream: true, tags: "all" }) }));
  });
  it("强制确认取消不提交且保留表单，确认后才持久化当前目标的免警告", async () => {
    await render(); await click(checkbox("git.forceWithLease")); await click(button("git.forcePush"));
    expect(props.onSubmit).not.toHaveBeenCalled();
    let confirmation = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    await click(button("dialog.cancel", confirmation));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    await click(button("git.forcePush")); await click(checkbox("git.dontWarnTarget"));
    confirmation = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    await click(button("git.forcePush", confirmation));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ push: expect.objectContaining({ forceWithLease: true }) }));
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toContain(JSON.stringify(["D:/repo", "origin", "feature/a"]));
  });
  it("受保护目标禁用有效强推，空目标禁止提交", async () => {
    await render(); await click(checkbox("git.forceWithLease")); await edit("main");
    expect(checkbox("git.forceWithLease").disabled).toBe(true);
    expect(checkbox("git.forceWithLease").checked).toBe(false);
    await edit(" "); expect(button("git.forcePush").disabled).toBe(true);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it("预览失败禁止提交，重新加载成功后可继续", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("offline"));
    await render(); expect(button("git.push").disabled).toBe(true);
    await click(button("git.retryPushPreview")); expect(button("git.push").disabled).toBe(false);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it("推送部分历史保留源分支与修订，隐藏无效的上游/标签选项", async () => {
    props.request = { kind: "push", target: { kind: "local", name: "feature/a" }, revision: "abc123" };
    await render(); await click(button("git.push"));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ push: expect.objectContaining({ branch: "feature/a", revision: "abc123", setUpstream: false }) }));
    expect([...document.querySelectorAll("label")].some((label) => label.textContent === "git.pushTags")).toBe(false);
  });
});
