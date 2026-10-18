import { describe, expect, it, vi } from "vitest";
import { createCoalescer } from "../../src/lib/coalesce";

/** 手动控制的假任务：`resolve()` 之前它一直「在飞」。 */
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("createCoalescer 的排队与尾随合并", () => {
  it("在飞期间的多次请求只补跑一轮", async () => {
    const queue = createCoalescer();
    const run = vi.fn(() => deferred().promise);
    const first = deferred();
    run.mockImplementationOnce(() => first.promise);

    const calls = [queue.request(run), queue.request(run), queue.request(run)];
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve();
    const second = deferred();
    run.mockImplementationOnce(() => second.promise);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);

    second.resolve();
    await Promise.all(calls);
    // 三次请求并成「手头一趟 + 收尾补一趟」，第三次之后的写入由补跑那轮读到。
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("任务落定后的请求各自起一轮，不会被并进已经收尾的那条", async () => {
    const queue = createCoalescer();
    const run = vi.fn(async () => {});

    await queue.request(run);
    await queue.request(run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancelTrailing 把排队中的补跑作废", async () => {
    const queue = createCoalescer();
    const first = deferred();
    const run = vi.fn(() => first.promise);

    const task = queue.request(run);
    queue.request(run);
    queue.cancelTrailing();
    first.resolve();
    await task;
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("任务抛错时交还名额，后续请求照样能起新轮", async () => {
    const queue = createCoalescer();
    const boom = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(queue.request(boom)).rejects.toThrow("boom");
    const ok = vi.fn(async () => {});
    await queue.request(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("补跑用的是这次交进来的那份任务，不是第一次那份", async () => {
    const queue = createCoalescer();
    const first = deferred();
    const oldTask = vi.fn(() => first.promise);
    const newTask = vi.fn(async () => {});

    const task = queue.request(oldTask);
    queue.request(newTask);
    first.resolve();
    await task;

    expect(oldTask).toHaveBeenCalledTimes(1);
    expect(newTask).toHaveBeenCalledTimes(1);
  });
});
