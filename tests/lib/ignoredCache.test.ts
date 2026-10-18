import { beforeEach, expect, it, vi } from "vitest";

// 先挂 mock 再动态导入被测模块：断言与实现都不依赖 Tauri 运行时。
vi.mock("../../src/lib/git", () => ({
  gitIgnored: vi.fn(() => Promise.resolve(["node_modules/"])),
}));

async function loadModule() {
  return import("../../src/lib/ignoredCache");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  // 浏览器模块用 window.setTimeout；node 测试环境里把 window 桩到全局，定时器仍被 fake 接管。
  vi.stubGlobal("window", globalThis);
});

it("风暴期间的多次请求合并成一趟扫描", async () => {
  const { loadIgnored } = await loadModule();
  const { gitIgnored } = await import("../../src/lib/git");
  const p1 = loadIgnored("D:/repo/x");
  const p2 = loadIgnored("D:/repo\\x"); // 大小写与分隔符写法归同一键
  await vi.advanceTimersByTimeAsync(900);
  const [a, b] = await Promise.all([p1, p2]);
  expect(a).toEqual(["node_modules/"]);
  expect(b).toEqual(a);
  expect(vi.mocked(gitIgnored)).toHaveBeenCalledTimes(1);
});

it("扫描在飞期间作废：旧名单不入库，落定后立刻补扫一趟", async () => {
  const { invalidateIgnored, loadIgnored } = await loadModule();
  const { gitIgnored } = await import("../../src/lib/git");
  const root = "D:/repo/inflight";

  let release!: (list: string[]) => void;
  const pending = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  vi.mocked(gitIgnored).mockImplementationOnce(() => pending);

  const first = loadIgnored(root);
  await vi.advanceTimersByTimeAsync(900); // 防抖到点，进程起来，卡在 inFlight
  invalidateIgnored(root); // .gitignore 就改在这趟还在飞的时候
  release(["stale/"]);
  await first; // 调用方这一趟仍拿到一份结果，不空手

  await vi.advanceTimersByTimeAsync(900); // 作废触发的补扫
  await expect(loadIgnored(root)).resolves.toEqual(["node_modules/"]);
  expect(vi.mocked(gitIgnored)).toHaveBeenCalledTimes(2);
  // 旧名单没被当成新鲜结果：只扫过两趟，第二趟才是改完之后的规则。
});

it("新鲜期内复用缓存，不再起进程", async () => {
  const { loadIgnored } = await loadModule();
  const { gitIgnored } = await import("../../src/lib/git");
  const first = loadIgnored("D:/repo/y");
  await vi.advanceTimersByTimeAsync(900);
  await first;
  const again = await loadIgnored("D:/repo/y");
  expect(again).toEqual(["node_modules/"]);
  expect(vi.mocked(gitIgnored)).toHaveBeenCalledTimes(1);
});

it("规则文件变动显式作废后重扫，并广播给订阅者", async () => {
  const { invalidateIgnored, loadIgnored, subscribeIgnored } = await loadModule();
  const { gitIgnored } = await import("../../src/lib/git");
  const root = "D:/repo/z";
  const first = loadIgnored(root);
  await vi.advanceTimersByTimeAsync(900);
  await first;
  expect(vi.mocked(gitIgnored)).toHaveBeenCalledTimes(1);

  vi.mocked(gitIgnored).mockResolvedValueOnce(["dist/"]);
  const seen: string[][] = [];
  const unsubscribe = subscribeIgnored(root, (list) => seen.push(list));
  invalidateIgnored(root);
  await vi.advanceTimersByTimeAsync(900);
  await expect(loadIgnored(root)).resolves.toEqual(["dist/"]);
  expect(vi.mocked(gitIgnored)).toHaveBeenCalledTimes(2);
  expect(seen).toEqual([["dist/"]]);
  unsubscribe();
});
