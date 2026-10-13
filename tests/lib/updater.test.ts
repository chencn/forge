import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installReadyUpdate,
  runAutoUpdateFlow,
  reduceDownloadEvent,
  humanBytes,
} from "../../src/lib/updater";
import type { AutoUpdateHooks, DownloadReport } from "../../src/lib/updater";

/**
 * 更新的行为测试：进度折算是纯函数；自动更新流程跑真实的状态机，
 * 只 mock 四个边界（updater 插件、process 插件、getVersion、后端 IPC）。
 * 断言的是决策表：什么时候查、什么时候下、什么时候装、挂起标记与本地缓存怎么进出。
 * 通知文案依赖当前语言，断言只看条数、级别和版本号子串，不锁具体句子。
 *
 * 安装包落在后端缓存目录里，所以「这一版下过没有」是盘上的事实，不是内存里的标记：
 * 下面 h.cache 就是那份盘，h.rids 就是后端资源表——句柄关掉之后再拿它装包要报错，
 * 装哪一版也只按 rid 查，跟 Rust 侧一样。
 *
 * 集中放在 tests/lib/，目录与 src/lib 镜像（团队约定的集中式测试布局）。
 */

const h = vi.hoisted(() => ({
  /** check() 的回报；null 表示没有新版。 */
  checkResult: { current: null as null | { version: string; body?: string } },
  /** 后端侧的挂起标记（update_pending_* 三条命令的假实现）。 */
  pending: { version: null as string | null, attempts: 0 },
  /** 后端缓存目录：里面只有这一版的安装包时才算「下过」。 */
  cache: { version: null as string | null },
  /** 后端资源表：rid → 那一版的版本号。 */
  rids: new Map<number, string>(),
  /** 下一个 rid。 */
  nextRid: { value: 10 },
  /** 当前应用版本（getVersion 的回报）。 */
  current: { value: "0.1.0" },
  /** 弹窗的回答；true=立即安装。 */
  promptAnswer: { value: true },
  calls: { check: 0, download: 0, install: 0, close: 0, cacheRemove: 0 },
  /** 流程发出来的通知，按顺序。 */
  notifies: [] as { level: string; title: string; content: string }[],
}));

/** 按 rid 取那一版；句柄已释放或从来不是更新句柄时按后端的样子的报错。 */
function versionOfRid(rid: unknown): string {
  const version = typeof rid === "number" ? h.rids.get(rid) : undefined;
  if (!version) throw new Error("UPDATE_RID\u0001resource not found");
  return version;
}

/**
 * `new Update(meta)` 是 updater.ts 里唯一还会碰到插件类的地方：桩替它把 rid 登记进
 * 后端资源表，并把 close 折成 calls.close。插件自带的下载/安装三个方法一律炸——
 * 装包只认自己那两条缓存命令，别再走回「整包攥在内存里」的老路。
 */
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => null),
  Update: class MockUpdate {
    rid: number;
    available = true;
    currentVersion: string;
    version: string;
    body: string;
    date: string | null = null;
    rawJson: Record<string, unknown> = {};
    constructor(meta: { rid: number; version: string; body?: string; currentVersion: string }) {
      this.rid = meta.rid;
      this.version = meta.version;
      this.body = meta.body ?? "";
      this.currentVersion = meta.currentVersion;
      h.rids.set(meta.rid, meta.version);
    }
    close = vi.fn(async () => {
      h.calls.close += 1;
      h.rids.delete(this.rid);
    });
    download = vi.fn(async () => {
      throw new Error("装包只走 update_install_cached，不该再经插件的 download");
    });
    install = vi.fn(async () => {
      throw new Error("装包只走 update_install_cached，不该再经插件的 install");
    });
    downloadAndInstall = vi.fn(async () => {
      throw new Error("装包只走 update_install_cached，不该再经插件的 downloadAndInstall");
    });
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => h.current.value),
}));

vi.mock("@tauri-apps/api/core", () => {
  /** 前端 invoke('update_download_cached') 传的就是这个；桩按下标回报进度。 */
  class Channel {
    onmessage: ((event: unknown) => void) | undefined;
  }
  return {
    Channel,
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "update_pending_load":
          return h.pending.version
            ? { version: h.pending.version, attempts: h.pending.attempts }
            : null;
        case "update_pending_save":
          h.pending.version = (args?.version as string) ?? null;
          h.pending.attempts = (args?.attempts as number) ?? 0;
          return null;
        case "update_pending_clear":
          h.pending.version = null;
          h.pending.attempts = 0;
          return null;
        case "update_check":
          h.calls.check += 1;
          if (!h.checkResult.current) return null;
          return {
            rid: h.nextRid.value++,
            currentVersion: h.current.value,
            version: h.checkResult.current.version,
            body: h.checkResult.current.body ?? "",
            rawJson: {},
          };
        case "update_cache_state":
          return h.cache.version === args?.version ? 1024 : null;
        case "update_download_cached": {
          // 下的是这个句柄自己那一版，落盘前一次 rid 也认不出别的版本。
          const version = versionOfRid(args?.rid);
          h.calls.download += 1;
          const channel = args?.onEvent as Channel | undefined;
          channel?.onmessage?.({ event: "Started", data: { contentLength: 1024 } });
          channel?.onmessage?.({ event: "Progress", data: { chunkLength: 1024 } });
          channel?.onmessage?.({ event: "Finished" });
          h.cache.version = version;
          return 1024;
        }
        case "update_install_cached": {
          const version = versionOfRid(args?.rid);
          if (h.cache.version !== version) {
            throw new Error(`IO\u0001updates/${version}.bin\u0001entity not found`);
          }
          h.calls.install += 1;
          return null;
        }
        case "update_cache_remove":
          h.calls.cacheRemove += 1;
          if (h.cache.version === args?.version) h.cache.version = null;
          return null;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    }),
  };
});

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
  h.cache.version = null;
  h.rids.clear();
  h.nextRid.value = 10;
  h.current.value = "0.1.0";
  h.promptAnswer.value = true;
  h.calls = { check: 0, download: 0, install: 0, close: 0, cacheRemove: 0 };
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

  it("自动下载 + 下载完询问 + 答是：下、装、清标记、报已就绪", async () => {
    h.checkResult.current = { version: "0.2.0" };
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.download).toBe(1);
    expect(h.calls.install).toBe(1);
    expect(h.pending.version).toBeNull();
    const done = h.notifies[h.notifies.length - 1];
    expect(done.level).toBe("info");
    expect(done.content).toContain("0.2.0");
  });

  it("自动下载 + 下载完询问 + 答否：不装，包留在缓存里，句柄也不释放", async () => {
    h.checkResult.current = { version: "0.2.0" };
    h.promptAnswer.value = false;
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.install).toBe(0);
    expect(h.calls.close).toBe(0);
    expect(h.cache.version).toBe("0.2.0");
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

  it("挂起标记已尝试安装过（attempts >= 1）但仍未成功：清空标记防死循环，缓存留着给手动装", async () => {
    h.pending.version = "0.2.0";
    h.pending.attempts = 1;
    h.cache.version = "0.2.0";
    h.current.value = "0.1.0";
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.download).toBe(0);
    expect(h.calls.install).toBe(0);
    expect(h.pending.version).toBeNull();
    expect(h.cache.version).toBe("0.2.0");
  });

  it("有挂起标记且缓存里就有那一版：直接装，一次下载都不发", async () => {
    h.pending.version = "0.2.0";
    h.cache.version = "0.2.0";
    h.checkResult.current = { version: "0.2.0" };
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.download).toBe(0);
    expect(h.calls.install).toBe(1);
    expect(h.pending.version).toBeNull();
  });

  it("有挂起标记但缓存没了（被清理工具收了）：补一次下载，仍然装得上", async () => {
    h.pending.version = "0.2.0";
    h.checkResult.current = { version: "0.3.0" };
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.check).toBe(1);
    expect(h.calls.download).toBe(1);
    expect(h.calls.install).toBe(1);
    expect(h.pending.version).toBeNull();
  });

  it("挂起版本与当前一致：上次其实装完了，标记和那一版的安装包一起清掉", async () => {
    h.pending.version = "0.2.0";
    h.cache.version = "0.2.0";
    h.current.value = "0.2.0";
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.check).toBe(0);
    expect(h.calls.download).toBe(0);
    expect(h.pending.version).toBeNull();
    expect(h.cache.version).toBeNull();
    expect(h.calls.cacheRemove).toBe(1);
  });

  it("挂起标记在但 Release 撤了：标记与那版缓存一起作废", async () => {
    h.pending.version = "0.2.0";
    h.cache.version = "0.2.0";
    await runAutoUpdateFlow(PREFS(false, true), makeHooks());
    expect(h.calls.install).toBe(0);
    expect(h.pending.version).toBeNull();
    expect(h.cache.version).toBeNull();
  });
});

describe("延后之后不再重复下载", () => {
  it("延后 → 本次会话点「重启以完成更新」：直接装缓存那份，不重下也不再检查", async () => {
    h.checkResult.current = { version: "0.2.0" };
    h.promptAnswer.value = false;
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.download).toBe(1);

    const checkBefore = h.calls.check;
    await installReadyUpdate("0.2.0");
    expect(h.calls.download, "同一次会话里第二遍下载").toBe(1);
    expect(h.calls.check, "句柄还在手上，不该再联网检查一次").toBe(checkBefore);
    expect(h.calls.install).toBe(1);
  });

  it("延后 → 退出应用 → 下次启动补装：整条链路只下一遍", async () => {
    h.checkResult.current = { version: "0.2.0" };
    h.promptAnswer.value = false;
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.cache.version).toBe("0.2.0");

    // 下一次启动：进程是新的，句柄与内存都没了，只剩盘上那份包和挂起标记。
    h.rids.clear();
    h.calls = { check: 0, download: 0, install: 0, close: 0, cacheRemove: 0 };
    h.promptAnswer.value = true;
    await runAutoUpdateFlow(PREFS(true, true), makeHooks());
    expect(h.calls.download, "跨启动又下一遍安装包").toBe(0);
    expect(h.calls.install).toBe(1);
    expect(h.pending.version).toBeNull();
  });

  it("延后后手动点关于页的装包：走的还是缓存那份", async () => {
    h.checkResult.current = { version: "0.2.0" };
    h.cache.version = "0.2.0";
    await installReadyUpdate("0.2.0", { proxyUrl: "https://gh-proxy.com/" });
    expect(h.calls.download).toBe(0);
    expect(h.calls.install).toBe(1);
  });

  it("那一版已经从 Release 撤了：报错，不拿别的版本顶替", async () => {
    h.checkResult.current = { version: "0.3.0" };
    await expect(installReadyUpdate("0.9.9")).rejects.toThrow("0.9.9");
    expect(h.calls.install).toBe(0);
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
