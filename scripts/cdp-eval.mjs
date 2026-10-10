// 在运行中的 Forge 窗口里执行表达式，用来确认界面真实状态（配合 tauri dev 的 CDP 端口）。
// 用法：node scripts/cdp-eval.mjs "document.querySelector('.crumbs').textContent"
//       node scripts/cdp-eval.mjs --click '.side-nav-item:nth-child(1)'

const port = process.env.FORGE_CDP_PORT ?? "9222";
const isClick = process.argv[2] === "--click";
const arg = isClick ? process.argv[3] : process.argv[2];
if (!arg) {
  console.error("缺少表达式");
  process.exit(1);
}

const expression = isClick
  ? `(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return "NO_MATCH"; el.click(); return "CLICKED " + (el.textContent || el.tagName).trim().slice(0, 40); })()`
  : arg;

// WebView2 只接受 Host 为 localhost。
const targets = await fetch(`http://localhost:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url.includes("localhost"));
if (!page) {
  console.error("没有页面目标；确认 tauri dev 带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
});

const result = await new Promise((resolve) => {
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) resolve(message.result ?? message);
  });
});

const value = result?.result?.value ?? result?.exceptionDetails?.text ?? result;
console.log(typeof value === "string" ? value : JSON.stringify(value));
socket.close();
