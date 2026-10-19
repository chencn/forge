import { describe, expect, it } from "vitest";
import {
  formatArgs,
  formatEnvLines,
  parseArgs,
  parseEnvLines,
  profileDir,
  profileSpec,
} from "../../src/lib/termProfiles";

describe("profileDir", () => {
  it("相对路径拼在工作区根后面，分隔符跟着根走", () => {
    expect(profileDir("web/app", "D:\\repo")).toBe("D:\\repo\\web\\app");
    expect(profileDir("./web", "/home/me/repo/")).toBe("/home/me/repo/web");
  });

  it("绝对路径和空串", () => {
    expect(profileDir("C:\\tmp", "D:\\repo")).toBe("C:\\tmp");
    expect(profileDir("~/x", "/repo")).toBe("~/x");
    expect(profileDir("  ", "D:\\repo")).toBeNull();
  });
});

describe("参数与环境变量", () => {
  it("参数按空白切，双引号里的算一段", () => {
    expect(parseArgs('-NoExit -Command "Set-Location C:\\a b"')).toEqual([
      "-NoExit",
      "-Command",
      "Set-Location C:\\a b",
    ]);
    expect(formatArgs(["-x", "a b"])).toBe('-x "a b"');
  });

  it("环境变量一行一个，等号后面原样留", () => {
    expect(parseEnvLines("A=1\n\nbad\nB=x=y\nC=")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x=y" },
      { key: "C", value: "" },
    ]);
    expect(formatEnvLines([{ key: "A", value: "1" }])).toBe("A=1");
  });
});

describe("profileSpec", () => {
  it("没写 shell 用默认的；参数、环境、目录、命令都带上", () => {
    const spec = profileSpec(
      {
        id: "p1",
        name: "dev",
        shell: "",
        args: ["-NoExit"],
        env: [{ key: "NODE_ENV", value: "development" }],
        dir: "web",
        command: "npm run dev",
      },
      "D:\\repo",
      "pwsh",
    );
    expect(spec).toEqual({
      shell: "pwsh",
      dir: "D:\\repo\\web",
      profile: "p1",
      launch: { args: ["-NoExit"], env: { NODE_ENV: "development" } },
      command: "npm run dev",
    });
  });
});
