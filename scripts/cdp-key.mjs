// 向运行中的 Forge 窗口发一次按键（含修饰键），用来验证实在的快捷键绑定。
// 用法：node scripts/cdp-key.mjs "Ctrl+Shift+A"
const port = process.env.FORGE_CDP_PORT ?? "9222";
const spec = process.argv[2];
if (!spec) {
  console.error('缺少按键，例如 "Ctrl+Shift+A"');
  process.exit(1);
}

const MOD_BITS = { ctrl: 2, alt: 1, meta: 4, cmd: 4, shift: 8 };
const VK = {
  Enter: 13, Escape: 27, Esc: 27, Backspace: 8, Tab: 9, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
  Minus: 189, Equal: 187, Slash: 191,
};

let modifiers = 0;
let keyToken = "";
for (const raw of spec.split("+")) {
  const token = raw.trim();
  const bit = MOD_BITS[token.toLowerCase()];
  if (bit !== undefined) modifiers |= bit;
  else keyToken = token;
}

const lower = keyToken.toLowerCase();
let code = lower;
let text;
if (/^[a-z]$/.test(lower)) code = "Key" + lower.toUpperCase();
else if (/^[0-9]$/.test(lower)) code = "Digit" + lower;
else if (/^f([1-9]|1[0-2])$/.test(lower)) code = lower.toUpperCase();
else if (lower === "space") code = "Space";
else if (lower === "-") code = "Minus";
else if (lower === "=") code = "Equal";
else if (lower === "/") code = "Slash";
else code = lower[0].toUpperCase() + lower.slice(1);

// 中间档不给 0 兜底：`?? 0` 会让后面的分支永远走不到，字母键的 vk 全是 0，
// 浏览器认不出按的是哪个键，monaco 的键位匹配（CtrlCmd|KeyS 这类）永远不会触发。
const keyCode =
  VK[code] ??
  (/^F([1-9]|1[0-2])$/.test(code) ? 111 + Number(code.slice(1)) : undefined) ??
  (code.startsWith("Key") ? code.charCodeAt(3) : undefined) ??
  (code.startsWith("Digit") ? 48 + Number(code.slice(5)) : undefined) ??
  0;
if (code.startsWith("Digit")) text = code.slice(5);
else if (code.startsWith("Key")) text = code.slice(3).toLowerCase();

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

const base = { key: text ?? code, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
// 只发 rawKeyDown/keyUp 不会产生 DOM 的 input 事件，monaco 的 textarea 收不到字符；
// CDP 里往输入框落字的那一档叫 char（keyPress 不是合法类型，发了被浏览器丢掉）。
if (text && modifiers === 0) await send("Input.dispatchKeyEvent", { type: "char", text, ...base });
await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
console.log(`sent ${spec} → code=${code} vk=${keyCode} modifiers=${modifiers}`);
socket.close();
