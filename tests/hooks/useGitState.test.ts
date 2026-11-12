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
    if (command === "git_discover") return [(args as { path: string }).path];
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
  it("全部仓库同时读取，失败保留快照，嵌套仓库不作为父仓库未跟踪目录", async () => {
    /** 切换失败响应以模拟文件监听后的瞬时错误。 */
    let failWeb = false;
    /** 其它命令保持正常的 IPC 合约。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_discover") return ["D:/projects", "D:/projects/web"];
      if (command === "git_status") {
        /** 每次读取都按请求根返回独立变更。 */
        const repoRoot = (args as { root: string }).root;
        if (repoRoot.endsWith("web") && failWeb) throw new Error("read denied");
        return { branch: "main", changes: [{ path: repoRoot.endsWith("web") ? "README.md" : "web/", oldPath: null,
          indexStatus: " ", workStatus: "M", untracked: !repoRoot.endsWith("web"), conflicted: false }] };
      }
      return invokeDefault(command, args);
    });
    await render("D:/projects");
    expect(state.repositoryStates.map((repo) => repo.status?.changes.map((change) => change.path))).toEqual([[], ["README.md"]]);
    failWeb = true;
    await act(async () => state.refreshChanges());
    expect(state.repositoryStates[1]).toMatchObject({ error: "read denied", status: { changes: [{ path: "README.md" }] } });
    failWeb = false;
    await act(async () => state.refreshChanges());
    expect(state.repositoryStates[1]?.error).toBeNull();
  });
  it("后台仓库旧读取不能覆盖切换后的最新快照", async () => {
    /** 暂停第一次非活动仓库读取。 */
    const oldRead = deferred<unknown>();
    /** 只挂起一轮，其后切换到该仓库应取最新状态。 */
    let first = true;
    /** 保留其它命令默认行为。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_discover") return ["D:/projects/api", "D:/projects/web"];
      if (command === "git_status" && (args as { root: string }).root.endsWith("web") && first) {
        first = false;
        return oldRead.promise;
      }
      return invokeDefault(command, args);
    });
    await render("D:/projects");
    await act(async () => state.selectRepository("D:\\projects\\web"));
    expect(state.repositoryStates[1]?.status?.branch).toBe("main");
    await act(async () => oldRead.resolve({ branch: "outdated", changes: [] }));
    expect(state.repositoryStates[1]?.status?.branch).toBe("main");
  });
  it("提交检查锁阻止同根切分支、reset 和暂存，同时允许其它根写入", async () => {
    /** 用挂起动作表示提交前检查仍在运行。 */
    const check = deferred<string>();
    /** 保留其它命令默认行为。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => command === "git_discover"
      ? ["D:/projects/api", "D:/projects/web"] : invokeDefault(command, args));
    await render("D:/projects");
    /** 持锁的原提交任务。 */
    let task!: Promise<string | null>;
    await act(async () => { task = state.runRepository("D:\\projects\\api", () => check.promise); });
    await act(async () => {
      expect(await state.checkout("other")).toBe(false);
      expect(await state.reset("HEAD", "mixed")).toBe(false);
      expect(await state.stage(["README.md"])).toBe(false);
      expect(await state.runRepository("D:\\projects\\web", async () => "other done")).toBe("other done");
    });
    expect(write).not.toHaveBeenCalled();
    await act(async () => { check.resolve("committed"); await task; });
    await act(async () => { expect(await state.runRepository("D:\\projects\\api", async () => "retry")).toBe("retry"); });
  });
  it("写入非活动仓库期间切到该仓库，完成后刷新新活动状态", async () => {
    /** 后台写入完成前状态仍有旧变更。 */
    let committed = false;
    /** 控制写入结束时刻。 */
    const writeDone = deferred<void>();
    /** 保留其它命令默认行为。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_discover") return ["D:/projects/api", "D:/projects/web"];
      if (command === "git_status") return { branch: committed ? "fresh" : "old", changes: [] };
      return invokeDefault(command, args);
    });
    await render("D:/projects");
    /** 捕获开始时非活动仓库的写入任务。 */
    let task!: Promise<void | null>;
    await act(async () => { task = state.runRepository("D:\\projects\\web", async () => { await writeDone.promise; committed = true; }); });
    await act(async () => state.selectRepository("D:\\projects\\web"));
    expect(state.status?.branch).toBe("old");
    await act(async () => { writeDone.resolve(); await task; });
    expect(state.status?.branch).toBe("fresh");
    expect(state.repositoryStates[1]?.status?.branch).toBe("fresh");
  });
  it("索引写入尚未完成时禁止同根提交", async () => {
    /** 挂起已有暂存写入。 */
    const pending = deferred<string>();
    write.mockReturnValueOnce(pending.promise);
    await render();
    /** 已在执行的索引任务。 */
    let staging!: Promise<boolean>;
    /** 提交入口应在调用写动作之前拒绝。 */
    const commit = vi.fn(async () => "committed");
    await act(async () => { staging = state.stage(["README.md"]); });
    await act(async () => { expect(await state.runRepository(state.root!, commit)).toBeNull(); });
    expect(commit).not.toHaveBeenCalled();
    await act(async () => { pending.resolve("staged"); await staging; });
  });
  it("写入只允许已发现的仓库，旧工作区回调不能写入新工作区", async () => {
    await render();
    /** 保存旧工作区绑定的动作入口。 */
    const run = state.runRepository;
    /** 用调用计数验证未触达写入边界。 */
    const action = vi.fn(async () => "written");
    await act(async () => { expect(await run("D:\\outside", action)).toBeNull(); });
    await render("D:/other");
    await act(async () => { expect(await run("D:\\repo", action)).toBeNull(); });
    await render();
    await act(async () => { expect(await run("D:\\repo", action)).toBeNull(); });
    expect(action).not.toHaveBeenCalled();
  });
  it("工作区本身不是仓库时自动选择子目录仓库", async () => {
    /** 保留现有 IPC 行为，仅替换工作区探测与仓库发现的响应。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_discover") return ["D:/projects/api", "D:/projects/web"];
      if (command === "git_probe" && (args as { path: string }).path === "D:/projects") {
        return { ...probe("D:/projects"), repoRoot: null };
      }
      return invokeDefault(command, args);
    });
    await render("D:/projects");
    expect(state.root).toBe("D:\\projects\\api");
    expect(state.status?.branch).toBe("main");
    expect(invoke).toHaveBeenCalledWith("git_status", { root: "D:\\projects\\api" });
    expect(state.repositories).toEqual(["D:\\projects\\api", "D:\\projects\\web"]);
    await act(async () => state.selectRepository("D:\\projects\\web"));
    expect(state.root).toBe("D:\\projects\\web");
    await act(async () => state.stage(["README.md"]));
    expect(write).toHaveBeenCalledWith("git_stage", { root: "D:\\projects\\web", paths: ["README.md"] });
    await render("D:/other");
    await render("D:/projects");
    expect(state.root).toBe("D:\\projects\\web");
  });
  it("刷新保留所选仓库，仓库移出列表后退到剩余仓库，并拒绝外部路径", async () => {
    /** 模拟工作区仓库列表在刷新之间发生变化。 */
    let repositories = ["D:/projects/api", "D:/projects/web"];
    /** 其余 IPC 仍使用正常仓库响应。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => command === "git_discover" ? repositories : invokeDefault(command, args));
    await render("D:/projects");
    await act(async () => state.selectRepository("D:\\projects\\web"));
    await act(async () => state.refresh());
    expect(state.root).toBe("D:\\projects\\web");
    await act(async () => state.selectRepository("D:\\outside"));
    expect(state.root).toBe("D:\\projects\\web");
    repositories = ["D:/projects/api"];
    await act(async () => state.refresh());
    expect(state.root).toBe("D:\\projects\\api");
  });
  it("切换子仓库后丢弃旧仓库迟到的状态与通知", async () => {
    /** 用挂起的状态读取模拟旧仓库慢响应。 */
    const pendingStatus = deferred<unknown>();
    /** 用挂起的网络操作验证按仓库隔离的后台状态。 */
    const pendingFetch = deferred<string>();
    /** 其余 IPC 复用默认响应。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_discover") return ["D:/projects/api", "D:/projects/web"];
      if (command === "git_status" && (args as { root: string }).root === "D:\\projects\\api") return pendingStatus.promise;
      return invokeDefault(command, args);
    });
    await render("D:/projects");
    await act(async () => state.selectRepository("D:\\projects\\web"));
    await act(async () => { pendingStatus.resolve({ branch: "old", changes: [] }); });
    expect(state.root).toBe("D:\\projects\\web");
    expect(state.status?.branch).toBe("main");
    write.mockReturnValueOnce(pendingFetch.promise);
    /** 运行中的请求保持来源仓库。 */
    let task!: Promise<string | null>;
    await act(async () => { task = state.fetch(); });
    await act(async () => state.selectRepository("D:\\projects\\api"));
    await act(async () => { pendingFetch.resolve("done"); await task; });
    expect(state.root).toBe("D:\\projects\\api");
    expect(state.status?.branch).toBe("old");
    expect(notificationCenter.notify).not.toHaveBeenCalled();
  });
  it("旧工作区的迟到扫描不能覆盖当前仓库，空工作区保留初始化入口", async () => {
    /** 挂起第一轮扫描以覆盖跨工作区的发现竞态。 */
    const pending = deferred<string[]>();
    /** 保留其他 IPC 的默认响应。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_discover" && (args as { path: string }).path === "D:/slow") return pending.promise;
      if (command === "git_discover" && (args as { path: string }).path === "D:/empty") return [];
      if (command === "git_probe" && (args as { path: string }).path === "D:/empty") return { ...probe(""), repoRoot: null };
      return invokeDefault(command, args);
    });
    await render("D:/slow");
    await render("D:/other");
    await act(async () => { pending.resolve(["D:/slow/api"]); });
    expect(state.root).toBe("D:\\other");
    expect(state.repositories).toEqual(["D:\\other"]);
    await render("D:/empty");
    expect(state.root).toBeNull();
    expect(state.repositories).toEqual([]);
    expect(state.probe?.available).toBe(true);
    await act(async () => { await state.init(); });
    expect(write).toHaveBeenCalledWith("git_init", { root: "D:/empty" });
  });
  it("扫描失败报告错误，重试成功后可恢复仓库", async () => {
    /** 首次扫描失败，其余命令保持正常。 */
    const invokeDefault = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockRejectedValueOnce(new Error("scan denied"));
    await render();
    expect(reportError).toHaveBeenCalledWith("scan denied");
    expect(state.root).toBeNull();
    vi.mocked(invoke).mockImplementation(invokeDefault);
    await act(async () => state.refresh());
    expect(state.root).toBe("D:\\repo");
  });
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
