import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * termStore 的监听生命周期测试。
 *
 * `listen` 要一次 IPC 往返才 resolve；「起会话 → 立刻关掉」落在往返窗口里时，
 * resolve 回来的 unlisten 必须当场被调（closed 哨兵），否则监听器永远解不绑，
 * 之后每条 term://output 都还会走进它的闭包。修复前正是这个泄漏。
 *
 * 集中放在 tests/lib/，目录与 src/lib 镜像（团队约定的集中式测试布局）。
 * 模块级状态（sessions / closed）跨测试会串，每个用例用 vi.resetModules +
 * 动态 import 拿一份全新的 store。
 */

const { pendingListens, invokes, handlers, layout } = vi.hoisted(() => ({
  /** `term_layout_load` 返回的内容；测试里按需填。 */
  layout: { value: null as unknown },
  /** 每次 listen 调用挂起一个 promise：测试手动 resolve，模拟 IPC 往返时长。 */
  pendingListens: [] as { resolve: (off: unknown) => void; off: unknown }[],
  /** 按事件名记下监听回调，测试借它模拟后端发事件。 */
  handlers: [] as { name: string; callback: (event: { payload: unknown }) => void }[],
  /** invoke 的调用记录：term_open 要按次序发 id。 */
  invokes: [] as { cmd: string; args: Record<string, unknown> }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokes.push({ cmd, args: args ?? {} });
    if (cmd === "term_open") return `term-${invokes.filter((call) => call.cmd === "term_open").length}`;
    if (cmd === "term_layout_load") return layout.value;
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    handlers.push({ name, callback });
    const off = vi.fn();
    return new Promise<unknown>((resolve) => {
      pendingListens.push({ resolve, off });
    });
  }),
}));

/** 解掉所有挂着的 listen，模拟 IPC 往返完成。 */
function settleListens(): void {
  const hanging = pendingListens.splice(0);
  for (const { resolve, off } of hanging) resolve(off);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}

beforeEach(() => {
  pendingListens.length = 0;
  invokes.length = 0;
  handlers.length = 0;
  layout.value = null;
  vi.resetModules();
});

function emitOutput(id: string, text = "hi") {
  for (const handler of handlers.filter((entry) => entry.name === "term://output")) {
    handler.callback({ payload: { id, data: btoa(text) } });
  }
}

describe("termStore 监听生命周期", () => {
  it("起会话后立刻关掉：listen 往返途中关闭，resolve 时监听当场解绑", async () => {
    const store = await import("../../src/lib/termStore");
    const created = await store.openTerm(null, "cmd", 80, 24);
    // 两个订阅（output / exit）此刻都还挂在往返途中，off 一个都没 resolve 回来。
    expect(pendingListens).toHaveLength(2);

    // 先关会话（closed 登记发生在这里），往返这时才完成。
    await store.closeTerm(created.id);
    const offs = pendingListens.map((entry) => entry.off);
    settleListens();
    await flush();

    expect(offs).toHaveLength(2);
    for (const off of offs) {
      expect(off).toHaveBeenCalledTimes(1);
    }
    expect(invokes.some((call) => call.cmd === "term_close")).toBe(true);
  });

  it("正常路径：往返完成后关闭会话，unlisten 全部被调", async () => {
    const store = await import("../../src/lib/termStore");
    const created = await store.openTerm(null, "cmd", 80, 24);
    const offs = pendingListens.map((entry) => entry.off);
    expect(offs).toHaveLength(2);

    settleListens();
    await flush();
    await store.closeTerm(created.id);
    await flush();

    for (const off of offs) {
      expect(off).toHaveBeenCalledTimes(1);
    }
  });

  it("dropTermSession 同样先登记再解绑：往返中的订阅 resolve 时当场解绑", async () => {
    const store = await import("../../src/lib/termStore");
    await store.openTerm(null, "cmd", 80, 24);
    const offs = pendingListens.map((entry) => entry.off);

    await store.dropTermSession();
    settleListens();
    await flush();

    for (const off of offs) {
      expect(off).toHaveBeenCalledTimes(1);
    }
  });

  it("多工作区按根隔离终端列表与激活项，关闭单根不影响后台根的终端", async () => {
    const store = await import("../../src/lib/termStore");
    const a1 = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const a2 = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b1 = await store.openTerm("D:/repo-b", "cmd", 80, 24);
    settleListens();
    await flush();

    // 各自根只看得到自己 cwd 下的终端
    expect(store.termSessionsFor("D:/repo-a").sessions.map((s) => s.id)).toEqual([a1.id, a2.id]);
    expect(store.termSessionsFor("D:/repo-a").activeId).toBe(a2.id);
    expect(store.termSessionsFor("D:/repo-b").sessions.map((s) => s.id)).toEqual([b1.id]);
    expect(store.termSessionsFor("D:/repo-b").activeId).toBe(b1.id);

    // 在 A 根把激活终端切回 a1，不影响 B 根的激活终端 b1
    store.setActiveTermFor("D:/repo-a", a1.id);
    expect(store.termSessionFor("D:/repo-a")?.id).toBe(a1.id);
    expect(store.termSessionFor("D:/repo-b")?.id).toBe(b1.id);
    expect(store.hasAliveTermsForRoot("D:/repo-a")).toBe(true);
    expect(store.hasAliveTermsForRoot("D:/repo-b")).toBe(true);

    // 关闭 A 根：只销毁 A 根下的 a1、a2，B 根的 b1 必须继续活着
    await store.closeTermsForRoot("D:/repo-a");
    await flush();
    expect(store.termSessionsFor("D:/repo-a").sessions).toHaveLength(0);
    expect(store.hasAliveTermsForRoot("D:/repo-a")).toBe(false);
    expect(store.termSessionsFor("D:/repo-b").sessions.map((s) => s.id)).toEqual([b1.id]);
    expect(store.hasAliveTermsForRoot("D:/repo-b")).toBe(true);
  });

  it("shell 以 0 退出时收掉页签，非零退出留着并记下退出码", async () => {
    const store = await import("../../src/lib/termStore");
    const ok = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const failed = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const exit = (id: string, code: number | null) => {
      for (const handler of handlers.filter((entry) => entry.name === "term://exit")) {
        handler.callback({ payload: { id, code } });
      }
    };

    exit(ok.id, 0);
    exit(failed.id, 2);
    await flush();

    const left = store.termSessionsFor("D:/repo-a").sessions;
    expect(left.map((session) => session.id)).toEqual([failed.id]);
    expect(left[0]).toMatchObject({ exited: true, exitCode: 2 });
  });

  it("固定的排最前，拖拽只在同组里挪", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const c = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const order = () => store.termSessionsFor("D:/repo-a").sessions.map((s) => s.id);

    store.toggleTermPin(c.id);
    expect(order()).toEqual([c.id, a.id, b.id]);

    store.moveTerm(b.id, a.id, false);
    expect(order()).toEqual([c.id, b.id, a.id]);

    // 普通页签不能拖进固定组。
    store.moveTerm(a.id, c.id, false);
    expect(order()).toEqual([c.id, b.id, a.id]);
  });

  it("关闭其他、关闭右侧、全部关闭都跳过固定的", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const c = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const d = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const ids = () => store.termSessionsFor("D:/repo-a").sessions.map((s) => s.id);
    store.toggleTermPin(a.id);

    await store.closeTermsToRight(c.id);
    expect(ids()).toEqual([a.id, b.id, c.id]);

    await store.closeOtherTerms(c.id);
    expect(ids()).toEqual([a.id, c.id]);

    await store.closeUnpinnedTerms("D:/repo-a");
    expect(ids()).toEqual([a.id]);
    expect(d.id).not.toBe(a.id);
  });

  it("后台页签来了输出才标未读，切过去清掉", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const output = (id: string) => {
      for (const handler of handlers.filter((entry) => entry.name === "term://output")) {
        handler.callback({ payload: { id, data: btoa("hi") } });
      }
    };

    output(b.id);
    expect(store.termSessionById(b.id)?.unread).toBe(false);
    output(a.id);
    expect(store.termSessionById(a.id)?.unread).toBe(true);

    store.setActiveTermFor("D:/repo-a", a.id);
    expect(store.termSessionById(a.id)?.unread).toBe(false);
  });

  it("重开会话留在原位，名字和固定状态跟过去", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b = await store.openTerm("D:/repo-a", "pwsh", 80, 24);
    const c = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    store.renameTerm(b.id, "  server  ");

    const fresh = await store.restartTerm(b.id);
    const list = store.termSessionsFor("D:/repo-a").sessions;
    expect(list.map((s) => s.id)).toEqual([a.id, fresh?.id, c.id]);
    expect(fresh).toMatchObject({ shell: "pwsh", name: "server", exited: false });
    expect(store.termSessionsFor("D:/repo-a").activeId).toBe(fresh?.id);
  });

  it("拆分的会话和原来那条同组、紧挨着；关掉一条焦点留在组里；取消拆分自成一组", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const ids = () => store.termSessionsFor("D:/repo-a").sessions.map((s) => s.id);

    const a2 = await store.splitTerm(a.id, "column", 80, 24);
    expect(ids()).toEqual([a.id, a2?.id, b.id]);
    expect(store.termGroupOf(a.id)).toMatchObject({ direction: "column" });
    expect(store.termGroupOf(a.id).members.map((s) => s.id)).toEqual([a.id, a2?.id]);

    // 整组一起拖。
    store.moveTerm(a.id, b.id, true);
    expect(ids()).toEqual([b.id, a.id, a2?.id]);

    store.setActiveTermFor("D:/repo-a", a2!.id);
    await store.closeTerm(a2!.id);
    expect(store.termSessionsFor("D:/repo-a").activeId).toBe(a.id);

    const a3 = await store.splitTerm(a.id, "row", 80, 24);
    store.unsplitTerm(a3!.id);
    expect(store.termGroupOf(a.id).members).toHaveLength(1);
    expect(ids()).toEqual([b.id, a.id, a3?.id]);
  });

  it("再开一个同样的落在 shell 现在所在的目录", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "pwsh", 80, 24);
    store.setTermCurrentDir(a.id, "D:/repo-a/src");
    await store.duplicateTerm(a.id, 80, 24);
    const opens = invokes.filter((call) => call.cmd === "term_open");
    expect(opens[1]?.args).toMatchObject({ cwd: "D:/repo-a/src", shell: "pwsh" });
    expect(store.termSessionsFor("D:/repo-a").sessions[1]).toMatchObject({ cwd: "D:/repo-a", dir: "D:/repo-a/src" });
  });

  it("面板第一次要会话时按存盘的布局整组恢复", async () => {
    layout.value = {
      "d:/repo-a": {
        cwd: "D:/repo-a",
        tabs: [
          { shell: "cmd", dir: null, name: "build", pinned: true, group: 0, profile: null },
          { shell: "pwsh", dir: "D:/repo-a/web", name: null, pinned: false, group: 1, profile: null },
          { shell: "pwsh", dir: null, name: null, pinned: false, group: 1, profile: null },
        ],
        active: 1,
        directions: { "1": "column" },
      },
    };
    const store = await import("../../src/lib/termStore");
    const active = await store.needTermSession("D:/repo-a", "cmd", 80, 24);
    const list = store.termSessionsFor("D:/repo-a").sessions;
    expect(list.map((s) => [s.shell, s.name, s.pinned])).toEqual([
      ["cmd", "build", true],
      ["pwsh", null, false],
      ["pwsh", null, false],
    ]);
    expect(active.id).toBe(list[1].id);
    expect(store.termGroupOf(list[1].id).members).toHaveLength(2);
    expect(store.termGroupOf(list[1].id).direction).toBe("column");
    expect(invokes.filter((call) => call.cmd === "term_open")[1]?.args).toMatchObject({ cwd: "D:/repo-a/web" });

    // 全关掉之后再要，不会第二遍恢复。
    await store.closeUnpinnedTerms("D:/repo-a");
    await store.closeTerm(list[0].id);
    await store.needTermSession("D:/repo-a", "cmd", 80, 24);
    expect(store.termSessionsFor("D:/repo-a").sessions).toHaveLength(1);
  });

  it("启动命令等 shell 第一次有输出之后再敲", async () => {
    vi.useFakeTimers();
    try {
      const store = await import("../../src/lib/termStore");
      const a = await store.openTerm("D:/repo-a", "cmd", 80, 24, { command: "npm run dev" });
      const writes = () => invokes.filter((call) => call.cmd === "term_write");
      expect(writes()).toHaveLength(0);
      emitOutput(a.id);
      await vi.advanceTimersByTimeAsync(200);
      expect(writes().map((call) => call.args.data)).toEqual(["npm run dev\r"]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(writes()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一个根上同时要会话时只开一个 shell", async () => {
    const store = await import("../../src/lib/termStore");
    const first = store.needTermSession("D:/repo-a", "cmd", 80, 24);
    const second = store.needTermSession("D:/repo-a", "cmd", 80, 24);
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(invokes.filter((call) => call.cmd === "term_open")).toHaveLength(1);
  });
});
