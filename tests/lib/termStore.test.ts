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

const { pendingListens, invokes } = vi.hoisted(() => ({
  /** 每次 listen 调用挂起一个 promise：测试手动 resolve，模拟 IPC 往返时长。 */
  pendingListens: [] as { resolve: (off: unknown) => void; off: unknown }[],
  /** invoke 的调用记录：term_open 要按次序发 id。 */
  invokes: [] as { cmd: string; args: Record<string, unknown> }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokes.push({ cmd, args: args ?? {} });
    if (cmd === "term_open") return `term-${invokes.filter((call) => call.cmd === "term_open").length}`;
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => {
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
  vi.resetModules();
});

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

  it("同一个根上同时要会话时只开一个 shell", async () => {
    const store = await import("../../src/lib/termStore");
    const first = store.needTermSession("D:/repo-a", "cmd", 80, 24);
    const second = store.needTermSession("D:/repo-a", "cmd", 80, 24);
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(invokes.filter((call) => call.cmd === "term_open")).toHaveLength(1);
  });
});
