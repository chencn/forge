import { describe, expect, it } from "vitest";
import { uniqueName } from "../../src/lib/fileNames";

describe("uniqueName", () => {
  it("keeps a free name and adds the copy suffix before the extension", () => {
    expect(uniqueName("notes.txt", ["readme.md"])).toBe("notes.txt");
    expect(uniqueName("notes.txt", ["notes.txt"])).toBe("notes copy.txt");
    expect(uniqueName("notes.txt", ["notes.txt", "notes copy.txt"])).toBe("notes copy 2.txt");
  });

  it("compares sibling names case-insensitively and handles dotfiles", () => {
    expect(uniqueName("README", ["readme"])).toBe("README copy");
    expect(uniqueName(".env", [".env", ".env copy"])).toBe(".env copy 2");
  });
});
