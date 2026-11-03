// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { notificationCenter } from "../../src/lib/notifications";
import { useGitState, type GitState } from "../../src/hooks/useGitState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage = (_line: string) => {}; } }));
vi.mock("../../src/lib/notifications", () => ({ notificationCenter: { notify: vi.fn() } }));

// 现有测试没有覆盖 useGitState；这里验证公开异步状态和 IPC 去重，不检查组件结构。
let host: HTMLDivElement;
let root: Root;
let state: GitState;
const reportError = vi.fn();
const write = vi.fn();
const beforeUpdate = vi.fn();
let workflow: NonNullable<Parameters<typeof useGitState>[3]>;
const probe = (path: string) => ({ available: true, repoRoot: path, remotes: ["origin"], midMerge: false, midRebase: false, midCherryPick: false, midRevert: false });
function Probe({ path }: { path: string }) { state = useGitState(path, reportError, undefined, workflow); return null; }
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
  beforeUpdate.mockReset().mockResolvedValue(undefined);
  workflow = { beforeUpdate };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "git_probe") return probe((args as { path: string }).path);
    if (command === "git_status") return { branch: "main", detached: false, upstream: "origin/main", ahead: 1, behind: 0, changes: [] };
    if (command === "git_push_target") return { branch: (args as { branch: string }).branch, remote: "origin", target: "main", tracked: true };
    if (command === "git_refs") return { branches: [], tags: [] };
    if (command === "git_log") return [{ hash: "abc", short: "abc", subject: "change", author: "Tester", authoredMs: 1, refs: "", parents: [] }];
    if (command === "git_stash_list" || command === "git_shelves") return [];
    return write(command, args);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("Git 操作生命周期", () => {
  it("实时进度按阶段更新，无百分比恢复不定进度，迟到消息不能覆盖新任务", async () => {
    const first = deferred<string>(); const second = deferred<string>();
    write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render(); let task!: Promise<string | null>;
    await act(async () => { task = state.fetch(); });
    const channel = write.mock.calls[0][1].onOutput as { onmessage: (line: string) => void };
    await act(async () => { channel.onmessage("Receiving objects: 100% (10/10)"); });
    expect(state.operation).toMatchObject({ message: "Receiving objects: 100% (10/10)", fraction: 1 });
    await act(async () => { channel.onmessage("Resolving deltas: 5% (1/20)"); });
    expect(state.operation?.fraction).toBe(0.05);
    await act(async () => { channel.onmessage("Updating refs"); });
    expect(state.operation?.fraction).toBeUndefined();
    await act(async () => { first.resolve("done"); await task; });
    await act(async () => { task = state.fetch(); });
    await act(async () => { channel.onmessage("old task: 80%"); });
    expect(state.operation?.message).toBeUndefined();
    await act(async () => { second.resolve("done"); await task; });
  });
  it("推送冻结源分支和目标，拒绝后更新成功才按原选项重推", async () => {
    write.mockRejectedValueOnce(new Error("[rejected] main -> main (fetch first)")).mockResolvedValue("done");
    await render();
    await act(async () => { expect(await state.push({ tags: "currentBranch" })).toBeNull(); });
    const notice = vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0];
    expect(notice.actions).toHaveLength(3);
    expect(write).toHaveBeenCalledWith("git_push", { root: "D:\\repo", onOutput: expect.anything(), options: {
      branch: "main", remote: "origin", target: "main", tags: "currentBranch",
    } });
    await act(async () => { notice.actions![2]!.run(); });
    expect(write.mock.calls.map(([command]) => command)).toEqual(["git_push", "git_pull", "git_push"]);
    expect(write.mock.calls[1]).toEqual(["git_pull", { root: "D:\\repo", method: "rebase", onOutput: expect.anything() }]);
    expect(write.mock.calls[2][1].options).toEqual(write.mock.calls[0][1].options);
    expect(state.operation).toMatchObject({ kind: "push", phase: "success" });
    expect(beforeUpdate).toHaveBeenCalledTimes(1);
  });
  it("自动恢复只更新一次并采用保存的策略，再次拒绝交还用户处理", async () => {
    workflow = { beforeUpdate, autoUpdateOnPushRejected: true, updateMethod: "rebase" };
    write.mockRejectedValueOnce(new Error("non-fast-forward"))
      .mockResolvedValueOnce("updated").mockRejectedValueOnce(new Error("non-fast-forward"));
    await render();
    await act(async () => { expect(await state.push()).toBeNull(); });
    expect(beforeUpdate).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.map(([command]) => command)).toEqual(["git_push", "git_pull", "git_push"]);
    expect(write.mock.calls[1][1].method).toBe("rebase");
    expect(vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0].actions).toHaveLength(3);
  });
  it("保存未完成时不拉取，保存失败保留错误并停止重推", async () => {
    write.mockRejectedValueOnce(new Error("non-fast-forward"));
    const save = deferred<void>(); beforeUpdate.mockReturnValueOnce(save.promise);
    await render();
    await act(async () => { await state.push(); });
    const notice = vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0];
    await act(async () => { notice.actions![1]!.run(); });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => { save.reject(new Error("save failed")); });
    expect(write).toHaveBeenCalledTimes(1);
    expect(state.operation?.phase).toBe("error");
    expect(vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0].content).toContain("save failed");
  });
  it("更新冲突后不继续推送，并刷新仓库恢复状态", async () => {
    write.mockRejectedValueOnce(new Error("non-fast-forward")).mockRejectedValueOnce(new Error("CONFLICT"));
    await render();
    await act(async () => { await state.push(); });
    const notice = vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0];
    await act(async () => { notice.actions![1]!.run(); });
    expect(write.mock.calls.map(([command]) => command)).toEqual(["git_push", "git_pull"]);
    expect(state.operation?.phase).toBe("error");
    expect(vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0].actions).toBeUndefined();
  });
  it.each([{ forceWithLease: true }, { target: "review" }, { branch: "other" }, { revision: "abc" }])("%j 不提供错误分支上的更新动作", async (options) => {
    write.mockRejectedValue(new Error("non-fast-forward"));
    await render();
    await act(async () => { await state.push(options); });
    expect(vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0].actions).toHaveLength(1);
  });
  it("切换工程或分支后，旧推送通知不能拉取新工程或新分支", async () => {
    write.mockRejectedValue(new Error("non-fast-forward"));
    await render();
    await act(async () => { await state.push(); });
    const notice = vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0];
    await render("D:/other");
    await act(async () => { notice.actions![1]!.run(); });
    expect(write).toHaveBeenCalledTimes(1);
    await render();
    vi.mocked(invoke).mockImplementation(async (command) => command === "git_status" ? { branch: "other", detached: false } : { branch: "main", remote: "origin", target: "main", tracked: true });
    await act(async () => { notice.actions![1]!.run(); });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("旧工程后台推送失败不把错误通知写入新工程", async () => {
    const pending = deferred<string>(); write.mockReturnValue(pending.promise);
    await render(); let task!: Promise<string | null>;
    await act(async () => { task = state.push(); });
    await render("D:/other");
    await act(async () => { pending.reject(new Error("non-fast-forward")); await task; });
    expect(notificationCenter.notify).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
  it("抓取从发起到刷新完成持续运行，连续点击以及交叉推送只发出一条请求", async () => {
    const pending = deferred<string>(); write.mockReturnValue(pending.promise);
    await render();
    let first!: Promise<string | null>;
    let duplicate!: Promise<string | null>;
    let push!: Promise<string | null>;
    await act(async () => { first = state.fetch(); duplicate = state.fetch(); push = state.push(); });
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
    expect(state.backgroundOperations.filter((task) => task.phase === "running").map((task) => task.root)).toEqual(["D:\\repo", "D:\\other"]);
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
    expect(vi.mocked(notificationCenter.notify).mock.calls.at(-1)![0]).toMatchObject({ level: "error", content: "rejected" });
  });
  it("两个工程并行运行时，切回旧工程仍能恢复它自己的忙碌状态", async () => {
    const firstTask = deferred<string>(); const secondTask = deferred<string>();
    write.mockReturnValueOnce(firstTask.promise).mockReturnValueOnce(secondTask.promise);
    await render(); let first!: Promise<string | null>; let second!: Promise<string | null>;
    await act(async () => { first = state.push(); });
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
