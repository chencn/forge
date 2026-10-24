import { describe, expect, it } from "vitest";
import {
  allowAndRemember,
  allowDirectory,
  allowEdited,
  allowOnce,
  denyPermission,
  editedInput,
  parentDirectory,
  permissionOffer,
  requestPath,
  seedQuestionAnswers,
} from "../../src/lib/aiApprovals";

describe("提问卡的答案还原", () => {
  const questions = [{ id: "lang", question: "选哪个", options: [{ label: "中文" }, { label: "English" }] }];

  it("命中选项的算选中，没命中的是当时在「其他」手打的那句", () => {
    expect(seedQuestionAnswers(questions, { answers: { lang: ["English"] } })).toEqual({ answers: { lang: ["English"] }, other: {} });
    expect(seedQuestionAnswers(questions, { answers: { lang: ["随便写的那句"] } })).toEqual({ answers: {}, other: { lang: "随便写的那句" } });
    // 多选题选中的两项都要还原。
    const multi = [{ id: "m", question: "多选", options: [{ label: "a" }, { label: "b" }] }];
    expect(seedQuestionAnswers(multi, { answers: { m: ["a", "b"] } }).answers).toEqual({ m: ["a", "b"] });
  });

  it("没有答案或答案是授权形状时不硬拆", () => {
    expect(seedQuestionAnswers(questions, undefined)).toEqual({ answers: {}, other: {} });
    expect(seedQuestionAnswers(questions, { allow: true })).toEqual({ answers: {}, other: {} });
    expect(seedQuestionAnswers(questions, { answers: {} })).toEqual({ answers: {}, other: {} });
  });
});

describe("aiApprovals 的入参读取", () => {
  it("只认工具入参里的文件键，命令与工作目录一概不算", () => {
    expect(requestPath({ file_path: "a.ts" })).toBe("a.ts");
    expect(requestPath({ notebook_path: "n.ipynb" })).toBe("n.ipynb");
    expect(requestPath({ absolute_path: "x.ts" })).toBe("x.ts");
    expect(requestPath({ target_file: "y.ts" })).toBe("y.ts");
    expect(requestPath({ path: "z.md" })).toBe("z.md");
    // 空串不是路径：目录授权遇到它必须当作认不出来，而不是「整个当前目录」。
    expect(requestPath({ file_path: "   " })).toBeNull();
    expect(requestPath({ command: "rm -rf /", cwd: "D:/app" })).toBeNull();
    for (const bad of [null, undefined, "x", 12, []]) expect(requestPath(bad)).toBeNull();
  });
  it("键的优先顺序与 Rust 侧一致，两边必须挑到同一个路径", () => {
    expect(requestPath({ path: "second.ts", file_path: "first.ts" })).toBe("first.ts");
  });
});

describe("aiApprovals 的目录授权范围", () => {
  it("给出文件所在目录，分隔符原样保留", () => {
    expect(parentDirectory("D:\\app\\forge\\src\\a.ts")).toBe("D:\\app\\forge\\src");
    expect(parentDirectory("D:/app/forge/src/a.ts")).toBe("D:/app/forge/src");
    expect(parentDirectory("/tmp/project/src/a.ts")).toBe("/tmp/project/src");
    expect(parentDirectory("\\\\server\\share\\src\\a.ts")).toBe("\\\\server\\share\\src");
    expect(parentDirectory("D:\\app\\forge\\src\\")).toBe("D:\\app\\forge\\src");
  });
  it("盘根、系统根、相对路径与带 .. 的路径都不给开口子的机会", () => {
    expect(parentDirectory("src/a.ts")).toBeNull();
    expect(parentDirectory("D:\\a.ts")).toBeNull();
    expect(parentDirectory("/a.ts")).toBeNull();
    expect(parentDirectory("\\\\server\\a.ts")).toBeNull();
    expect(parentDirectory("D:\\a\\..\\b\\c.ts")).toBeNull();
    expect(parentDirectory("C:x\\a.ts")).toBeNull();
    expect(parentDirectory(null)).toBeNull();
  });
  it("工具名认不出就没有「不再询问」，路径认不出就没有「按目录」", () => {
    expect(permissionOffer({})).toEqual({ tool: null, root: null, canEdit: false });
    expect(permissionOffer({ toolName: "  " })).toEqual({ tool: null, root: null, canEdit: false });
    expect(permissionOffer({ toolName: "Bash", input: { command: "ls" } })).toEqual({ tool: "Bash", root: null, canEdit: false });
    expect(permissionOffer({ toolName: "Edit", input: { file_path: "D:/app/src/a.ts" }, canEdit: true })).toEqual({
      tool: "Edit", root: "D:/app/src", canEdit: true,
    });
    // canEdit 只认真事后端声明的 true：没声明就等于不能改。
    expect(permissionOffer({ toolName: "Edit", canEdit: undefined }).canEdit).toBe(false);
    expect(permissionOffer({ toolName: "Edit", canEdit: true }).canEdit).toBe(true);
  });
});

describe("aiApprovals 的答复形状", () => {
  it("拒绝就是拒绝，不附带任何修改或记住", () => {
    expect(denyPermission()).toEqual({ allow: false });
    expect(allowOnce()).toEqual({ allow: true });
    expect(allowAndRemember("Bash")).toEqual({ allow: true, remember: { tool: "Bash" } });
    expect(allowDirectory("Edit", "D:/app/src")).toEqual({ allow: true, remember: { tool: "Edit", root: "D:/app/src" } });
    expect(allowEdited({ command: "ls -l" })).toEqual({ allow: true, input: { command: "ls -l" } });
  });
  it("改过的入参只接受原入参已有的键", () => {
    const base = { file_path: "a.ts", old_string: "one", new_string: "two" };
    expect(editedInput('{"new_string":"safe"}', base)).toEqual({ value: { new_string: "safe" } });
    expect(editedInput('{"bypass":true}', base).error).toBe("ai.runtime.editUnknownKey");
    expect(editedInput('{"file_path":"a.ts","old_string":"o","new_string":"n","extra":1}', base).error).toBe("ai.runtime.editUnknownKey");
    expect(editedInput("{}", base).error).toBe("ai.runtime.editEmpty");
    expect(editedInput("nope", base).error).toBe("ai.runtime.editNotJson");
    expect(editedInput('["a"]', base).error).toBe("ai.runtime.editNotObject");
    expect(editedInput('"a.ts"', base).error).toBe("ai.runtime.editNotObject");
    // 没有基线就无从判断哪些键是原入参的：宁可不改。
    expect(editedInput('{"a":1}', undefined).error).toBe("ai.runtime.editNoBaseline");
    expect(editedInput('{"a":1}', []).error).toBe("ai.runtime.editNoBaseline");
  });
  it("改过的入参有上限，别把它变成塞整仓库的通道", () => {
    const base = { command: "ls" };
    const huge = JSON.stringify({ command: "x".repeat(70_000) });
    expect(editedInput(huge, base).error).toBe("ai.runtime.editTooLarge");
    expect(editedInput('{"command":"ls -l"}', base).value).toEqual({ command: "ls -l" });
  });
});
