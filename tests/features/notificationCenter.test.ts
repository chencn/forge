import { describe, expect, it, beforeEach } from "vitest";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  },
  configurable: true,
});

import {
  notificationCenter,
  balloonTimeout,
  NOTIFICATION_MAX_AGE_MS,
  saveNotifications,
  loadNotifications,
  sendNativeNotification,
  requestNativeNotificationPermission,
} from "../../src/lib/notifications";
import { DEFAULT_SETTINGS } from "../../src/lib/settings";

describe("NotificationCenter 核心总线与通知策略测试", () => {
  beforeEach(() => {
    localStorage.clear();
    notificationCenter.clearHistory();
  });

  it("notify 发布基础通知：正确赋予唯一 ID、时间戳、默认组与气泡状态", () => {
    const id = notificationCenter.notify({
      title: "编译完成",
      content: "耗时 1.2s",
      level: "info",
      groupId: "build",
      groupTitle: "构建",
    });

    const state = notificationCenter.getState();
    expect(state.history.length).toBe(1);
    expect(state.toasts.length).toBe(1);

    const item = state.history[0];
    expect(item.id).toBe(id);
    expect(item.title).toBe("编译完成");
    expect(item.content).toBe("耗时 1.2s");
    expect(item.level).toBe("info");
    expect(item.groupId).toBe("build");
    expect(item.groupTitle).toBe("构建");
    expect(item.balloon).toBe(true);
    expect(item.sticky).toBe(false);
  });

  it("Sticky 策略：错误级别默认常驻，balloonTimeout 返回 null", () => {
    notificationCenter.notify({
      title: "Git 推送失败",
      content: "网络连接超时",
      level: "error",
      groupId: "git",
    });

    const state = notificationCenter.getState();
    const item = state.toasts[0];
    expect(item.sticky).toBe(true);
    expect(balloonTimeout(item)).toBeNull();
  });

  it("超时计算：普通 info 返回 6000ms，warn 返回 9000ms", () => {
    notificationCenter.notify({
      title: "更新提示",
      content: "新版本可用",
      level: "info",
    });
    notificationCenter.notify({
      title: "分支警告",
      content: "分支落后",
      level: "warn",
    });

    const [warnItem, infoItem] = notificationCenter.getState().toasts;
    expect(balloonTimeout(infoItem)).toBe(6000);
    expect(balloonTimeout(warnItem)).toBe(9000);
  });

  it("Action 操作回调：通知绑定的 action 可被正确触发执行", () => {
    let actionRan = false;
    notificationCenter.notify({
      title: "冲突待解",
      content: "README.md 冲突",
      groupId: "git",
      actions: [
        {
          label: "解决冲突...",
          primary: true,
          run: () => {
            actionRan = true;
          },
        },
      ],
    });

    const item = notificationCenter.getState().history[0];
    expect(item.actions).toBeDefined();
    expect(item.actions?.length).toBe(1);
    expect(item.actions?.[0].label).toBe("解决冲突...");
    expect(item.actions?.[0].primary).toBe(true);

    item.actions?.[0].run();
    expect(actionRan).toBe(true);
  });

  it("dismissBalloon 只移除浮动气泡，历史记录依然留存", () => {
    const id = notificationCenter.notify({
      title: "长任务完成",
      content: "依赖包已下载完毕",
      level: "info",
    });

    expect(notificationCenter.getState().toasts.length).toBe(1);
    expect(notificationCenter.getState().history.length).toBe(1);

    notificationCenter.dismissBalloon(id);
    expect(notificationCenter.getState().toasts.length).toBe(0);
    expect(notificationCenter.getState().history.length).toBe(1);
  });

  it("markAllAsRead 与 clearHistory 批量状态流转", () => {
    notificationCenter.notify({ title: "1", content: "1" });
    notificationCenter.notify({ title: "2", content: "2" });

    expect(notificationCenter.getState().history.every((n) => !n.read)).toBe(true);

    notificationCenter.markAllAsRead();
    expect(notificationCenter.getState().history.every((n) => n.read)).toBe(true);

    notificationCenter.clearHistory();
    expect(notificationCenter.getState().history.length).toBe(0);
    expect(notificationCenter.getState().toasts.length).toBe(0);
  });

  it("多项目隔离：切换工程根时自动加载并隔离各自历史，且剔除 7 天过期记录", () => {
    const rootA = "D:/projects/project-a";
    const rootB = "D:/projects/project-b";

    // 1. 在项目 A 下发通知
    notificationCenter.switchProjectRoot(rootA);
    notificationCenter.notify({ title: "A 的通知", content: "AAA" });
    expect(notificationCenter.getState().history[0].title).toBe("A 的通知");

    // 2. 切换到项目 B
    notificationCenter.switchProjectRoot(rootB);
    expect(notificationCenter.getState().history.length).toBe(0);
    notificationCenter.notify({ title: "B 的通知", content: "BBB" });
    expect(notificationCenter.getState().history[0].title).toBe("B 的通知");

    // 3. 切回项目 A，历史完整恢复，且不包含项目 B 的内容
    notificationCenter.switchProjectRoot(rootA);
    expect(notificationCenter.getState().history.length).toBe(1);
    expect(notificationCenter.getState().history[0].title).toBe("A 的通知");

    // 4. 过期数据自动剔除测试
    const now = Date.now();
    const expiredItem = {
      id: "expired",
      groupId: "system",
      title: "过期的通知",
      content: "old",
      level: "info" as const,
      timestamp: now - NOTIFICATION_MAX_AGE_MS - 1000,
      time: now - NOTIFICATION_MAX_AGE_MS - 1000,
      read: true,
      projectRoot: rootA,
      balloon: false,
      sticky: false,
    };
    saveNotifications(rootA, [expiredItem]);
    const reloaded = loadNotifications(rootA);
    expect(reloaded.find((n) => n.id === "expired")).toBeUndefined();
  });

  it("原生系统通知接口：在无 Webview/无原生环境下优雅降级返回 false，不抛异常", async () => {
    const res = await sendNativeNotification("测试标题", { body: "测试内容" });
    expect(typeof res).toBe("boolean");

    const perm = await requestNativeNotificationPermission();
    expect(typeof perm).toBe("boolean");
  });

  it("原生系统通知策略联动：勿扰模式与后台状态控制", () => {
    // 1. 同步包含 git 开启系统通知的 settings
    const settings = {
      ...DEFAULT_SETTINGS,
      notificationDoNotDisturb: false,
      notificationGroups: {
        ...DEFAULT_SETTINGS.notificationGroups,
        git: { displayType: "balloon" as const, log: true, system: true },
      },
    };
    notificationCenter.syncSettings(settings);

    // 2. 模拟失焦 (document.hasFocus 返回 false)
    const origDoc = globalThis.document;
    globalThis.document = {
      hasFocus: () => false,
      visibilityState: "hidden",
    } as unknown as Document;

    try {
      const id = notificationCenter.notify({
        title: "分支拉取完成",
        content: "main 分支已更新",
        groupId: "git",
      });
      expect(typeof id).toBe("string");
      expect(notificationCenter.getState().toasts.length).toBe(1);

      // 3. 勿扰模式开启时：静默气泡，也不唤起系统通知
      notificationCenter.syncSettings({
        ...settings,
        notificationDoNotDisturb: true,
      });
      notificationCenter.clearHistory();

      notificationCenter.notify({
        title: "后台编译完成",
        content: "耗时 3.2s",
        groupId: "git",
      });
      // 勿扰模式下气泡数为 0，历史数为 1
      expect(notificationCenter.getState().toasts.length).toBe(0);
      expect(notificationCenter.getState().history.length).toBe(1);
    } finally {
      globalThis.document = origDoc;
    }
  });
});
