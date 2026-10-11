import { describe, expect, it, vi } from "vitest";
import { codedError, describeError } from "../../src/lib/errors";

/**
 * 错误通道的行为测试：后端只发「代码 + 原文片段」（\u0001 分隔），怎么说由前端定。
 * t 用假翻译，把 key 与变量拼成可断言的串。
 */
const t = vi.fn((key: string, vars?: Record<string, string | number>) => `${key}?${JSON.stringify(vars ?? {})}`);

describe("codedError 拼装", () => {
  it("代码与片段按 \u0001 连接，与 Rust error::SEP 同一把尺子", () => {
    expect(codedError("IO", "D:\\x", "denied")).toBe("IO\u0001D:\\x\u0001denied");
    expect(codedError("NO_REMOTE")).toBe("NO_REMOTE");
  });
});

describe("describeError 翻译", () => {
  it("按代码取文案并带上变量", () => {
    expect(describeError(codedError("PATH_GONE", "D:\\gone"), t)).toBe(
      'error.pathGone?{"path":"D:\\\\gone"}'
    );
  });

  it("TOO_LARGE 的字节数要翻成人话", () => {
    const text = describeError(codedError("TOO_LARGE", "2048", "10485760"), t);
    expect(text).toContain('"size":"2 KB"');
    expect(text).toContain('"max":"10.0 MB"');
  });

  it("GIT 代码的明细就是 git 原文，空明细走专用文案", () => {
    expect(describeError(codedError("GIT", "  fatal: bad object  "), t)).toBe("fatal: bad object");
    expect(describeError(codedError("GIT", "  "), t)).toBe("error.gitBare?{}");
  });

  it("不含分隔符的文本原样返回", () => {
    expect(describeError("fetch failed", t)).toBe("fetch failed");
    expect(t).not.toHaveBeenCalled();
  });

  it("对不上的代码退回原文片段", () => {
    // 多半是新旧两端没同时更新，把话说全比猜一句有用。
    expect(describeError(codedError("FUTURE_CODE", "detail here"), t)).toBe("detail here");
  });
});
