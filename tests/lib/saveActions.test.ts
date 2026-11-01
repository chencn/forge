import { describe, expect, it } from "vitest";
import { applySaveActions } from "../../src/lib/saveActions";

describe("保存前本地动作", () => {
  it("裁掉非光标行的行尾空白并补末尾换行", () => {
    expect(applySaveActions("a  \n b\t\nlast", {
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
      protectedLine: 2,
    })).toEqual({ text: "a\n b\t\nlast\n", changed: true });
  });

  it("空文件不凭空添加末尾换行，关闭动作时保持原文", () => {
    expect(applySaveActions("", { trimTrailingWhitespace: true, insertFinalNewline: true })).toEqual({ text: "", changed: false });
    expect(applySaveActions("a  ", { trimTrailingWhitespace: false, insertFinalNewline: false })).toEqual({ text: "a  ", changed: false });
  });
});
