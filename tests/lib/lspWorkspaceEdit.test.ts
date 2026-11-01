import { describe, expect, it } from "vitest";
import { pathToUri } from "../../src/lib/lspUri";
import { applyWorkspaceEdit, type WorkspaceEditContext, type WorkspaceEditDocument } from "../../src/lib/lspWorkspaceEdit";

function memoryContext(
  documents: WorkspaceEditDocument[],
  encoding: "utf-8" | "utf-16" | "utf-32" = "utf-16",
  options: {
    failUpdate?: (uri: string, count: number) => boolean;
    failWrite?: (uri: string, count: number) => boolean;
    directories?: string[];
  } = {}
) {
  const store = new Map(documents.map((document) => [document.uri, { ...document }]));
  const calls: string[] = [];
  const undos: Array<() => Promise<void>> = [];
  const updateCounts = new Map<string, number>();
  const writeCounts = new Map<string, number>();
  const directories = new Set(options.directories ?? []);
  const context: WorkspaceEditContext = {
    positionEncoding: encoding,
    async read(uri) {
      return store.get(uri) ?? null;
    },
    async updateOpened(uri, text) {
      calls.push(`update:${uri}`);
      const count = (updateCounts.get(uri) ?? 0) + 1;
      updateCounts.set(uri, count);
      if (options.failUpdate?.(uri, count)) throw new Error(`update failed: ${uri}`);
      const document = store.get(uri);
      if (document) document.text = text;
    },
    async writeClosed(uri, text) {
      calls.push(`write:${uri}`);
      const count = (writeCounts.get(uri) ?? 0) + 1;
      writeCounts.set(uri, count);
      if (options.failWrite?.(uri, count)) throw new Error(`write failed: ${uri}`);
      const document = store.get(uri);
      if (document) document.text = text;
    },
    async create(uri) {
      calls.push(`create:${uri}`);
      store.set(uri, { uri, text: "", opened: false });
    },
    async rename(oldUri, newUri) {
      calls.push(`rename:${oldUri}->${newUri}`);
      const document = store.get(oldUri);
      if (document) {
        store.delete(oldUri);
        store.set(newUri, { ...document, uri: newUri });
      }
    },
    async delete(uri) {
      calls.push(`delete:${uri}`);
      store.delete(uri);
    },
    async stat(uri) {
      if (directories.has(uri)) return "directory";
      return store.has(uri) ? "file" : null;
    },
    registerUndo(undo) {
      undos.push(undo);
    },
  };
  return { context, store, calls, undos };
}

describe("WorkspaceEdit", () => {
  it("按原文坐标从后往前应用同一文件的多处编辑", async () => {
    const uri = pathToUri("D:/workspace/a.ts");
    const memory = memoryContext([{ uri, text: "abcd", opened: true }]);
    const result = await applyWorkspaceEdit(
      { changes: { [uri]: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" },
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "CD" },
      ] } },
      memory.context
    );
    expect(result).toEqual({ applied: true });
    expect(memory.store.get(uri)?.text).toBe("AbCD");
    expect(memory.calls).toEqual([`update:${uri}`]);
  });

  it("按 UTF-8 / UTF-32 的 server 坐标编辑 emoji 后面的字符", async () => {
    const uri = pathToUri("D:/workspace/a.ts");
    for (const encoding of ["utf-8", "utf-32"] as const) {
      const memory = memoryContext([{ uri, text: "😀x", opened: true }], encoding);
      const result = await applyWorkspaceEdit(
        { changes: { [uri]: [{ range: { start: { line: 0, character: encoding === "utf-8" ? 4 : 1 }, end: { line: 0, character: encoding === "utf-8" ? 5 : 2 } }, newText: "y" }] } },
        memory.context
      );
      expect(result.applied).toBe(true);
      expect(memory.store.get(uri)?.text).toBe("😀y");
    }
  });

  it("成功的多文档编辑只登记一个可执行的用户级撤销", async () => {
    const first = pathToUri("D:/workspace/a.ts");
    const second = pathToUri("D:/workspace/b.ts");
    const memory = memoryContext([
      { uri: first, text: "one", opened: true },
      { uri: second, text: "two", opened: true },
    ]);
    const result = await applyWorkspaceEdit({
      changes: {
        [first]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" }],
        [second]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "TWO" }],
      },
    }, memory.context);
    expect(result).toEqual({ applied: true });
    expect(memory.undos).toHaveLength(1);
    await memory.undos[0]();
    expect(memory.store.get(first)?.text).toBe("one");
    expect(memory.store.get(second)?.text).toBe("two");
  });

  it("两批编辑依次提交后逐级回放：先撤后一批，前一批的冲突校验认回放后的正文", async () => {
    const uri = pathToUri("D:/workspace/a.ts");
    const memory = memoryContext([{ uri, text: "one", opened: true }]);
    const apply = (newText: string) =>
      applyWorkspaceEdit(
        { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText }] } },
        memory.context
      );
    await apply("ONE");
    await apply("TWO");
    expect(memory.store.get(uri)?.text).toBe("TWO");
    await memory.undos[1]();
    expect(memory.store.get(uri)?.text).toBe("ONE");
    await memory.undos[0]();
    expect(memory.store.get(uri)?.text).toBe("one");
  });

  it("事务完成后正文被外部改写时拒绝覆盖并撤销", async () => {
    const uri = pathToUri("D:/workspace/a.ts");
    const memory = memoryContext([{ uri, text: "one", opened: true }]);
    await applyWorkspaceEdit({
      changes: {
        [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" }],
      },
    }, memory.context);
    memory.store.get(uri)!.text = "EXTERNAL";
    await expect(memory.undos[0]()).rejects.toThrow("撤销冲突");
    expect(memory.store.get(uri)?.text).toBe("EXTERNAL");
  });

  it("版本不符或脏的关闭文档时不提交任何文本", async () => {
    const first = pathToUri("D:/workspace/a.ts");
    const second = pathToUri("D:/workspace/b.ts");
    const memory = memoryContext([
      { uri: first, text: "one", opened: false, dirty: true, version: 3 },
      { uri: second, text: "two", opened: true, version: 9 },
    ]);
    const result = await applyWorkspaceEdit(
      { documentChanges: [{ textDocument: { uri: second, version: 8 }, edits: [] }, { textDocument: { uri: first }, edits: [] }] },
      memory.context
    );
    expect(result).toMatchObject({ applied: false, code: "conflict", uri: second, expectedVersion: 8, actualVersion: 9 });
    expect(memory.calls).toEqual([]);
    expect(memory.store.get(first)?.text).toBe("one");
  });

  it("支持创建后写入、重命名和删除资源操作", async () => {
    const oldUri = pathToUri("D:/workspace/old.ts");
    const newUri = pathToUri("D:/workspace/new.ts");
    const createdUri = pathToUri("D:/workspace/created.ts");
    const memory = memoryContext([{ uri: oldUri, text: "old", opened: false }]);
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "create", uri: createdUri },
          { kind: "rename", oldUri, newUri },
          { textDocument: { uri: createdUri }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "new" }] },
          { kind: "delete", uri: newUri },
        ],
      },
      memory.context
    );
    expect(result).toEqual({ applied: true });
    expect(memory.calls).toEqual([`create:${createdUri}`, `rename:${oldUri}->${newUri}`, `delete:${newUri}`, `write:${createdUri}`]);
    expect(memory.store.get(createdUri)?.text).toBe("new");
    expect(memory.store.has(newUri)).toBe(false);
  });

  it("不会删除或重命名仍有未保存内容的打开文档", async () => {
    const uri = pathToUri("D:/workspace/dirty.ts");
    const memory = memoryContext([{ uri, text: "dirty", opened: true, dirty: true }]);
    const result = await applyWorkspaceEdit(
      { documentChanges: [{ kind: "delete", uri }] },
      memory.context
    );
    expect(result).toMatchObject({ applied: false, code: "conflict", uri });
    expect(memory.calls).toEqual([]);
    expect(memory.store.has(uri)).toBe(true);
  });

  it("文本提交失败时恢复已经写入的前置文档", async () => {
    const first = pathToUri("D:/workspace/a.ts");
    const second = pathToUri("D:/workspace/b.ts");
    const memory = memoryContext(
      [
        { uri: first, text: "one", opened: false },
        { uri: second, text: "two", opened: false },
      ],
      "utf-16",
      { failWrite: (uri) => uri === second }
    );
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [first]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" }],
          [second]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "TWO" }],
        },
      },
      memory.context
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("write failed");
    expect(memory.store.get(first)?.text).toBe("one");
    expect(memory.store.get(second)?.text).toBe("two");
    expect(memory.calls).toEqual([`write:${first}`, `write:${second}`, `write:${first}`]);
  });

  it("重命名后文本提交失败时恢复原路径", async () => {
    const oldUri = pathToUri("D:/workspace/old.ts");
    const newUri = pathToUri("D:/workspace/new.ts");
    const memory = memoryContext(
      [{ uri: oldUri, text: "old", opened: false }],
      "utf-16",
      { failWrite: (uri) => uri === newUri }
    );
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "rename", oldUri, newUri },
          {
            textDocument: { uri: newUri },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "NEW" }],
          },
        ],
      },
      memory.context
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("write failed");
    expect(memory.store.get(oldUri)?.text).toBe("old");
    expect(memory.store.has(newUri)).toBe(false);
  });

  it("重命名覆盖目标后，对新 URI 的编辑使用源文件正文", async () => {
    const oldUri = pathToUri("D:/workspace/old.ts");
    const newUri = pathToUri("D:/workspace/new.ts");
    const memory = memoryContext([
      { uri: oldUri, text: "source", opened: false },
      { uri: newUri, text: "destination", opened: false },
    ]);
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "rename", oldUri, newUri, options: { overwrite: true } },
          {
            textDocument: { uri: newUri },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "SOURCE" }],
          },
        ],
      },
      memory.context
    );
    expect(result).toEqual({ applied: true });
    expect(memory.store.has(oldUri)).toBe(false);
    expect(memory.store.get(newUri)?.text).toBe("SOURCE");
  });

  it("创建后文本提交失败时删除新文件", async () => {
    const uri = pathToUri("D:/workspace/created.ts");
    const memory = memoryContext([], "utf-16", { failWrite: () => true });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "create", uri },
          {
            textDocument: { uri },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "new" }],
          },
        ],
      },
      memory.context
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("write failed");
    expect(memory.store.has(uri)).toBe(false);
    expect(memory.calls).toEqual([`create:${uri}`, `write:${uri}`, `delete:${uri}`]);
  });

  it("回滚动作失败时返回结构化 rollback 错误", async () => {
    const first = pathToUri("D:/workspace/a.ts");
    const second = pathToUri("D:/workspace/b.ts");
    const memory = memoryContext(
      [
        { uri: first, text: "one", opened: true },
        { uri: second, text: "two", opened: true },
      ],
      "utf-16",
      {
        failUpdate: (uri, count) => uri === second || (uri === first && count === 2),
      }
    );
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [first]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" }],
          [second]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "TWO" }],
        },
      },
      memory.context
    );
    expect(result).toMatchObject({ applied: false, code: "rollback" });
    expect(result.failureReason).toContain("回滚失败");
    expect(memory.store.get(first)?.text).toBe("ONE");
  });

  it("拒绝无法完整回滚的目录资源操作", async () => {
    const uri = pathToUri("D:/workspace/folder");
    const memory = memoryContext([], "utf-16", { directories: [uri] });
    const result = await applyWorkspaceEdit({ documentChanges: [{ kind: "delete", uri }] }, memory.context);
    expect(result).toMatchObject({ applied: false, code: "unavailable" });
    expect(result.failureReason).toContain("非普通文件");
    expect(memory.calls).toEqual([]);
  });
});
