import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 终端回放历史的容量测试。
 *
 * 历史是「每条会话一份」的原始字节，多项目常驻时会话数一多，单条 8MB 的封顶会变成
 * 8MB × 会话数。这里验证合计预算：超出时各条轮转丢最老的块，而不是把某一条整个清空。
 *
 * `listen` 的 mock 把 handler 记下来，测试直接往里面灌输出，走真实的 deliver → pushHistory 路径。
 */

const { handlers, invokes } = vi.hoisted(() => ({
  /** 事件名 → 注册过的全部 handler（每条会话各注册一对）。 */
  handlers: new Map<string, ((event: { payload: unknown }) => void)[]>(),
  invokes: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    invokes.push(cmd);
    if (cmd === "term_open") return `term-${invokes.filter((c) => c === "term_open").length}`;
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return Promise.resolve(() => {
      const held = handlers.get(name) ?? [];
      const at = held.indexOf(handler);
      if (at >= 0) held.splice(at, 1);
    });
  }),
}));

/** 一段 base64，解码后正好 `size` 个字节。 */
function payload(size: number): string {
  const raw = new Uint8Array(size).fill(0x61);
  let binary = "";
  for (let index = 0; index < raw.length; index += 1) binary += String.fromCharCode(raw[index]);
  return btoa(binary);
}

/** 往指定会话灌一块输出，走的是真实的事件处理路径。 */
function feed(id: string, size: number): void {
  const listeners = handlers.get("term://output") ?? [];
  const data = payload(size);
  // 每条会话各注册一个监听，靠 payload.id 自己认领。
  for (const handler of listeners) handler({ payload: { id, data } });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}

const MB = 1_000_000;

beforeEach(() => {
  handlers.clear();
  invokes.length = 0;
  vi.resetModules();
});

describe("终端回放历史", () => {
  it("单条会话超过 8MB 时丢最老的块，保留最近一段", async () => {
    const store = await import("../../src/lib/termStore");
    const one = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    await flush();

    for (let index = 0; index < 12; index += 1) feed(one.id, MB);

    expect(store.termHistoryBytes()).toBeLessThanOrEqual(8 * MB);
    // 还留着东西可重放，而不是整条被清空。
    const replayed: number[] = [];
    store.attachTermOutput(one.id, (data) => replayed.push(data.byteLength));
    expect(replayed.length).toBeGreaterThan(0);
  });

  it("多条会话合计超出预算时轮转丢块，每条都还留着一部分", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    const b = await store.openTerm("D:/repo-b", "cmd", 80, 24);
    const c = await store.openTerm("D:/repo-c", "cmd", 80, 24);
    await flush();

    // 每条灌 10MB：单条都没到 8MB 上限的边界之外，合计却远超 24MB 预算。
    for (let index = 0; index < 10; index += 1) {
      feed(a.id, MB);
      feed(b.id, MB);
      feed(c.id, MB);
    }

    expect(store.termHistoryBytes()).toBeLessThanOrEqual(24 * MB);

    // 每条都还能重放出内容：切回任何一个工程时那一屏都还在。
    for (const session of [a, b, c]) {
      const replayed: number[] = [];
      store.attachTermOutput(session.id, (data) => replayed.push(data.byteLength));
      expect(replayed.length).toBeGreaterThan(0);
    }
  });

  it("关掉一条会话后它的历史不再计入合计", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    await flush();
    for (let index = 0; index < 4; index += 1) feed(a.id, MB);
    expect(store.termHistoryBytes()).toBeGreaterThan(0);

    await store.closeTerm(a.id);
    await flush();
    expect(store.termHistoryBytes()).toBe(0);
  });

  it("清屏之后合计跟着归零", async () => {
    const store = await import("../../src/lib/termStore");
    const a = await store.openTerm("D:/repo-a", "cmd", 80, 24);
    await flush();
    for (let index = 0; index < 3; index += 1) feed(a.id, MB);

    store.clearTermHistory(a.id);
    expect(store.termHistoryBytes()).toBe(0);
  });
});
