import { describe, expect, it } from "vitest";
import { collapsePackageDirs, isPackageSegment, isUnderJvmSourceRoot } from "../../src/lib/jvm";

describe("isPackageSegment 合法包名段", () => {
  it("标识符规则：字母/下划线/$ 开头", () => {
    expect(isPackageSegment("com")).toBe(true);
    expect(isPackageSegment("_internal")).toBe(true);
    expect(isPackageSegment("$gen")).toBe(true);
    expect(isPackageSegment("v2")).toBe(true);
    expect(isPackageSegment("2ch")).toBe(false);
    expect(isPackageSegment("my-pkg")).toBe(false);
    expect(isPackageSegment("")).toBe(false);
  });
});

describe("isUnderJvmSourceRoot 源码根识别", () => {
  it("标准 Maven/Gradle 布局认得出，两种分隔符都行", () => {
    expect(isUnderJvmSourceRoot("D:/proj/src/main/java/com/example")).toBe(true);
    expect(isUnderJvmSourceRoot("D:\\proj\\src\\test\\kotlin\\App")).toBe(true);
  });

  it("多模块与 Kotlin/Groovy/Scala 同样覆盖", () => {
    expect(isUnderJvmSourceRoot("backend/src/main/java/com/example")).toBe(true);
    expect(isUnderJvmSourceRoot("app/src/main/groovy/x")).toBe(true);
  });

  it("源码根本身不算 under（它是包链的硬边界）", () => {
    expect(isUnderJvmSourceRoot("D:/proj/src/main/java")).toBe(false);
  });

  it("非 JVM 布局与未知语言不认", () => {
    expect(isUnderJvmSourceRoot("D:/proj/src/assets/img")).toBe(false);
    expect(isUnderJvmSourceRoot("D:/proj/src/main/rust")).toBe(false);
    expect(isUnderJvmSourceRoot("D:/proj/lib/main/java")).toBe(false);
  });
});

interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: string[];
}

function node(name: string, path: string, dirs: DirNode[] = [], files: string[] = []): DirNode {
  return { name, path, dirs, files };
}

describe("collapsePackageDirs 目录链压缩", () => {
  it("源码根之下用点连接，源码根本身是硬边界不并入", () => {
    // java 不与 com 黏成 java/com；com/example/demo 处在包链内部，用点连。
    const tree = node("proj", "D:/proj", [
      node("src", "D:/proj/src", [
        node("main", "D:/proj/src/main", [
          node("java", "D:/proj/src/main/java", [
            node("com", "D:/proj/src/main/java/com", [
              node("example", "D:/proj/src/main/java/com/example", [
                node("demo", "D:/proj/src/main/java/com/example/demo"),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]);
    // 返回值是压缩后的链末端：proj→src→main 逐级改名后，停在源码根 java 上。
    const collapsed = collapsePackageDirs(tree);
    // 源码根本身是硬边界，链从它这里重新起。
    expect(collapsed.name).toBe("proj/src/main/java");
    // java 之下是包链内部，点连接。
    const demo = collapsed.dirs[0];
    expect(demo.name).toBe("com.example.demo");
  });

  it("非包名段（如版本目录）回退用斜杠连接", () => {
    // com 之下放一个非法包名段：child 不是标识符时连接符回退为斜杠。
    const tree = node("proj", "D:/proj", [
      node("src", "D:/proj/src", [
        node("main", "D:/proj/src/main", [
          node("java", "D:/proj/src/main/java", [
            node("com", "D:/proj/src/main/java/com", [
              node("my-dir", "D:/proj/src/main/java/com/my-dir"),
            ]),
          ]),
        ]),
      ]),
    ]);
    const java = collapsePackageDirs(tree);
    expect(java.dirs[0].name).toBe("com/my-dir");
  });

  it("非 JVM 目录照常按斜杠压缩", () => {
    const tree = node("proj", "D:/proj", [
      node("a", "D:/proj/a", [node("b", "D:/proj/a/b", [node("c", "D:/proj/a/b/c")])]),
    ]);
    // 返回链末端，名字从根开始累计。
    const collapsed = collapsePackageDirs(tree);
    expect(collapsed.name).toBe("proj/a/b/c");
  });

  it("有文件或有分叉的目录停住不吞", () => {
    const tree = node("proj", "D:/proj", [
      node("a", "D:/proj/a", [node("b", "D:/proj/a/b"), node("c", "D:/proj/a/c")], []),
      node("d", "D:/proj/d", [], ["readme.md"]),
    ]);
    const collapsed = collapsePackageDirs(tree);
    // 有两个子目录，proj 不压缩。
    expect(collapsed.name).toBe("proj");
    // a 本身也是分叉（b、c 两子目录），不压缩；b、c 是叶子，名字不变。
    expect(collapsed.dirs[0].name).toBe("a");
    expect(collapsed.dirs[0].dirs.map((child) => child.name)).toEqual(["b", "c"]);
    // 自己有文件不压缩。
    expect(collapsed.dirs[1].name).toBe("d");
  });
});
