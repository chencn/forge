// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { notificationCenter } from "../../src/lib/notifications";
import { useGitState, type GitState } from "../../src/hooks/useGitState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/lib/notifications", () => ({ notificationCenter: { notify: vi.fn() } }));

// 现有测试没有覆盖 useGitState；这里验证公开异步状态和 IPC 去重，不检查组件结构。
let host: HTMLDivElement;
let root: Root;
let state: GitState;
const reportError = vi.fn();
const write = vi.fn();
const probe = (path: string) => ({ available: true, repoRoot: path, remotes: ["origin"], midMerge: false, midRebase: false, midCherryPick: false, midRevert: false });
function Probe({ path }: { path: string }) { state = useGitState(path, reportError); return null; }
async function render(path = "D:/repo") { await act(async () => root.render(createElement(Probe, { path }))); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  reportError.mockReset(); write.mockReset(); vi.mocked(invoke).mockReset(); vi.mocked(notificationCenter.notify).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_probe") return probe((args as { path: string }).path);
    if (command === "git_status") return { branch: "main", detached: false, upstream: "origin/main", ahead: 1, behind: 0, changes: [] };
    if (command === "git_refs") return { branches: [], tags: [] };
    if (command === "git_log") return [{ hash: "abc", short: "abc", subject: "change", author: "Tester", authoredMs: 1, refs: "", parents: [] }];
    if (command === "git_stash_list" || command === "git_shelves") return [];
    return write(command, args);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("Git 操作生命周期", () => {
  it("抓取从发起到刷新完成持续运行，连续点击以及交叉推送只发出一条请求", async () => {
    const pending = deferred<string>(); write.mockReturnValue(pending.promise);
    await render();
    let first!: Promise<string | null>;
    let duplicate!: Promise<string | null>;
    let push!: Promise<string | null>;
    await act(async () => { first = state.fetch(); duplicate = state.fetch(); push = state.push(false); });
    expect(state.operation).toMatchObject({ kind: "fetch", phase: "running" });
    expect(write).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBeNull(); await expect(push).resolves.toBeNull();
    await act(async () => { pending.resolve(""); await first; });
    expect(state.operation).toMatchObject({ kind: "fetch", phase: "success" });
    expect(reportError).not.toHaveBeenCalled();
  });
  it("更新失败后展示失败状态、重探冲突并释放请求锁", async () => {
    write.mockRejectedValueOnce(new Error("update conflict")).mockResolvedValue("fetched");
    await render();
    const before = vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_probe").length;
    await act(async () => { expect(await state.pull("rebase")).toBeNull(); });
    expect(reportError).toHaveBeenCalledWith("update conflict", "pull");
    expect(state.operation).toMatchObject({ kind: "pull", phase: "error" });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_probe").length).toBeGreaterThan(before);
    await act(async () => { expect(await state.fetch()).toBe("fetched"); });
    expect(state.operation).toMatchObject({ kind: "fetch", phase: "success" });
  });
  it("切换工程后，旧工程任务完成不能覆盖新工程正在运行的状态", async () => {
    const oldTask = deferred<string>(); const newTask = deferred<string>();
    write.mockReturnValueOnce(oldTask.promise).mockReturnValueOnce(newTask.promise);
    await render(); let first!: Promise<string | null>; let second!: Promise<string | null>;
    await act(async () => { first = state.fetch(); });
    await render("D:/other");
    expect(state.operation).toBeNull();
    await act(async () => { second = state.fetch(); });
    const currentId = state.operation?.id;
    await act(async () => { oldTask.resolve("done"); await first; });
    expect(state.operation).toMatchObject({ id: currentId, kind: "fetch", phase: "running" });
    expect(notificationCenter.notify).not.toHaveBeenCalled();
    await act(async () => { newTask.resolve("done"); await second; });
    expect(state.operation).toMatchObject({ id: currentId, phase: "success" });
    expect(notificationCenter.notify).toHaveBeenCalledTimes(1);
  });
  it("提交成功但推送失败时仍保留提交成功语义，推送状态必须失败", async () => {
    write.mockResolvedValueOnce("committed").mockRejectedValueOnce(new Error("rejected"));
    await render();
    await act(async () => { expect(await state.commitAndPush("change", false)).toBe(true); });
    expect(state.operation).toMatchObject({ kind: "push", phase: "error" });
    expect(state.pushing).toBe(false);
    expect(reportError).toHaveBeenCalledWith("rejected", "push");
  });
  it("两个工程并行运行时，切回旧工程仍能恢复它自己的忙碌状态", async () => {
    const firstTask = deferred<string>(); const secondTask = deferred<string>();
    write.mockReturnValueOnce(firstTask.promise).mockReturnValueOnce(secondTask.promise);
    await render(); let first!: Promise<string | null>; let second!: Promise<string | null>;
    await act(async () => { first = state.push(false); });
    const firstId = state.operation?.id;
    await render("D:/other");
    expect(state.pushing).toBe(false);
    await act(async () => { second = state.fetch(); });
    await render();
    expect(state.operation).toMatchObject({ id: firstId, kind: "push", phase: "running" });
    expect(state.pushing).toBe(true);
    await act(async () => { expect(await state.fetch()).toBeNull(); });
    expect(write).toHaveBeenCalledTimes(2);
    await act(async () => { firstTask.resolve("done"); secondTask.resolve("done"); await Promise.all([first, second]); });
  });
});
