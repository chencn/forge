import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getSnapshot,
  listSnapshots,
  recordSnapshot,
  restoreSnapshot,
  listDirectoryHistory,
  captureHistory,
  putHistoryLabel,
  snapshotsBefore,
  revisionRange,
  type HistoryEntry,
  type SnapshotFull,
  type SnapshotInfo,
} from "../../src/lib/localHistory";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

describe("localHistory 前端接口契约", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("无工作区根时不发起 IPC 调用", async () => {
    const snap: SnapshotFull = {
      savedAt: 100,
      contents: "text",
      lineEnding: "lf",
      hasBom: false,
      encoding: "utf-8",
    };
    await recordSnapshot("", "D:/a.txt", snap);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("有工作区根时调用 local_history_record", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    const snap: SnapshotFull = {
      savedAt: 100,
      contents: "text",
      lineEnding: "lf",
      hasBom: false,
      encoding: "utf-8",
    };
    await recordSnapshot("D:/project", "D:/project/a.txt", snap);
    expect(invoke).toHaveBeenCalledWith("local_history_record", {
      root: "D:/project",
      path: "D:/project/a.txt",
      snapshot: snap,
    });
  });

  it("listSnapshots 返回历史，读取失败必须向界面报告", async () => {
    const mockList: SnapshotInfo[] = [
      { savedAt: 200, chars: 10, lineEnding: "lf", hasBom: false, encoding: "utf-8" },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(mockList);
    const res = await listSnapshots("D:/project", "D:/project/a.txt");
    expect(res).toEqual(mockList);

    vi.mocked(invoke).mockRejectedValueOnce(new Error("fail"));
    await expect(listSnapshots("D:/project", "D:/project/a.txt")).rejects.toThrow("fail");
  });

  it("getSnapshot 区分记录不存在与读取失败", async () => {
    const mockSnap: SnapshotFull = {
      savedAt: 200,
      contents: "body",
      lineEnding: "lf",
      hasBom: false,
      encoding: "utf-8",
    };
    vi.mocked(invoke).mockResolvedValueOnce(mockSnap);
    const res = await getSnapshot("D:/project", "D:/project/a.txt", 200);
    expect(res).toEqual(mockSnap);

    vi.mocked(invoke).mockRejectedValueOnce(new Error("missing"));
    await expect(getSnapshot("D:/project", "D:/project/a.txt", 999)).rejects.toThrow("missing");
  });

  it("restoreSnapshot 回写历史版本", async () => {
    const mockFileContent = {
      path: "D:/project/a.txt",
      contents: "restored",
      size: 8,
      lineEnding: "lf",
      hasBom: false,
      modifiedMs: 5000,
      encoding: "utf-8",
    };
    vi.mocked(invoke).mockResolvedValueOnce(mockFileContent);
    const res = await restoreSnapshot("D:/project", "D:/project/a.txt", 200);
    expect(res).toEqual(mockFileContent);
    expect(invoke).toHaveBeenCalledWith("local_history_restore", {
      root: "D:/project",
      path: "D:/project/a.txt",
      savedAt: 200,
    });
  });

  it("目录查询、删除前记录和标签均保留路径范围，恢复传递乐观锁", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await listDirectoryHistory("D:/project", "D:/project/src");
    expect(invoke).toHaveBeenLastCalledWith("local_history_list_dir", { root: "D:/project", path: "D:/project/src" });
    await captureHistory("D:/project", "D:/project/src", "deleted");
    expect(invoke).toHaveBeenLastCalledWith("local_history_capture", { root: "D:/project", path: "D:/project/src", event: "deleted" });
    await putHistoryLabel("D:/project", "D:/project/src", "before rename");
    expect(invoke).toHaveBeenLastCalledWith("local_history_put_label", { root: "D:/project", path: "D:/project/src", label: "before rename" });
    await restoreSnapshot("D:/project", "D:/project/src/a.ts", 200, 500);
    expect(invoke).toHaveBeenLastCalledWith("local_history_restore", { root: "D:/project", path: "D:/project/src/a.ts", savedAt: 200, expectModifiedMs: 500 });
  });

  it("保护快照失败不能被当作已保存", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    await expect(recordSnapshot("D:/project", "D:/project/a.txt", { savedAt: 1, contents: "unsaved", lineEnding: "lf", hasBom: false, encoding: "utf-8", event: "beforeRestore" })).rejects.toThrow("disk full");
  });
});

describe("历史修订选择", () => {
  const snapshot = (path: string, savedAt: number): HistoryEntry => ({ path, savedAt, chars: 1, kind: "snapshot", label: "saved" });
  const entries = [snapshot("D:/repo/src/a.ts", 30), snapshot("D:/repo/src/a.ts", 20), snapshot("D:/repo/src/a.ts", 10),
    snapshot("D:/repo/other/b.ts", 15), snapshot("D:/repo/src-extra/c.ts", 15)];
  const label: HistoryEntry = { path: "D:/repo/src", savedAt: 20, chars: 0, kind: "label", label: "checkpoint" };

  it("父目录中选子目录标签只恢复标签范围，使用严格早于标签的最近版本", () => {
    expect(snapshotsBefore(entries, label, "D:/repo")).toEqual([entries[2]]);
    expect(snapshotsBefore(entries, label, "D:/repo/other")).toEqual([]);
    expect(snapshotsBefore(entries, { ...label, path: "D:/repo" }, "D:/repo/src/a.ts")).toEqual([entries[2]]);
  });

  it("选文件标签不包含其它文件，输入顺序不影响最近版本", () => {
    expect(snapshotsBefore([...entries].reverse(), { ...label, path: "D:/repo/src/a.ts", savedAt: 25 }, "D:/repo")).toEqual([entries[1]]);
  });

  it("同文件多选比较最旧与最新，跨文件拒绝比较，标签不参与修订范围", () => {
    expect(revisionRange([entries[1], label, entries[0], entries[2]])).toEqual([entries[2], entries[0]]);
    expect(revisionRange([entries[0], entries[3]])).toBeNull();
    expect(revisionRange([entries[0], label])).toBeNull();
  });
});
