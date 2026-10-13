import { describe, expect, it } from "vitest";
import { cancelKey, confirmKey, type DialogKind } from "../../src/components/PromptDialog";

const ALL_KINDS: DialogKind[] = [
  "newFolder",
  "newFile",
  "newBranch",
  "renameBranch",
  "newTag",
  "checkoutRev",
  "worktree",
  "patch",
  "rename",
  "delete",
  "deleteRef",
  "resetHard",
  "pushUpTo",
  "discard",
  "closeRoot",
  "resetSettings",
  "installUpdate",
  "restartUpdate",
];

describe("对话框按钮文案键映射契约", () => {
  it("重启更新确认框的主按钮键是 dialog.confirm，不是兜底的 dialog.create", () => {
    expect(confirmKey("restartUpdate")).toBe("dialog.confirm");
  });

  it("更新询问类的取消键映射为 dialog.updateLater（稍后更新）", () => {
    for (const kind of ["installUpdate", "restartUpdate"] as DialogKind[]) {
      expect(cancelKey(kind), kind).toBe("dialog.updateLater");
    }
  });

  it("其余所有对话框的取消键统一映射为通用 dialog.cancel", () => {
    const others = ALL_KINDS.filter(
      (kind) => kind !== "installUpdate" && kind !== "restartUpdate"
    );
    for (const kind of others) {
      expect(cancelKey(kind), kind).toBe("dialog.cancel");
    }
  });

  it("仅新建与落盘类型回落至 dialog.create", () => {
    const creating = ALL_KINDS.filter((kind) => confirmKey(kind) === "dialog.create");
    expect(creating).toEqual(["newFolder", "newFile", "newBranch", "newTag", "worktree", "patch"]);
  });

  it("关键操作类型的确认键对应明确语义，不回退到默认", () => {
    expect(confirmKey("installUpdate")).toBe("dialog.installNow");
    expect(confirmKey("checkoutRev")).toBe("git.checkoutShort");
    expect(confirmKey("renameBranch")).toBe("dialog.rename");
    expect(confirmKey("discard")).toBe("dialog.discard");
    expect(confirmKey("closeRoot")).toBe("dialog.closeRootConfirm");
    expect(confirmKey("resetSettings")).toBe("dialog.resetAll");
    expect(confirmKey("rename")).toBe("dialog.confirm");
  });
});
