// 用 CDP 的 Input.dispatchMouseEvent 发一次真实点击，浏览器自己合成 contextmenu。
// 用法：node scripts/cdp-rightclick.mjs <css 选择器> [--left] [--press | --release]
// --left 发左键（用来把焦点真放进编辑器）；--press 只按下不松开：松开的事件会被菜单的
// 「点外面就关」逻辑立刻吃掉，量完再用 --release 收尾。
const port = process.env.FORGE_CDP_PORT ?? "9222";
const left = process.argv.includes("--left");
const pressOnly = process.argv.includes("--press");
const releaseOnly = process.argv.includes("--release");
const selector = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
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

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  return result?.result?.value ?? result?.exceptionDetails?.text ?? result;
};

const point = await evaluate(
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return JSON.stringify({ x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 40) }); })()`
);
if (!point) {
  console.error("NO_MATCH " + selector);
  process.exit(1);
}
const { x, y } = JSON.parse(point);

const button = left ? "left" : "right";
if (!releaseOnly) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
}
if (!pressOnly) {
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
}
console.log(`${releaseOnly ? "released" : pressOnly ? "pressed" : "clicked"} ${selector} at ${Math.round(x)},${Math.round(y)} with ${button}`);
socket.close();
