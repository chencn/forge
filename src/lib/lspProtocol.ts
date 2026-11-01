import type {
  LspPosition,
  LspPositionEncoding,
  LspRequestId,
  LspServerCapabilities,
} from "./lspTypes";

const UTF8_ENCODER = new TextEncoder();

export interface LspRequestMessage {
  kind: "request";
  jsonrpc: "2.0";
  id: LspRequestId;
  method: string;
  params?: unknown;
}

export interface LspNotificationMessage {
  kind: "notification";
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface LspResponseMessage {
  kind: "response";
  jsonrpc: "2.0";
  id: LspRequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type LspProtocolMessage =
  | LspRequestMessage
  | LspNotificationMessage
  | LspResponseMessage;

/** 只接受 JSON-RPC 2.0 的三类消息，坏消息在消息循环边缘被丢弃。 */
export function parseLspMessage(body: string): LspProtocolMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return null;

  if (typeof message.method === "string") {
    if (message.id !== undefined && !isRequestId(message.id)) return null;
    return message.id === undefined
      ? {
          kind: "notification",
          jsonrpc: "2.0",
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        }
      : {
          kind: "request",
          jsonrpc: "2.0",
          id: message.id,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        };
  }

  if (!isRequestId(message.id)) return null;
  if (message.error !== undefined && !isRpcError(message.error)) return null;
  return {
    kind: "response",
    jsonrpc: "2.0",
    id: message.id,
    ...(message.result === undefined ? {} : { result: message.result }),
    ...(message.error === undefined ? {} : { error: message.error }),
  };
}

function isRequestId(value: unknown): value is LspRequestId {
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

function isRpcError(value: unknown): value is { code: number; message: string; data?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "number" && typeof error.message === "string";
}

/** LSP 3.17 未返回该字段时按规范使用 UTF-16。 */
export function positionEncodingOf(
  capabilities: Pick<LspServerCapabilities, "positionEncoding"> | null | undefined
): LspPositionEncoding {
  const value = capabilities?.positionEncoding;
  return value === "utf-8" || value === "utf-32" || value === "utf-16" ? value : "utf-16";
}

/** LSP position 转 JavaScript UTF-16 offset。所有输入都收在文档范围内，不抛异常。 */
export function offsetAtPosition(
  text: string,
  position: LspPosition,
  encoding: LspPositionEncoding = "utf-16"
): number {
  const lines = lineStarts(text);
  const line = clamp(Math.trunc(position.line), 0, lines.length - 1);
  const start = lines[line];
  const end = lineEnd(text, start);
  const content = text.slice(start, end);
  return start + unitsToOffset(content, Math.max(0, Math.trunc(position.character)), encoding);
}

/** JavaScript UTF-16 offset 转 LSP position。offset 在代理项中间时收至完整码点边界。 */
export function positionAtOffset(
  text: string,
  offset: number,
  encoding: LspPositionEncoding = "utf-16"
): LspPosition {
  const safeOffset = clamp(Math.trunc(offset), 0, text.length);
  const starts = lineStarts(text);
  let line = 0;
  for (let index = 1; index < starts.length && starts[index] <= safeOffset; index += 1) line = index;
  const start = starts[line];
  const contentEnd = lineEnd(text, start);
  const safeContentOffset = clampToCodePoint(text, Math.min(safeOffset, contentEnd));
  return {
    line,
    character: offsetToUnits(text.slice(start, safeContentOffset), encoding),
  };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline;
  return end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
}

function unitsToOffset(text: string, units: number, encoding: LspPositionEncoding): number {
  if (encoding === "utf-16") return clampToCodePoint(text, Math.min(units, text.length));
  let used = 0;
  let offset = 0;
  for (const codePoint of text) {
    const next = encoding === "utf-8" ? UTF8_ENCODER.encode(codePoint).length : 1;
    if (used + next > units) break;
    used += next;
    offset += codePoint.length;
  }
  return offset;
}

function offsetToUnits(text: string, encoding: LspPositionEncoding): number {
  if (encoding === "utf-16") return text.length;
  let units = 0;
  for (const codePoint of text) {
    units += encoding === "utf-8" ? UTF8_ENCODER.encode(codePoint).length : 1;
  }
  return units;
}

function clampToCodePoint(text: string, offset: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  ) {
    return offset - 1;
  }
  return offset;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
