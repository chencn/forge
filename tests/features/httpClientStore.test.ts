import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  cancelRunning,
  clearHistory,
  httpClientSnapshot,
  resetHttpClient,
  runRequest,
  runAll,
  refreshHistory,
  removeHistoryEntry,
  retryHistoryEntry,
  selectEntry,
  setHttpRoot,
  subscribeHttpEditor,
  type HttpExchange,
} from "../../src/features/http-client/store";

function exchange(id: string): HttpExchange {
  return {
    entry: {
      id,
      timeMs: 1,
      name: null,
      method: "GET",
      url: `http://example.com/${id}`,
      status: 200,
      totalMs: 1,
      file: null,
      error: null,
    },
    request: {
      name: null,
      method: "GET",
      url: `http://example.com/${id}`,
      headers: [],
      body: null,
    },
    response: {
      status: 200,
      statusText: "OK",
      version: "HTTP/1.1",
      headers: [],
      contentType: "text/plain",
      body: id,
      size: id.length,
      truncated: false,
      ttfbMs: 1,
      totalMs: 1,
      finalUrl: `http://example.com/${id}`,
    },
  };
}

beforeEach(async () => {
  const pending: Promise<unknown>[] = [];
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    const promise = Promise.resolve(cmd === "http_env_variables" ? {} : cmd === "http_history" ? [] : null);
    pending.push(promise);
    return promise;
  });
  resetHttpClient();
  setHttpRoot(`ws-${Math.random()}`);
  await Promise.all(pending);
  await Promise.resolve();
});

describe("http client store", () => {
  it("removes one persisted history entry and clears only its selection and cache", async () => {
    const entries = [exchange("first"), exchange("second")];
    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === "http_history") return Promise.resolve(entries.map((item) => item.entry));
      if (cmd === "http_history_get") return Promise.resolve(entries.find((item) => item.entry.id === args?.id));
      return Promise.resolve(null);
    });
    await refreshHistory();
    await selectEntry("second");
    await selectEntry("first");
    await removeHistoryEntry("first");
    expect(invoke).toHaveBeenCalledWith("http_history_remove", { root: expect.any(String), id: "first" });
    expect(httpClientSnapshot().history.map((item) => item.id)).toEqual(["second"]);
    expect(Object.keys(httpClientSnapshot().exchanges)).toEqual(["second"]);
    expect(httpClientSnapshot().selected).toBeNull();
    expect(httpClientSnapshot().exchange).toBeNull();
  });

  it("preserves history and selection if deleting the persisted entry fails", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([exchange("kept").entry]);
      if (cmd === "http_history_get") return Promise.resolve(exchange("kept"));
      if (cmd === "http_history_remove") return Promise.reject("IO\u0001access denied");
      return Promise.resolve(null);
    });
    await refreshHistory();
    await selectEntry("kept");
    const before = httpClientSnapshot();
    await expect(removeHistoryEntry("kept")).rejects.toContain("access denied");
    expect(httpClientSnapshot()).toBe(before);
  });

  it("does not restore a deleted entry from delayed list or detail reads", async () => {
    let releaseList!: (value: HttpExchange["entry"][]) => void;
    let releaseDetail!: (value: HttpExchange) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return new Promise((resolve) => { releaseList = resolve; });
      if (cmd === "http_history_get") return new Promise((resolve) => { releaseDetail = resolve; });
      return Promise.resolve(null);
    });
    const list = refreshHistory();
    const detail = selectEntry("deleted");
    await removeHistoryEntry("deleted");
    releaseList([exchange("deleted").entry]);
    releaseDetail(exchange("deleted"));
    await Promise.all([list, detail]);
    expect(httpClientSnapshot().history).toEqual([]);
    expect(httpClientSnapshot().exchanges).toEqual({});
    expect(httpClientSnapshot().selected).toBeNull();
  });

  it("does not let an old workspace deletion change the current selection", async () => {
    let release!: () => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([exchange("current").entry]);
      if (cmd === "http_history_get") return Promise.resolve(exchange("current"));
      if (cmd === "http_history_remove") return new Promise<void>((resolve) => { release = resolve; });
      return Promise.resolve(null);
    });
    const pending = removeHistoryEntry("current");
    setHttpRoot("workspace-after-remove");
    await refreshHistory();
    await selectEntry("current");
    release();
    await pending;
    expect(httpClientSnapshot().selected).toBe("current");
    expect(httpClientSnapshot().history.map((item) => item.id)).toEqual(["current"]);
  });

  it("replays the stored POST verbatim and selects a new exchange without opening an editor response", async () => {
    const original = exchange("original");
    original.entry.file = "D:/ws/request.http";
    original.request = {
      name: "upload",
      method: "POST",
      url: "http://example.com/post?query={{literal}}",
      headers: [["Content-Type", "text/plain"], ["X-Item", "first"], ["X-Item", "second"]],
      body: "### literal body\n\n{{unchanged}}\n$raw\r\n",
    };
    let sent = false;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve((sent ? [exchange("resent"), original] : [original]).map((item) => item.entry));
      if (cmd === "http_history_get") return Promise.resolve(original);
      if (cmd === "http_send") { sent = true; return Promise.resolve(exchange("resent")); }
      return Promise.resolve(null);
    });
    const phases: string[] = [];
    const stop = subscribeHttpEditor((event) => phases.push(event.phase));
    await refreshHistory();
    await retryHistoryEntry("original");
    expect(invoke).toHaveBeenCalledWith("http_send", {
      requestId: expect.any(String), path: original.entry.file, root: expect.any(String),
      call: { ...original.request, body: [{ text: original.request.body }] },
    });
    expect(httpClientSnapshot().selected).toBe("resent");
    expect(httpClientSnapshot().history.map((item) => item.id)).toEqual(["resent", "original"]);
    expect(httpClientSnapshot().running).toBeNull();
    expect(phases).toEqual([]);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "http_env_variables")).toBe(false);
    expect(invoke).toHaveBeenCalledWith("http_finish", { requestId: expect.any(String) });
    stop();
  });

  it("replays binary request bytes instead of their lossy display text", async () => {
    const original = exchange("binary");
    original.request.body = "\ufffd\u0000\ufffd";
    original.request.bodyBase64 = "/wCA";
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([original.entry]);
      if (cmd === "http_history_get") return Promise.resolve(original);
      if (cmd === "http_send") return Promise.resolve(exchange("binary-resent"));
      return Promise.resolve(null);
    });
    await selectEntry("binary");
    await retryHistoryEntry("binary");
    expect(invoke).toHaveBeenCalledWith("http_send", expect.objectContaining({
      call: expect.objectContaining({ body: [{ base64: "/wCA" }] }),
    }));
  });

  it.each(["stop", "workspace"])("does not send a retry after %s while loading its stored request", async (action) => {
    let release!: (value: HttpExchange) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([exchange("waiting").entry]);
      if (cmd === "http_history_get") return new Promise<HttpExchange>((resolve) => { release = resolve; });
      return Promise.resolve(null);
    });
    await refreshHistory();
    const pending = retryHistoryEntry("waiting");
    const rejected = expect(pending).rejects.toContain("HTTP_CANCELLED");
    if (action === "stop") cancelRunning();
    else setHttpRoot("workspace-after-retry");
    release(exchange("waiting"));
    await rejected;
    expect(invoke.mock.calls.some(([cmd]) => cmd === "http_send")).toBe(false);
    expect(httpClientSnapshot().running).toBeNull();
  });

  it("continues Run All after a recorded transport failure", async () => {
    const sent: string[] = [];
    invoke.mockImplementation((cmd: string, args?: { call?: { url: string } }) => {
      if (cmd === "http_env_variables") return Promise.resolve({});
      if (cmd === "http_history") return Promise.resolve(sent.map((id) => exchange(id).entry));
      if (cmd === "http_send") {
        const id = args!.call!.url.split("/").at(-1)!;
        sent.push(id);
        const value = exchange(id);
        if (id === "offline") {
          value.response = null;
          value.entry.error = "HTTP_NETWORK\u0001connection refused";
          value.entry.status = null;
        }
        return Promise.resolve(value);
      }
      return Promise.resolve(null);
    });
    await runAll("D:/ws/all.http", "GET http://example.com/offline\n\n###\nGET http://example.com/next\n");
    expect(sent).toEqual(["offline", "next"]);
    expect(httpClientSnapshot().exchange?.entry.id).toBe("next");
  });

  it.each(["stop", "workspace", "new-request"])("does not resume Run All after %s while finishing a request", async (action) => {
    let release!: () => void;
    const sent: string[] = [];
    invoke.mockImplementation((cmd: string, args?: { call?: { url: string } }) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_env_variables") return Promise.resolve({});
      if (cmd === "http_send") {
        const id = args!.call!.url.split("/").at(-1)!;
        sent.push(id);
        return Promise.resolve(exchange(id));
      }
      if (cmd === "http_finish" && !release) return new Promise<void>((resolve) => { release = resolve; });
      return Promise.resolve(null);
    });
    const pending = runAll("D:/ws/all.http", "GET http://example.com/first\n\n###\nGET http://example.com/next\n");
    const cancelled = expect(pending).rejects.toContain("HTTP_CANCELLED");
    await vi.waitUntil(() => Boolean(release));
    if (action === "stop") cancelRunning();
    else if (action === "workspace") setHttpRoot("workspace-during-finish");
    else await runRequest({ path: "D:/ws/manual.http", text: "GET http://example.com/manual\n", line: 1 });
    release();
    await cancelled;
    expect(sent).toEqual(action === "new-request" ? ["first", "manual"] : ["first"]);
  });

  it("stops Run All on preparation failure and releases its cancellation registration", async () => {
    await expect(runAll("D:/ws/all.http", "GET http://example.com/{{missing}}\n\n###\nGET http://example.com/next\n")).rejects.toContain("HTTP_VARIABLE");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "http_send")).toBe(false);
    expect(invoke).toHaveBeenCalledWith("http_finish", { requestId: expect.any(String) });
  });

  it("discards a previous workspace's delayed history detail", async () => {
    let release!: (value: HttpExchange) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_history_get") return new Promise<HttpExchange>((resolve) => { release = resolve; });
      return Promise.resolve(null);
    });
    const pending = selectEntry("old");
    setHttpRoot("workspace-next-detail");
    release(exchange("old"));
    await pending;
    expect(httpClientSnapshot().exchanges).toEqual({});
    expect(httpClientSnapshot().selected).toBeNull();
  });

  it("does not let an old clear erase the new workspace history", async () => {
    let release!: () => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([exchange("new").entry]);
      if (cmd === "http_history_clear") return new Promise<void>((resolve) => { release = resolve; });
      return Promise.resolve(null);
    });
    const pending = clearHistory();
    setHttpRoot("workspace-next-clear");
    await refreshHistory();
    release();
    await pending;
    expect(httpClientSnapshot().history.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("does not cache an outstanding detail after clearing history", async () => {
    let release!: (value: HttpExchange) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history_get") return new Promise<HttpExchange>((resolve) => { release = resolve; });
      return Promise.resolve(cmd === "http_history" ? [] : null);
    });
    const pending = selectEntry("cleared");
    await clearHistory();
    release(exchange("cleared"));
    await pending;
    expect(httpClientSnapshot().exchanges).toEqual({});
  });

  it("keeps a previous workspace's late send out of the current history", async () => {
    let release!: (value: HttpExchange) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_env_variables") return Promise.resolve({});
      if (cmd === "http_send") return new Promise<HttpExchange>((resolve) => { release = resolve; });
      return Promise.resolve(null);
    });
    const pending = runRequest({ path: "D:/ws/a.http", text: "GET http://example.com/a\n", line: 1 });
    const rejected = expect(pending).rejects.toContain("HTTP_CANCELLED");
    await vi.waitUntil(() => invoke.mock.calls.some(([cmd]) => cmd === "http_send"));
    setHttpRoot("workspace-next-send");
    release(exchange("old-send"));
    await rejected;
    expect(httpClientSnapshot().history).toEqual([]);
    expect(httpClientSnapshot().exchanges).toEqual({});
  });

  it("keeps the later cached selection when an older detail arrives", async () => {
    let resolveA: (value: HttpExchange) => void = () => {};
    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_history_get" && args?.id === "a") {
        return new Promise<HttpExchange>((resolve) => {
          resolveA = resolve;
        });
      }
      if (cmd === "http_history_get" && args?.id === "b") return Promise.resolve(exchange("b"));
      return Promise.resolve(null);
    });

    await selectEntry("b");
    const pendingA = selectEntry("a");
    expect(httpClientSnapshot().selected).toBe("a");
    await selectEntry("b");
    expect(httpClientSnapshot().selected).toBe("b");
    resolveA(exchange("a"));
    await pendingA;
    expect(httpClientSnapshot().selected).toBe("b");
    expect(httpClientSnapshot().exchange?.entry.id).toBe("b");
    expect(httpClientSnapshot().exchanges.a?.entry.id).toBe("a");
  });

  it("does not send when stop lands while environment variables are loading", async () => {
    let release: (value: Record<string, string>) => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_env_variables") {
        return new Promise<Record<string, string>>((resolve) => {
          release = resolve;
        });
      }
      if (cmd === "http_send") return Promise.resolve(exchange("sent"));
      return Promise.resolve(null);
    });
    const phases: string[] = [];
    const stop = subscribeHttpEditor((event) => phases.push(event.phase));
    const pending = runRequest({ path: "D:/ws/a.http", text: "GET http://example.com/a\n", line: 1 });
    expect(httpClientSnapshot().running).not.toBeNull();
    cancelRunning();
    release({});
    await expect(pending).rejects.toContain("HTTP_CANCELLED");
    expect(invoke.mock.calls.some((call) => call[0] === "http_send")).toBe(false);
    expect(phases).toEqual(["start", "cancelled"]);
    stop();
  });

  it("does not treat a response that arrives after stop as the current result", async () => {
    let release: (value: HttpExchange) => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_env_variables") return Promise.resolve({});
      if (cmd === "http_send") {
        return new Promise<HttpExchange>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(null);
    });
    const phases: string[] = [];
    const stop = subscribeHttpEditor((event) => phases.push(event.phase));
    const pending = runRequest({ path: "D:/ws/a.http", text: "GET http://example.com/a\n", line: 1 });
    await vi.waitUntil(() => invoke.mock.calls.some((call) => call[0] === "http_send"));
    cancelRunning();
    release(exchange("late"));
    await expect(pending).rejects.toContain("HTTP_CANCELLED");
    expect(phases).toEqual(["start", "cancelled"]);
    expect(httpClientSnapshot().selected).not.toBe("late");
    stop();
  });

  it("reports start and done around a successful send", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "http_history") return Promise.resolve([]);
      if (cmd === "http_env_variables") return Promise.resolve({});
      if (cmd === "http_send") return Promise.resolve(exchange("ok"));
      return Promise.resolve(null);
    });
    const phases: string[] = [];
    const stop = subscribeHttpEditor((event) => phases.push(event.phase));
    await runRequest({ path: "D:/ws/a.http", text: 'POST http://example.com/a\nContent-Type: application/json\n\n{"id":7}\n', line: 1 });
    expect(invoke).toHaveBeenCalledWith("http_send", {
      requestId: expect.any(String),
      path: "D:/ws/a.http",
      root: expect.any(String),
      call: {
        name: null,
        method: "POST",
        url: "http://example.com/a",
        headers: [["Content-Type", "application/json"]],
        body: [{ text: '{"id":7}' }],
      },
    });
    expect(phases).toEqual(["start", "done"]);
    stop();
  });
});
