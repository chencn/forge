import { describe, expect, it, vi } from "vitest";
import { missingTool, newShellConfig, resolveCommand, usedPlaceholders } from "../../src/lib/runConfigs";
import type { RunTools } from "../../src/lib/runConfigs";

// 纯函数测试，mock 掉模块顶层的 IPC 依赖。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const tools: RunTools = {
  maven: "C:\\tools maven\\mvn.cmd",
  gradle: "C:\\tools\\gradle.bat",
  java: "C:\\jdk\\bin\\java.exe",
  javaFeature: 21,
};

describe("resolveCommand 占位展开", () => {
  it("三个占位都展开成本机路径", () => {
    expect(resolveCommand("${mvn} -f pom.xml package", tools)).toBe(
      '"C:\\tools maven\\mvn.cmd" -f pom.xml package'
    );
    expect(resolveCommand("${gradle} run", tools)).toBe("C:\\tools\\gradle.bat run");
    expect(resolveCommand("${java} -jar app.jar", tools)).toBe("C:\\jdk\\bin\\java.exe -jar app.jar");
  });

  it("带空格或 cmd 保留字符的路径要裹引号，干净的不用", () => {
    // 与后端 needs_quote 同一把尺子：空格、&、括号、% 等都算。
    expect(resolveCommand("${mvn} clean", tools)).toBe('"C:\\tools maven\\mvn.cmd" clean');
    const cleanTools: RunTools = { ...tools, maven: "C:\\mvn.cmd" };
    expect(resolveCommand("${mvn} clean", cleanTools)).toBe("C:\\mvn.cmd clean");
  });

  it("没有占位的命令原样返回", () => {
    expect(resolveCommand("npm run dev", tools)).toBe("npm run dev");
  });
});

describe("missingTool 缺哪个工具说得出来", () => {
  it("命令用到的占位对应的工具不在就报那个占位", () => {
    expect(missingTool("${mvn} package", { ...tools, maven: "" })).toBe("${mvn}");
    // 两个都缺时报定义顺序里的第一个（usedPlaceholders 按 TOOL_PLACEHOLDERS 的次序）。
    expect(missingTool("${java} ${mvn}", { ...tools, java: "", maven: "" })).toBe("${mvn}");
  });

  it("工具都在或命令不用占位时返回 null", () => {
    expect(missingTool("${gradle} run", tools)).toBeNull();
    expect(missingTool("go run .", tools)).toBeNull();
  });
});

describe("usedPlaceholders", () => {
  it("按命令里实际出现的占位返回，保持定义顺序", () => {
    expect(usedPlaceholders("${java} -cp ${mvn}")).toEqual(["${mvn}", "${java}"]);
    expect(usedPlaceholders("npm run dev")).toEqual([]);
  });
});

describe("newShellConfig 自定义配置的形状", () => {
  it("用户建的配置不是 generated，没有占位与辅助文件", () => {
    const config = newShellConfig("shell-1", "我的任务");
    expect(config).toMatchObject({
      id: "shell-1",
      name: "我的任务",
      kind: "shell",
      command: "",
      workingDir: "",
      env: [],
      generated: false,
      pinned: false,
      unavailable: null,
      helper: null,
    });
  });
});


