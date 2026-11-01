import { describe, expect, it, vi } from "vitest";

const { files, reads } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  reads: [] as string[],
}));

vi.mock("../../src/lib/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    reads.push(path);
    const contents = files.get(path.replaceAll("\\", "/").toLowerCase());
    if (contents === undefined) throw new Error("missing file");
    return {
      path,
      contents,
      size: contents.length,
      lineEnding: "lf",
      hasBom: false,
      modifiedMs: 1,
      encoding: "utf-8",
    };
  }),
}));

import {
  clearEditorConfigCache,
  loadEditorConfig,
  parseEditorConfig,
  resolveEditorConfig,
} from "../../src/lib/editorConfig";

describe("EditorConfig", () => {
  it("清理缓存后重新读取外部变更的配置", async () => {
    clearEditorConfigCache();
    files.set("d:/project/.editorconfig", "[*]\nindent_size = 2");
    await expect(loadEditorConfig("D:/project", "D:/project/src/main.ts")).resolves.toEqual({ tabSize: 2 });

    files.set("d:/project/.editorconfig", "[*]\nindent_size = 4");
    await expect(loadEditorConfig("D:/project", "D:/project/src/main.ts")).resolves.toEqual({ tabSize: 2 });
    clearEditorConfigCache();
    await expect(loadEditorConfig("D:/project", "D:/project/src/main.ts")).resolves.toEqual({ tabSize: 4 });
    expect(reads.filter((path) => path.replaceAll("\\", "/").toLowerCase() === "d:/project/.editorconfig")).toHaveLength(2);
  });

  it("按 root 到当前文件的顺序合并，并让近层覆盖远层", () => {
    const result = resolveEditorConfig(
      [
        {
          directory: "D:/project",
          config: parseEditorConfig(`root = true\n[*]\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true`),
        },
        {
          directory: "D:/project/src",
          config: parseEditorConfig(`[*.ts]\nindent_size = 4\ninsert_final_newline = true`),
        },
      ],
      "D:/project/src/main.ts"
    );
    expect(result).toEqual({
      tabSize: 4,
      insertSpaces: true,
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
    });
  });

  it("支持目录模式、basename 模式与 tab_width 回退", () => {
    const result = resolveEditorConfig(
      [{
        directory: "D:/project",
        config: parseEditorConfig(`[*]\nindent_size = tab\ntab_width = 8\nend_of_line = crlf\n[generated/**]\nindent_style = tab`),
      }],
      "D:/project/generated/out.ts"
    );
    expect(result).toEqual({ tabSize: 8, insertSpaces: false, lineEnding: "crlf" });
  });

  it("忽略未知值而不污染全局回退", () => {
    const result = resolveEditorConfig(
      [{ directory: "D:/project", config: parseEditorConfig("[*.ts]\nindent_size = nope\nend_of_line = cr") }],
      "D:/project/main.ts"
    );
    expect(result).toEqual({});
  });

  it("支持组合扩展名，并按 unset 清除上层值", () => {
    const result = resolveEditorConfig(
      [
        { directory: "D:/project", config: parseEditorConfig("[*]\nindent_size = 4\ntrim_trailing_whitespace = true") },
        { directory: "D:/project/src", config: parseEditorConfig("[*.{js,ts}]\nindent_size = unset\ntrim_trailing_whitespace = unset") },
      ],
      "D:/project/src/main.ts"
    );
    expect(result).toEqual({});
  });
});
