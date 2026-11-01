import { describe, expect, it } from "vitest";
import {
  offsetAtPosition,
  parseLspMessage,
  positionAtOffset,
  positionEncodingOf,
} from "../../src/lib/lspProtocol";

describe("LSP protocol contracts", () => {
  it("parses request, notification, response and rejects malformed messages", () => {
    expect(parseLspMessage('{"jsonrpc":"2.0","id":7,"method":"initialize"}')).toEqual({
      kind: "request",
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
    });
    expect(parseLspMessage('{"jsonrpc":"2.0","method":"initialized","params":{}}')).toEqual({
      kind: "notification",
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    expect(parseLspMessage('{"jsonrpc":"2.0","id":"7","result":{"ok":true}}')).toEqual({
      kind: "response",
      jsonrpc: "2.0",
      id: "7",
      result: { ok: true },
    });
    expect(parseLspMessage('{"jsonrpc":"1.0","id":7,"result":null}')).toBeNull();
    expect(parseLspMessage('{"jsonrpc":"2.0","id":7,"error":{"code":-1}}')).toBeNull();
  });

  it("uses UTF-16 by default and preserves astral characters in all encodings", () => {
    const text = "a😀b\n中文x";
    expect(positionEncodingOf(undefined)).toBe("utf-16");

    expect(offsetAtPosition(text, { line: 0, character: 3 })).toBe(3);
    expect(offsetAtPosition(text, { line: 0, character: 5 }, "utf-8")).toBe(3);
    expect(offsetAtPosition(text, { line: 0, character: 2 }, "utf-32")).toBe(3);

    expect(positionAtOffset(text, 3)).toEqual({ line: 0, character: 3 });
    expect(positionAtOffset(text, 3, "utf-8")).toEqual({ line: 0, character: 5 });
    expect(positionAtOffset(text, 3, "utf-32")).toEqual({ line: 0, character: 2 });

    expect(offsetAtPosition("😀", { line: 0, character: 1 })).toBe(0);
    expect(positionAtOffset("😀", 1)).toEqual({ line: 0, character: 0 });
  });

  it("clamps invalid positions to document boundaries and handles CRLF lines", () => {
    const text = "abc\r\ndef";
    expect(offsetAtPosition(text, { line: -1, character: 99 })).toBe(3);
    expect(offsetAtPosition(text, { line: 99, character: 99 })).toBe(text.length);
    expect(positionAtOffset(text, 5)).toEqual({ line: 1, character: 0 });
  });
});
