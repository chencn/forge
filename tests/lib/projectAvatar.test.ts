import { describe, expect, it } from "vitest";
import {
  getProjectAvatarBackground,
  getProjectAvatarInitials,
  getProjectGradientColorIndex,
} from "../../src/lib/projectAvatar";

describe("项目两字头像", () => {
  it.each([
    ["John Smith", "JS"],
    ["John-Smith-Harris", "JH"],
    ["MyProject", "MP"],
    ["My-Project", "MP"],
    ["Lithe-IDEA-issue-35-ci", "LC"],
    ["lithe", "L"],
    ["文档项目", "文"],
    ["my_app.web", "MA"],
  ])("%s → %s", (name, initials) => {
    expect(getProjectAvatarInitials(name)).toBe(initials);
  });

  it("头像渐变和顶栏色用同一档", () => {
    expect(getProjectGradientColorIndex("/projects/alpha")).toBe(4);
    expect(getProjectAvatarBackground("/projects/alpha")).toBe(
      "linear-gradient(to top right, #6183ec, #3b92b8)",
    );
  });
});
