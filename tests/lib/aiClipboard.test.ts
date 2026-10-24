import { describe, expect, it } from "vitest";
import { collectPastedImages } from "../../src/lib/aiClipboard";

function imageFile(overrides: Partial<{ name: string; size: number; type: string; lastModified: number }> = {}): File {
  const { name = "image.png", size = 1024, type = "image/png", lastModified = 1700000000000 } = overrides;
  const file = new File(["x".repeat(size)], name, { type, lastModified });
  // jsdom 的 File 不一定回填 lastModified，直接钉住以保证指纹稳定。
  Object.defineProperty(file, "lastModified", { value: lastModified });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function dataTransfer(files: File[], items: File[]) {
  return {
    files: [...files],
    items: items.map((file) => ({ kind: "file", getAsFile: () => file })),
  } as unknown as DataTransfer;
}

describe("collectPastedImages", () => {
  it("merges the files/items double feed of one clipboard image into a single attachment", () => {
    // WebView2 对同一张图两路给不同 name：按 name 去重会漏，粘贴出现两张一样的图。
    const data = dataTransfer([imageFile({ name: "image.png" })], [imageFile({ name: "" })]);
    expect(collectPastedImages(data)).toHaveLength(1);
  });

  it("keeps two genuinely different images in one paste", () => {
    const data = dataTransfer(
      [imageFile({ name: "a.png", size: 100, lastModified: 1 }), imageFile({ name: "b.png", size: 200, lastModified: 2 })],
      [imageFile({ name: "a.png", size: 100, lastModified: 1 }), imageFile({ name: "b.png", size: 200, lastModified: 2 })],
    );
    expect(collectPastedImages(data)).toHaveLength(2);
  });

  it("falls back to items when files is empty (some WebView2 sources only fill items)", () => {
    const data = dataTransfer([], [imageFile()]);
    expect(collectPastedImages(data)).toHaveLength(1);
  });

  it("ignores non-image entries and empty clipboards", () => {
    const text = new File(["hello"], "note.txt", { type: "text/plain" });
    const data = dataTransfer([text], [text]);
    expect(collectPastedImages(data)).toHaveLength(0);
    expect(collectPastedImages(null)).toHaveLength(0);
  });
});
