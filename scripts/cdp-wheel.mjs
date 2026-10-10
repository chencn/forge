// 在 Forge 窗口里发一次真实的滚轮输入（CDP Input.dispatchMouseEvent / mouseWheel）。
// 用法：node scripts/cdp-wheel.mjs <css选择器> <deltaY>
const port = process.env.FORGE_CDP_PORT ?? "9222";
const selector = process.argv[2];
const deltaY = Number(process.argv[3] ?? "-300");
if (!selector) {
  console.error("缺少选择器");
  process.exit(1);
}

const targets = await fetch(`http://localhost:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("localhost"));
if (!page) {
  console.error("没有页面目标");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    socket.send(JSON.stringify({ id: next, method, params }));
  });

const box = await send("Runtime.evaluate", {
  expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2}); })()`,
  returnByValue: true,
});
const raw = box.result?.result?.value;
if (!raw) {
  console.error("NO_MATCH");
  process.exit(1);
}
const { x, y } = JSON.parse(raw);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
for (let i = 0; i < 3; i++) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY,
    button: "none",
    clickCount: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
}
console.log(`wheel ${deltaY} @ ${Math.round(x)},${Math.round(y)} on ${selector}`);
socket.close();
