import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAutoUpdateFlow, reduceDownloadEvent, humanBytes } from "../../src/lib/updater";
import type { AutoUpdateHooks, DownloadReport } from "../../src/lib/updater";

/**
 * 更新的行为测试：进度折算是纯函数；自动更新流程跑真实的状态机，
 * 只 mock 四个边界（updater 插件、process 插件、getVersion、后端 IPC）。
 * 断言的是决策表：什么时候查、什么时候下、什么时候装、挂起标记怎么进出。
 * 通知文案依赖当前语言，断言只看条数、级别和版本号子串，不锁具体句子。
 *
 * 集中放在 tests/lib/，目录与 src/lib 镜像（团队约定的集中式测试布局）。
 */

const h = vi.hoisted(() => ({
  /** check() 的回报；null 表示没有新版。 */
  checkResult: { current: null as null | { version: string; body?: string } },
  /** 后端侧的挂起标记（update_pending_* 三条命令的假实现）。 */
  pending: { version: null as string | null, attempts: 0 },
  /** 当前应用版本（getVersion 的回报）。 */
  current: { value: "0.1.0" },
  /** 弹窗的回答；true=立即安装。 */
  promptAnswer: { value: true },
  calls: { check: 0, download: 0, install: 0, close: 0 },
  /** 流程发出来的通知，按顺序。 */
  notifies: [] as { level: string; title: string; content: string }[],
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => {
    h.calls.check += 1;
    if (!h.checkResult.current) return null;
    return {
      rid: 1,
      available: true,
      currentVersion: h.current.value,
      version: h.checkResult.current.version,
      body: h.checkResult.current.body ?? "",
      date: null,
      rawJson: "{}",
      download: vi.fn(async (onEvent?: (event: unknown) => void) => {
        h.calls.download += 1;
        onEvent?.({ event: "Started", data: { contentLength: 1024 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
        onEvent?.({ event: "Finished" });
      }),
      install: vi.fn(async () => {
        h.calls.install += 1;
      }),
      downloadAndInstall: vi.fn(),
      close: vi.fn(async () => {
        h.calls.close += 1;
      }),
    };
  }),
  Update: class MockUpdate {
    rid = 1;
    available = true;
    currentVersion = h.current.value;
    version = "";
    body = "";
    constructor(meta: { version: string; body?: string }) {
      this.version = meta.version;
      this.body = meta.body ?? "";
    }
    download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      h.calls.download += 1;
      onEvent?.({ event: "Started", data: { contentLength: 1024 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
      onEvent?.({ event: "Finished" });
    });
    install = vi.fn(async () => {
      h.calls.install += 1;
    });
    downloadAndInstall = vi.fn();
    close = vi.fn(async () => {
      h.calls.close += 1;
    });
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => h.current.value),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { version?: string; attempts?: number; proxyUrl?: string | null }) => {
    switch (command) {
      case "update_pending_load":
        return h.pending.version ? { version: h.pending.version, attempts: h.pending.attempts } : null;
      case "update_pending_save":
        h.pending.version = args?.version ?? null;
        h.pending.attempts = args?.attempts ?? 0;
        return null;
      case "update_pending_clear":
        h.pending.version = null;
        h.pending.attempts = 0;
        return null;
      case "update_check":
        h.calls.check += 1;
        if (!h.checkResult.current) return null;
        return {
          rid: 1,
          currentVersion: h.current.value,
          version: h.checkResult.current.version,
          body: h.checkResult.current.body ?? "",
          rawJson: {},
        };
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  }),
}));

function makeHooks(): AutoUpdateHooks {
  return {
    onPromptInstall: vi.fn(async () => h.promptAnswer.value),
    notify: (level, title, content) => h.notifies.push({ level, title, content }),
  };
}

const PREFS = (
  autoDownload: boolean,
  autoPromptInstall: boolean,
  proxyEnabled = false,
  proxyUrl = "https://gh-proxy.com/"
) => ({
  autoDownload,
  autoPromptInstall,
  proxyEnabled,
  proxyUrl,
});

beforeEach(() => {
  h.checkResult.current = null;
  h.pending.version = null;
  h.pending.attempts = 0;
  h.current.value = "0.1.0";
  h.promptAnswer.value = true;
  h.calls = { check: 0, download: 0, install: 0, close: 0 };
  h.notifies = [];
});

describe("runAutoUpdateFlow 决策表", () => {
  it("没开自动下载、没有挂起：只等手动，连检查都不发", async () => {
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.check).toBe(0);
    expect(h.calls.download).toBe(0);
    expect(h.pending.version).toBeNull();
  });

  it("开了自动下载但没有新版：查一次，到此为止", async () => {
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.check).toBe(1);
    expect(h.calls.download).toBe(0);
  });

  it("自动下载 + 下载完询问 + 答是：下载、装、清标记、报已就绪", async () => {
    h.checkResult.current = { version: "0.2.0" };
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.download).toBe(1);
    expect(h.calls.install).toBe(1);
    expect(h.pending.version).toBeNull();
    const done = h.notifies[h.notifies.length - 1];
    expect(done.level).toBe("info");
    expect(done.content).toContain("0.2.0");
  });

  it("自动下载 + 下载完询问 + 答否：不装，释放 Update 句柄，落挂起标记，说下次启动装", async () => {
    h.checkResult.current = { version: "0.2.0" };
    h.promptAnswer.value = false;
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.install).toBe(0);
    expect(h.calls.close).toBe(1);
    expect(h.pending.version).toBe("0.2.0");
    const done = h.notifies[h.notifies.length - 1];
    expect(done.level).toBe("info");
    expect(done.content).toContain("0.2.0");
  });

  it("自动下载 + 不询问：就绪提示并落标记，不强杀进程", async () => {
    h.checkResult.current = { version: "0.2.0" };
    await runAutoUpdateFlow(PREFS(true, false), makeHooks());
    expect(h.calls.download).toBe(1);
    expect(h.pending.version).toBe("0.2.0");
    const done = h.notifies[h.notifies.length - 1];
    expect(done.level).toBe("info");
    expect(done.content).toContain("0.2.0");
  });

  it("挂起标记已尝试安装过（attempts >= 1）但仍未成功：清空标记防死循环，不再次静默强行拉起安装器", async () => {
    h.pending.version = "0.2.0";
    h.pending.attempts = 1;
    h.current.value = "0.1.0";
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.download).toBe(0);
    expect(h.calls.install).toBe(0);
    expect(h.pending.version).toBeNull();
  });

  it("有挂起标记且版本不同：静默补装并清标记，不问弹窗", async () => {
    h.pending.version = "0.2.0";
    h.checkResult.current = { version: "0.3.0" };
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.check).toBe(1);
    expect(h.calls.download).toBe(1);
    expect(h.calls.install).toBe(1);
    expect(h.pending.version).toBeNull();
  });

  it("挂起版本与当前一致：上次其实装完了（Windows 由安装器重启），只清标记", async () => {
    h.pending.version = "0.2.0";
    h.current.value = "0.2.0";
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.check).toBe(0);
    expect(h.calls.download).toBe(0);
    expect(h.pending.version).toBeNull();
  });

  it("挂起标记在但 Release 撤了：标记作废，不装", async () => {
    h.pending.version = "0.2.0";
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.install).toBe(0);
    expect(h.pending.version).toBeNull();
  });
});

describe("reduceDownloadEvent", () => {
  const START = { event: "Started", data: { contentLength: 1024 * 1024 } } as const;
  const CHUNK = (n: number) => ({ event: "Progress", data: { chunkLength: n } } as const);
  const DONE = { event: "Finished" } as const;

  it("Started 记下总长并清零，Progress 累加 chunk", () => {
    let report = reduceDownloadEvent({ received: 999, total: null }, START);
    expect(report).toEqual({ received: 0, total: 1024 * 1024 });
    report = reduceDownloadEvent(report, CHUNK(300));
    expect(report).toEqual({ received: 300, total: 1024 * 1024 });
    report = reduceDownloadEvent(report, CHUNK(24));
    expect(report.received).toBe(324);
  });

  it("Started 没给 contentLength 时 total 为 null，后续照常累加", () => {
    let report = reduceDownloadEvent(
      { received: 0, total: null },
      { event: "Started", data: {} }
    );
    expect(report).toEqual({ received: 0, total: null });
    report = reduceDownloadEvent(report, CHUNK(512));
    expect(report).toEqual({ received: 512, total: null });
  });

  it("Finished 不改数", () => {
    const report = { received: 1024, total: 1024 };
    expect(reduceDownloadEvent(report, DONE)).toBe(report);
  });
});

describe("humanBytes", () => {
  it("口径与 errors.ts 一致：MB 一位小数，KB 取整", () => {
    expect(humanBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(humanBytes(2048)).toBe("2 KB");
    expect(humanBytes(512)).toBe("512 B");
  });
});

/** 供类型对账：DownloadReport 形状没变。 */
const _shape: DownloadReport = { received: 0, total: null };
void _shape;
