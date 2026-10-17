import { describe, expect, it } from "vitest";
import { dropHintKey, splitDrop } from "../../src/lib/dropIn";

describe("splitDrop", () => {
  it("文件夹单独成组，文件和其它类型都当暂时打开", () => {
    expect(
      splitDrop([
        { path: "D:/proj", kind: "directory" },
        { path: "D:/a.ts", kind: "file" },
        { path: "D:/dev", kind: "other" },
      ])
    ).toEqual({
      files: ["D:/a.ts", "D:/dev"],
      folders: ["D:/proj"],
    });
  });
});

describe("dropHintKey", () => {
  it("还没分出类型时先给笼统提示", () => {
    expect(dropHintKey(0, 0, true)).toBe("drop.pending");
    expect(dropHintKey(0, 0, false)).toBe("drop.pending");
  });

  it("只有文件是暂时打开，只有文件夹是新项目，混在一起两句都说", () => {
    expect(dropHintKey(1, 0, false)).toBe("drop.file");
    expect(dropHintKey(3, 0, false)).toBe("drop.files");
    expect(dropHintKey(0, 1, false)).toBe("drop.folder");
    expect(dropHintKey(0, 2, false)).toBe("drop.folders");
    expect(dropHintKey(1, 1, false)).toBe("drop.mixed");
  });
});
