import { invoke } from "@tauri-apps/api/core";

interface ChatImageBytes {
  mediaType: string;
  base64: string;
}

/**
 * 把会话里的一张截图写入系统剪贴板。
 *
 * 点击当下就申请写入，字节稍后由沙箱读取补上，这样异步读盘不会丢掉用户手势。
 * 系统剪贴板只稳定接受 PNG，JPEG / GIF / WebP 先画成一张 PNG 再交出去。
 */
export function copyChatImage(path: string): Promise<void> {
  const png = invoke<ChatImageBytes>("ai_runtime_read_image", { path }).then(async (image) => {
    const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: image.mediaType });
    return image.mediaType === "image/png" ? blob : encodePng(blob);
  });
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function encodePng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("ENCODE_FAILED");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("ENCODE_FAILED");
    return png;
  } finally {
    bitmap.close();
  }
}
