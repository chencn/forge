import { describe, expect, it } from "vitest";
import { detectJavaFileIconKind, type JavaFileIconKind } from "../../src/lib/javaFileKind";

describe("Java 文件图标按顶层声明区分", () => {
  const cases: Array<{ fileName: string; source: string; expected: JavaFileIconKind }> = [
    { fileName: "Example.java", source: "public class Example {}", expected: "java.class" },
    { fileName: "Example.java", source: "public interface Example {}", expected: "java.interface" },
    { fileName: "Example.java", source: "public enum Example { VALUE }", expected: "java.enum" },
    { fileName: "Example.java", source: "public @interface Example {}", expected: "java.annotation" },
    { fileName: "Example.java", source: "public record Example(String value) {}", expected: "java.record" },
    {
      fileName: "Example.java",
      source: "public class Example extends java.lang.RuntimeException {}",
      expected: "java.exception",
    },
  ];

  it.each(cases)("$fileName → $expected", ({ fileName, source, expected }) => {
    expect(detectJavaFileIconKind(fileName, source)).toBe(expected);
  });

  it("注释、字符串、文本块和嵌套类型不算", () => {
    const source = `
      // class Example {}
      class Container {
        String text = "interface Example {}";
        String block = """enum Example { VALUE }""";
        class Example {}
      }
    `;
    expect(detectJavaFileIconKind("Example.java", source)).toBeNull();
  });

  it("取和文件名同名的那条顶层声明", () => {
    expect(detectJavaFileIconKind("Example.java", "class Helper {}\npublic interface Example {}")).toBe(
      "java.interface",
    );
  });

  it("文件名像异常、或者只是泛型边界，仍按类", () => {
    expect(
      detectJavaFileIconKind("ExampleException.java", "class ExampleException extends DomainFailure {}"),
    ).toBe("java.class");
    expect(detectJavaFileIconKind("Other.java", "class Example {}")).toBeNull();
    expect(detectJavaFileIconKind("Example.java", "class Example<T extends Exception> {}")).toBe("java.class");
    expect(
      detectJavaFileIconKind(
        "Example.java",
        "class Example<T extends Comparable<T>> extends RuntimeException {}",
      ),
    ).toBe("java.exception");
  });
});
