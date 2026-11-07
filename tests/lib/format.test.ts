import { describe, expect, it } from "vitest";
import { basenameOf, isWindowsPath, joinPath, nativeSeparators, parentPath, patchStem, pathWithin, relativePathFrom, resolvePath, resolveRelative, samePath, separator } from "../../src/lib/format";

describe("isWindowsPath / separator", () => {
  it("盘符与 UNC 算 Windows 形状，反斜杠正斜杠都认", () => {
    expect(isWindowsPath("D:\\a")).toBe(true);
    expect(isWindowsPath("D:/a")).toBe(true);
    expect(isWindowsPath("\\\\server\\share")).toBe(true);
    expect(isWindowsPath("/usr/local")).toBe(false);
    expect(separator("D:/a")).toBe("\\");
    expect(separator("/usr/local")).toBe("/");
  });
});

describe("samePath 路径相等判定", () => {
  it("Windows 形状统一分隔符并忽略大小写", () => {
    // 监听事件给的是系统原样写法，前端自己拼的是另一种，必须能对上。
    expect(samePath("D:\\a\\B.ts", "D:/a/b.ts")).toBe(true);
    expect(samePath("D:/a/b/", "D:/a/b")).toBe(true);
    expect(samePath("d:\\x", "D:\\x")).toBe(true);
  });

  it("POSIX 形状大小写敏感，只去末尾斜杠", () => {
    expect(samePath("/tmp/a", "/tmp/a/")).toBe(true);
    expect(samePath("/tmp/a", "/TMP/a")).toBe(false);
  });

  it("两种家族不混判", () => {
    expect(samePath("D:/a", "/a")).toBe(false);
  });
});

describe("joinPath / nativeSeparators", () => {
  it("按根的风格拼接，根自带分隔符不重复", () => {
    expect(joinPath("D:\\x", "y\\z")).toBe("D:\\x\\y\\z");
    expect(joinPath("C:\\", "a")).toBe("C:\\a");
    expect(joinPath("/tmp", "a")).toBe("/tmp/a");
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("d:/app/code/forge/src-tauri", "binaries")).toBe("d:\\app\\code\\forge\\src-tauri\\binaries");
    expect(joinPath("C:/", "src/main.rs")).toBe("C:\\src\\main.rs");
    expect(joinPath("//server/share/", "src/a.ts")).toBe("\\\\server\\share\\src\\a.ts");
  });

  it("git 回的正斜杠根归一成系统写法", () => {
    expect(nativeSeparators("D:/app/x")).toBe("D:\\app\\x");
    expect(nativeSeparators("/usr/local")).toBe("/usr/local");
  });
});

describe("parentPath", () => {
  it("逐级上退，盘符根与文件系统根返回 null", () => {
    expect(parentPath("D:\\a\\b")).toBe("D:\\a");
    expect(parentPath("D:\\a")).toBe("D:\\");
    expect(parentPath("D:\\")).toBeNull();
    expect(parentPath("/tmp/a")).toBe("/tmp");
    expect(parentPath("/")).toBeNull();
  });

  it("UNC 共享根是上退边界，子目录逐级返回且不产生自循环", () => {
    expect(parentPath("\\\\server\\share\\src\\a.ts")).toBe("\\\\server\\share\\src");
    expect(parentPath("//server/share/src/")).toBe("\\\\server\\share");
    expect(parentPath("\\\\server\\share")).toBeNull();
    expect(parentPath("//server/share/")).toBeNull();
    expect(resolveRelative("\\\\server\\share\\src", "../../../a.ts")).toBe("\\\\server\\share\\a.ts");
  });
});

describe("basenameOf / resolveRelative", () => {
  it("取最后一级名，盘符根原样返回", () => {
    expect(basenameOf("D:\\a\\b.txt")).toBe("b.txt");
    expect(basenameOf("/tmp/a")).toBe("a");
    expect(basenameOf("C:\\")).toBe("C:\\");
  });

  it("相对路径落成绝对路径，越出根时停在根上", () => {
    expect(resolveRelative("D:\\doc", "img/pic.png")).toBe("D:\\doc\\img\\pic.png");
    expect(resolveRelative("D:\\doc", "../shared/x.md")).toBe("D:\\shared\\x.md");
    // 根的上一级没有：停在根，不越出去。
    expect(resolveRelative("D:\\", "../x")).toBe("D:\\x");
    expect(resolveRelative("C:\\", ".")).toBe("C:\\");
    expect(resolveRelative("/", "..")).toBe("/");
  });
});

describe("patchStem 补丁主名", () => {
  it("普通文件去掉最后一段扩展名", () => {
    expect(patchStem("src/format.js")).toBe("format");
    expect(patchStem("CHANGELOG.md")).toBe("CHANGELOG");
    expect(patchStem("a.tar.gz")).toBe("a.tar");
  });

  it("点开头没有主名的文件退回整个名字，不写出以连字符开头的补丁名", () => {
    // 「.gitignore-worktree.patch」才对；退化成「-worktree.patch」等于把文件名整个吃掉。
    expect(patchStem(".gitignore")).toBe(".gitignore");
    expect(patchStem(".env")).toBe(".env");
    expect(patchStem("Dockerfile")).toBe("Dockerfile");
  });
});

describe("pathWithin 与跨平台路径包含契约", () => {
  it("Linux / POSIX 根目录 / 正确包含下级子路径，不被剥离为空串", () => {
    expect(pathWithin("/", "/var/log")).toBe(true);
    expect(pathWithin("/", "/")).toBe(true);
    expect(pathWithin("/var/log", "/var/log/app.log")).toBe(true);
    expect(pathWithin("/var/log", "/var/run")).toBe(false);
  });

  it("Windows 盘符与 UNC 共享路径大小写不敏感包含与相等", () => {
    expect(pathWithin("D:\\app", "d:/app/src/index.ts")).toBe(true);
    expect(pathWithin("\\\\Server\\Share", "\\\\server\\share\\docs")).toBe(true);
    expect(samePath("\\\\Server\\Share\\A.txt", "\\\\server\\share\\a.txt")).toBe(true);
  });
});

describe("相对路径与运行工作目录", () => {
  it("Windows 比较忽略大小写和分隔符，复制的文件名保留大小写", () => {
    expect(relativePathFrom("D:/Project", "d:\\project\\src\\App.tsx")).toBe("src/App.tsx");
    expect(relativePathFrom("D:/Project/", "D:/project")).toBe("");
    expect(relativePathFrom("C:/", "c:\\Src\\App.tsx")).toBe("Src/App.tsx");
    expect(relativePathFrom("C:/", "c:/")).toBe("");
    expect(relativePathFrom("\\\\Server\\Share", "//server/share/src/a.ts")).toBe("src/a.ts");
  });

  it("严格按目录边界判断，POSIX 仍区分大小写", () => {
    expect(relativePathFrom("D:/project", "D:/project-other/src/a.ts")).toBeNull();
    expect(relativePathFrom("D:/project", "E:/project/a.ts")).toBeNull();
    expect(relativePathFrom("/project", "/Project/a.ts")).toBeNull();
    expect(relativePathFrom("/", "/usr/src/a.ts")).toBe("usr/src/a.ts");
  });

  it("绝对工作目录不重复拼根，相对目录按工程根展开", () => {
    expect(resolvePath("D:/repo", "E:/other")).toBe("E:/other");
    expect(resolvePath("D:/repo", "\\\\server\\share\\work")).toBe("\\\\server\\share\\work");
    expect(resolvePath("D:/repo", "src/app")).toBe("D:\\repo\\src\\app");
    expect(resolvePath("/repo", "/other")).toBe("/other");
  });
});
