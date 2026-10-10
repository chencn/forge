// 读取运行中窗口的控制台输出，用来看真实报错（不依赖桌面截屏权限）。
// 用法：node scripts/cdp-console.mjs [端口]
const port = process.argv[2] ?? process.env.FORGE_CDP_PORT ?? "9222";

const targets = await fetch(`http://localhost:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url.includes("localhost"));
if (!page) {
  console.error("no page target");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
});

const pending = new Map();
let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const token = ++id;
    pending.set(token, resolve);
    socket.send(JSON.stringify({ id: token, method, params }));
  });

const lines = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.type)
      .join(" ");
    lines.push(`${message.params.type}: ${text}`);
  }
  if (message.method === "Runtime.exceptionThrown") {
    const detail = message.params.exceptionDetails;
    lines.push(`exception: ${detail.exception?.description ?? detail.text}`);
  }
  if (message.method === "Log.entryAdded") {
    lines.push(`${message.params.entry.level}: ${message.params.entry.text}`);
  }
});

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.reload");
await new Promise((resolve) => setTimeout(resolve, 4000));
console.log(lines.length ? lines.join("\n") : "(no console output)");
socket.close();
