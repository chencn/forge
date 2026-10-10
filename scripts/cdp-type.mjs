// 往运行中的 Forge 窗口里整段输入文本（走 CDP 的 Input.insertText，和真实打字一样进输入框）。
// 用法：node scripts/cdp-type.mjs "要输入的文本" [--enter]
const port = process.env.FORGE_CDP_PORT ?? "9222";
const args = process.argv.slice(2);
const withEnter = args.includes("--enter");
const text = args.find((a) => !a.startsWith("--"));
if (text === undefined) {
  console.error("缺少文本");
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

let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        socket.removeEventListener("message", onMessage);
        resolve(message.result ?? message);
      }
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("Input.insertText", { text });
if (withEnter) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
console.log(`typed ${text.length} 字${withEnter ? " + Enter" : ""}`);
socket.close();
