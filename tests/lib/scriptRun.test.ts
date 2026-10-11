import { describe, expect, it } from "vitest";
import { buildScriptCommand, findShellForScript, scriptKindOf, scriptTerminalLabel } from "../../src/lib/scriptRun";
import type { ShellInfo } from "../../src/lib/term";

// ShellInfo 只要 name 参与打分；type import 运行时擦除，不需要 mock term 模块。
function shell(name: string): ShellInfo {
  return { name, path: `C:\\shells\\${name}.exe`, args: [] } as ShellInfo;
}

describe("scriptKindOf 按扩展名认脚本", () => {
  it("五类都认，大小写不敏感", () => {
    expect(scriptKindOf("run.bat")).toBe("bat");
    expect(scriptKindOf("run.CMD")).toBe("cmd");
    expect(scriptKindOf("deploy.ps1")).toBe("ps1");
    expect(scriptKindOf("build.sh")).toBe("sh");
    expect(scriptKindOf("ci.bash")).toBe("bash");
  });

  it("不是脚本家族的返回 null", () => {
    expect(scriptKindOf("main.py")).toBeNull();
    expect(scriptKindOf("index.js")).toBeNull();
    expect(scriptKindOf("README")).toBeNull();
  });
});

describe("findShellForScript 按 shell_probe 的可读名打分", () => {
  it("bat/cmd 只要 cmd", () => {
    const shells = [shell("PowerShell"), shell("cmd")];
    expect(findShellForScript(shells, "bat")?.name).toBe("cmd");
    expect(findShellForScript(shells, "cmd")?.name).toBe("cmd");
  });

  it("ps1 挑版本最高的：pwsh 起步 7，带版本号的按版本算，裸 PowerShell 是 5.1", () => {
    const shells = [shell("PowerShell"), shell("PowerShell 7"), shell("pwsh"), shell("cmd")];
    // pwsh 与 PowerShell 7 同为 7 分，同分留先出现的。
    expect(findShellForScript(shells, "ps1")?.name).toBe("PowerShell 7");

    const withoutPwsh = [shell("PowerShell"), shell("PowerShell 8"), shell("cmd")];
    expect(findShellForScript(withoutPwsh, "ps1")?.name).toBe("PowerShell 8");
  });

  it("sh/bash 认 Git Bash 与 bash，同分留先出现的", () => {
    const shells = [shell("cmd"), shell("Git Bash"), shell("bash")];
    expect(findShellForScript(shells, "sh")?.name).toBe("Git Bash");
    expect(findShellForScript(shells, "bash")?.name).toBe("Git Bash");
  });

  it("一个都配不上返回 null", () => {
    expect(findShellForScript([shell("cmd")], "sh")).toBeNull();
  });

  it("缺终端时文案里的名字", () => {
    expect(scriptTerminalLabel("ps1")).toBe("PowerShell");
    expect(scriptTerminalLabel("sh")).toBe("bash");
    expect(scriptTerminalLabel("bat")).toBe("cmd");
  });
});

describe("buildScriptCommand 三类 shell 的拼装", () => {
  it("cmd：先切 /d 到脚本目录再调，路径用反斜杠", () => {
    expect(buildScriptCommand("bat", "D:/proj/scripts/go.bat", "D:/proj")).toBe(
      'cd /d "D:\\proj" && "D:\\proj\\scripts\\go.bat"'
    );
    expect(buildScriptCommand("cmd", "D:/go.cmd", "")).toBe('"D:\\go.cmd"');
  });

  it("ps1：LiteralPath 防特殊字符，单引号翻倍转义", () => {
    expect(buildScriptCommand("ps1", "D:/my 'app'/run.ps1", "D:/proj")).toBe(
      "Set-Location -LiteralPath 'D:\\proj'; & 'D:\\my ''app''\\run.ps1'"
    );
  });

  it("sh/bash：路径换正斜杠，POSIX 单引号转义成 '\\''", () => {
    expect(buildScriptCommand("sh", "D:/proj/run.sh", "D:/proj")).toBe(
      "cd 'D:/proj' && bash 'D:/proj/run.sh'"
    );
    expect(buildScriptCommand("bash", "D:/it's/run.sh", "")).toBe("bash 'D:/it'\\''s/run.sh'");
  });
});
