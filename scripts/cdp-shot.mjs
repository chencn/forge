// 通过 WebView2 的远程调试端口截图，用来看真实渲染结果（不依赖桌面截屏权限）。
// 用法：node scripts/cdp-shot.mjs [输出路径]
// 前置：tauri dev 需要带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222

const port = process.env.FORGE_CDP_PORT ?? "9222";
const out = process.argv[2] ?? "D:/app/soft/_download/forge-shot.png";

// WebView2 只接受 Host 为 localhost，用 127.0.0.1 会 404。
const targets = await fetch(`http://localhost:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url.includes("localhost"));
if (!page) {
  console.error("没找到页面目标，当前 targets：", targets.map((t) => `${t.type} ${t.url}`).join(" | "));
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
});

let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve) => {
    const token = ++id;
    pending.set(token, resolve);
    socket.send(JSON.stringify({ id: token, method, params }));
  });
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  }
});

await send("Page.enable", {});
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
const layout = await send("Runtime.evaluate", {
  expression: "JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, title: document.title, rail: document.querySelectorAll('.rail-button').length, rows: document.querySelectorAll('.tree-row').length, workspace: localStorage.getItem('forge.workspace'), error: document.querySelector('.error-banner p')?.textContent ?? null})",
});

const fs = await import("node:fs");
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved", out, "state", layout?.result?.value);
socket.close();
