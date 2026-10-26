import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scan: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // 这个测试只验证 hook 是否登记工作区扫描；立即执行 effect，避免引入 DOM 测试环境。
    useEffect: (effect: () => void | (() => void)) => effect(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});

vi.mock("../../src/lib/maven", () => ({ mavenScan: h.scan }));

import { mavenIconVisible, useMavenDetection, useMavenProject } from "../../src/hooks/useMavenProject";

describe("Maven 侧边栏入口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    h.scan.mockReset();
    h.scan.mockResolvedValue({ artifactId: "demo" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("工作区加载后启动检测，并在发现 Maven 工程时显示入口", async () => {
    useMavenDetection("D:/work/demo");
    await vi.advanceTimersByTimeAsync(400);

    expect(h.scan).toHaveBeenCalledWith("D:/work/demo");
    expect(mavenIconVisible(useMavenProject(), "D:/work/demo")).toBe(true);
  });
});
