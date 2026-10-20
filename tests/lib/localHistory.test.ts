import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getSnapshot,
  listSnapshots,
  recordSnapshot,
  restoreSnapshot,
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

  it("listSnapshots 调用 local_history_list，IPC 异常退回空数组", async () => {
    const mockList: SnapshotInfo[] = [
      { savedAt: 200, chars: 10, lineEnding: "lf", hasBom: false, encoding: "utf-8" },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(mockList);
    const res = await listSnapshots("D:/project", "D:/project/a.txt");
    expect(res).toEqual(mockList);

    vi.mocked(invoke).mockRejectedValueOnce(new Error("fail"));
    const fallback = await listSnapshots("D:/project", "D:/project/a.txt");
    expect(fallback).toEqual([]);
  });

  it("getSnapshot 取单个快照内容，异常时退回 null", async () => {
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
    const fallback = await getSnapshot("D:/project", "D:/project/a.txt", 999);
    expect(fallback).toBeNull();
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
});
