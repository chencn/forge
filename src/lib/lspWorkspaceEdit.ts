import { createFile, deleteEntry, readFile, renameEntry, statEntries, writeFile } from "./fs";
import { canonicalPath } from "./format";
import { pathToUri, uriToPath } from "./lspUri";
import { offsetAtPosition } from "./lspProtocol";
import type {
  LspApplyEditResult,
  LspPositionEncoding,
  LspResourceOperation,
  LspTextEdit,
  LspTextDocumentEdit,
  LspWorkspaceEdit,
} from "./lspTypes";

export interface WorkspaceEditDocument {
  uri: string;
  text: string;
  version?: number;
  dirty?: boolean;
  lineEnding?: "crlf" | "lf";
  hasBom?: boolean;
  encoding?: "utf-8" | "gb18030";
  opened: boolean;
}

export interface WorkspaceEditResourceOptions {
  overwrite?: boolean;
  ignoreIfExists?: boolean;
  recursive?: boolean;
  ignoreIfNotExists?: boolean;
}

export type WorkspaceEditEntryKind = "file" | "directory" | "other";

export interface WorkspaceEditContext {
  positionEncoding?: LspPositionEncoding;
  read(uri: string): Promise<WorkspaceEditDocument | null>;
  updateOpened(uri: string, text: string): Promise<void>;
  writeClosed(uri: string, text: string, document: WorkspaceEditDocument): Promise<void>;
  /** 目录无法由当前文件 API 完整快照，事务提交前必须拒绝这类资源操作。 */
  stat?(uri: string): Promise<WorkspaceEditEntryKind | null>;
  create(uri: string, options?: WorkspaceEditResourceOptions): Promise<void>;
  rename(oldUri: string, newUri: string, options?: WorkspaceEditResourceOptions): Promise<void>;
  delete(uri: string, options?: WorkspaceEditResourceOptions): Promise<void>;
  /** 成功提交后注册成一次用户级撤销；失败回滚不会注册。 */
  registerUndo?(undo: () => Promise<void>): void;
}

interface PlannedTextChange {
  uri: string;
  document: WorkspaceEditDocument;
  text: string;
}

interface WorkspaceEditSnapshot {
  kind: "missing" | WorkspaceEditEntryKind;
  document?: WorkspaceEditDocument;
}

type UndoAction = () => Promise<void>;

class WorkspaceEditConflict extends Error {
  readonly code = "conflict" as const;

  constructor(
    message: string,
    readonly uri: string,
    readonly expectedVersion?: number,
    readonly actualVersion?: number
  ) {
    super(message);
  }
}

class WorkspaceEditUnavailable extends Error {
  readonly code = "unavailable" as const;
}

/**
 * 校验、计算并提交一批 WorkspaceEdit。
 *
 * 所有文档先读完并完成冲突校验，再执行适配器；TextEdit 按原文坐标从后往前落地，
 * 所以多文件和同一文件的多处替换不会互相改变位置。
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  context: WorkspaceEditContext
): Promise<LspApplyEditResult> {
  const undo: UndoAction[] = [];
  try {
    const plan = await prepareWorkspaceEdit(edit, context);
    for (const operation of plan.resources) {
      const action = await applyResource(operation, context);
      if (action.undo) undo.push(action.undo);
      await action.apply();
    }
    for (const change of plan.textChanges) {
      if (change.document.opened) {
        await context.updateOpened(change.uri, change.text);
        undo.push(() => context.updateOpened(change.uri, change.document.text));
      } else {
        await context.writeClosed(change.uri, change.text, change.document);
        undo.push(() => context.writeClosed(change.uri, change.document.text, change.document));
      }
    }
    if (context.registerUndo && undo.length > 0) {
      const committed = [...undo].reverse();
      context.registerUndo(async () => {
        await assertUndoState(plan, context);
        for (const action of committed) await action();
      });
    }
    return { applied: true };
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const action of undo.reverse()) {
      try {
        await action();
      } catch (rollbackCause) {
        rollbackErrors.push(rollbackCause);
      }
    }
    if (rollbackErrors.length > 0) {
      const original = cause instanceof Error ? cause.message : String(cause);
      const rollback = rollbackErrors.map((error) => (error instanceof Error ? error.message : String(error))).join("；");
      return {
        applied: false,
        code: "rollback",
        failureReason: `WorkspaceEdit 执行失败：${original}；回滚失败：${rollback}`,
      };
    }
    if (cause instanceof WorkspaceEditConflict) {
      return {
        applied: false,
        code: cause.code,
        uri: cause.uri,
        expectedVersion: cause.expectedVersion,
        actualVersion: cause.actualVersion,
        failureReason: cause.message,
      };
    }
    if (cause instanceof WorkspaceEditUnavailable) {
      return { applied: false, code: cause.code, failureReason: cause.message };
    }
    return { applied: false, failureReason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** 撤销是异步用户操作，执行前必须确认事务后的正文/资源仍未被别处改写。 */
async function assertUndoState(
  plan: { textChanges: PlannedTextChange[]; resources: LspResourceOperation[] },
  context: WorkspaceEditContext
): Promise<void> {
  for (const change of plan.textChanges) {
    const current = await context.read(change.uri);
    if (!current || current.text !== change.text) {
      throw new Error(`WorkspaceEdit 撤销冲突：${change.uri} 已被修改`);
    }
  }
  for (const operation of plan.resources) {
    if (operation.kind === "create") {
      const current = await snapshotForRollback(operation.uri, context);
      if (current.kind === "missing") throw new Error(`WorkspaceEdit 撤销冲突：创建目标已不存在：${operation.uri}`);
    } else if (operation.kind === "rename") {
      const source = await snapshotForRollback(operation.oldUri, context);
      const destination = await snapshotForRollback(operation.newUri, context);
      if (source.kind !== "missing" || destination.kind === "missing") {
        throw new Error(`WorkspaceEdit 撤销冲突：重命名目标已被修改：${operation.newUri}`);
      }
    } else {
      const current = await snapshotForRollback(operation.uri, context);
      if (current.kind !== "missing") throw new Error(`WorkspaceEdit 撤销冲突：删除目标已重新出现：${operation.uri}`);
    }
  }
}

async function prepareWorkspaceEdit(edit: LspWorkspaceEdit, context: WorkspaceEditContext) {
  const textEdits = new Map<string, { edits: LspTextEdit[]; version?: number }>();
  const resources: LspResourceOperation[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) addTextEdits(textEdits, uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (isTextDocumentEdit(change)) {
      addTextEdits(textEdits, change.textDocument.uri, change.edits, change.textDocument.version ?? undefined);
    } else resources.push(change);
  }

  const textChanges: PlannedTextChange[] = [];
  for (const [uri, item] of textEdits) {
    const document = await readPlannedDocument(uri, textEdits, resources, context);
    if (!document) {
      const creates = resources.some((operation) => operation.kind === "create" && operation.uri === uri);
      if (!creates) throw new Error(`找不到 WorkspaceEdit 目标：${uri}`);
    }
    if (!document) {
      textChanges.push({
        uri,
        document: { uri, text: "", opened: false },
        text: applyTextEdits("", item.edits, context.positionEncoding),
      });
      continue;
    }
    if (item.version !== undefined && document.version !== item.version) {
      throw new WorkspaceEditConflict(
        `WorkspaceEdit 版本冲突：${uri}（期望 ${item.version}，实际 ${document.version ?? "未知"}）`,
        uri,
        item.version,
        document.version
      );
    }
    if (document.dirty && !document.opened) {
      throw new WorkspaceEditConflict(`WorkspaceEdit 不能覆盖未保存文档：${uri}`, uri);
    }
    textChanges.push({ uri, document, text: applyTextEdits(document.text, item.edits, context.positionEncoding) });
  }
  for (const operation of resources) {
    validateResource(operation);
    const targetUri = operation.kind === "rename" ? operation.oldUri : operation.uri;
    await assertFileResource(targetUri, context, operation.kind === "create");
    const target = operation.kind === "create" ? null : await context.read(targetUri);
    if (target?.dirty) {
      throw new WorkspaceEditConflict(`WorkspaceEdit 不能操作未保存文档：${targetUri}`, targetUri);
    }
    if (operation.kind === "rename") {
      await assertFileResource(operation.newUri, context, false);
      const destination = await context.read(operation.newUri);
      if (destination?.dirty) {
        throw new WorkspaceEditConflict(`WorkspaceEdit 不能覆盖未保存文档：${operation.newUri}`, operation.newUri);
      }
    }
  }
  return { textChanges, resources };
}

async function readPlannedDocument(
  uri: string,
  textEdits: Map<string, { edits: LspTextEdit[]; version?: number }>,
  resources: LspResourceOperation[],
  context: WorkspaceEditContext
): Promise<WorkspaceEditDocument | null> {
  const direct = await context.read(uri);
  const rename = resources.find((operation) => operation.kind === "rename" && operation.newUri === uri);
  if (rename?.kind === "rename") {
    if (direct && rename.options?.ignoreIfExists) return cloneDocument(direct);
    const source = await context.read(rename.oldUri);
    if (source) return cloneDocument(source);
  }
  if (direct) return cloneDocument(direct);
  const creates = resources.some((operation) => operation.kind === "create" && operation.uri === uri);
  if (creates && textEdits.has(uri)) return null;
  return null;
}

function addTextEdits(
  map: Map<string, { edits: LspTextEdit[]; version?: number }>,
  uri: string,
  edits: LspTextEdit[],
  version?: number
): void {
  if (!uri || !Array.isArray(edits)) throw new Error("WorkspaceEdit 的 TextEdit 无效");
  const current = map.get(uri);
  if (current && current.version !== version) throw new Error(`同一文档包含互相冲突的版本：${uri}`);
  map.set(uri, { edits: [...(current?.edits ?? []), ...edits], version: current?.version ?? version });
}

function applyTextEdits(text: string, edits: LspTextEdit[], encoding: LspPositionEncoding = "utf-16"): string {
  const changes = edits
    .map((edit) => {
      const from = offsetAtPosition(text, edit.range.start, encoding);
      const to = offsetAtPosition(text, edit.range.end, encoding);
      if (to < from) throw new Error("WorkspaceEdit range 反向");
      return { from, to, insert: edit.newText };
    })
    .sort((a, b) => b.from - a.from || b.to - a.to);
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index - 1].from < changes[index].to) throw new Error("WorkspaceEdit range 重叠");
  }
  let result = text;
  for (const change of changes) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  return result;
}

function isTextDocumentEdit(value: LspTextDocumentEdit | LspResourceOperation): value is LspTextDocumentEdit {
  return "textDocument" in value && Boolean(value.textDocument?.uri);
}

function validateResource(operation: LspResourceOperation): void {
  const uri = operation.kind === "rename" ? operation.oldUri : operation.uri;
  if (!uriToPath(uri)) throw new Error(`WorkspaceEdit URI 无效：${uri}`);
  if (operation.kind === "rename" && !uriToPath(operation.newUri)) {
    throw new Error(`WorkspaceEdit URI 无效：${operation.newUri}`);
  }
}

async function applyResource(
  operation: LspResourceOperation,
  context: WorkspaceEditContext
): Promise<{ apply: () => Promise<void>; undo?: UndoAction }> {
  if (operation.kind === "create") {
    const before = await snapshot(operation.uri, context);
    const noOp = before.kind !== "missing" && operation.options?.ignoreIfExists;
    return {
      apply: () => context.create(operation.uri, operation.options),
      undo: noOp ? undefined : () => restoreSnapshot(operation.uri, before, context),
    };
  }
  if (operation.kind === "rename") {
    const source = await snapshot(operation.oldUri, context);
    const destination = await snapshot(operation.newUri, context);
    const noOp = destination.kind !== "missing" && operation.options?.ignoreIfExists;
    return {
      apply: () => context.rename(operation.oldUri, operation.newUri, operation.options),
      undo:
        noOp
          ? undefined
          : async () => {
              const currentSource = await snapshotForRollback(operation.oldUri, context);
              const currentDestination = await snapshotForRollback(operation.newUri, context);
              if (source.kind !== "missing" && currentSource.kind === "missing") {
                if (currentDestination.kind === "missing") {
                  throw new Error(`回滚时找不到重命名目标：${operation.newUri}`);
                }
                await context.rename(operation.newUri, operation.oldUri, { overwrite: false });
              }
              if (destination.kind !== "missing") await restoreSnapshot(operation.newUri, destination, context);
            },
    };
  }
  const before = await snapshot(operation.uri, context);
  const noOp = before.kind === "missing" && operation.options?.ignoreIfNotExists;
  return {
    apply: () => context.delete(operation.uri, operation.options),
    undo: noOp ? undefined : () => restoreSnapshot(operation.uri, before, context),
  };
}

async function snapshot(uri: string, context: WorkspaceEditContext): Promise<WorkspaceEditSnapshot> {
  const document = await context.read(uri);
  if (document) return { kind: "file", document: cloneDocument(document) };
  const kind = context.stat ? await context.stat(uri) : null;
  return { kind: kind ?? "missing" };
}

async function restoreSnapshot(
  uri: string,
  snapshot: WorkspaceEditSnapshot,
  context: WorkspaceEditContext
): Promise<void> {
  if (snapshot.kind === "missing") {
    const current = await snapshotForRollback(uri, context);
    if (current.kind !== "missing") await context.delete(uri, { recursive: false, ignoreIfNotExists: true });
    return;
  }
  if (snapshot.kind !== "file" || !snapshot.document) {
    throw new Error(`无法回滚非普通文件：${uri}`);
  }
  const current = await snapshotForRollback(uri, context);
  if (current.kind === "missing") await context.create(uri);
  else if (current.kind !== "file") throw new Error(`回滚目标不是普通文件：${uri}`);
  if (snapshot.document.opened) await context.updateOpened(uri, snapshot.document.text);
  else await context.writeClosed(uri, snapshot.document.text, snapshot.document);
}

async function snapshotForRollback(uri: string, context: WorkspaceEditContext): Promise<WorkspaceEditSnapshot> {
  const document = await context.read(uri);
  if (document) return { kind: "file", document: cloneDocument(document) };
  const kind = context.stat ? await context.stat(uri) : null;
  return { kind: kind ?? "missing" };
}

function cloneDocument(document: WorkspaceEditDocument): WorkspaceEditDocument {
  return { ...document };
}

async function assertFileResource(
  uri: string,
  context: WorkspaceEditContext,
  allowMissing: boolean
): Promise<void> {
  const kind = (await snapshot(uri, context)).kind;
  if (kind === "missing" && allowMissing) return;
  if (kind === "directory" || kind === "other") {
    throw new WorkspaceEditUnavailable(`WorkspaceEdit 不支持原子操作非普通文件：${uri}`);
  }
}

/** 供没有打开文档适配器时使用的磁盘实现。 */
export function fileSystemWorkspaceEditContext(
  positionEncoding: LspPositionEncoding = "utf-16"
): WorkspaceEditContext {
  return {
    positionEncoding,
    async read(uri) {
      const path = uriToPath(uri);
      if (!path) return null;
      try {
        const file = await readFile(path);
        return {
          uri: pathToUri(path),
          text: file.contents,
          lineEnding: file.lineEnding,
          hasBom: file.hasBom,
          encoding: file.encoding,
          opened: false,
        };
      } catch {
        return null;
      }
    },
    async updateOpened() {
      throw new Error("WorkspaceEdit 缺少打开文档适配器");
    },
    async stat(uri) {
      const path = uriToPath(uri);
      if (!path) return null;
      return (await statEntries([path]))[0]?.kind ?? null;
    },
    async writeClosed(uri, text, document) {
      const path = uriToPath(uri);
      if (!path) throw new Error(`WorkspaceEdit URI 无效：${uri}`);
      await writeFile(path, text, document.lineEnding ?? "lf", document.hasBom ?? false, document.encoding);
    },
    async create(uri, options) {
      const path = uriToPath(uri);
      if (!path) throw new Error(`WorkspaceEdit URI 无效：${uri}`);
      const exists = (await statEntries([path])).length > 0;
      if (exists && options?.ignoreIfExists) return;
      if (exists && !options?.overwrite) throw new Error(`目标已存在：${path}`);
      if (exists) await deleteEntry(path);
      await createFile(path);
    },
    async rename(oldUri, newUri, options) {
      const from = uriToPath(oldUri);
      const to = uriToPath(newUri);
      if (!from || !to) throw new Error("WorkspaceEdit 重命名 URI 无效");
      const exists = (await statEntries([to])).length > 0;
      if (exists && options?.ignoreIfExists) return;
      if (exists && !options?.overwrite) throw new Error(`目标已存在：${to}`);
      if (exists) await deleteEntry(to);
      await renameEntry(from, to);
    },
    async delete(uri, options) {
      const path = uriToPath(uri);
      if (!path) throw new Error(`WorkspaceEdit URI 无效：${uri}`);
      const exists = (await statEntries([path])).length > 0;
      if (!exists && options?.ignoreIfNotExists) return;
      if (!exists) throw new Error(`目标不存在：${path}`);
      await deleteEntry(path);
    },
  };
}

export function pathOfWorkspaceUri(uri: string): string | null {
  const path = uriToPath(uri);
  return path ? canonicalPath(path) : null;
}
