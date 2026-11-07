/**
 * 设计令牌颜色的格式归一与计算。
 *
 * 设计令牌读回来还是 CSS 里那串写法（`rgb(…)`，或生产构建压缩后的 `#fff`），
 * 终端主题只按 `#RRGGBB` / `#RRGGBBAA` 配色，先统一过来。
 */

/**
 * 把 CSS 颜色写法归一成 `#RRGGBB[AA]` 十六进制。
 *
 * @param color - CSS 颜色文本；支持 `rgb()` / `rgba()`（含百分比写法）与三位/四位简写
 * @returns 归一后的十六进制颜色；无法识别时原样返回
 * @remarks 三位/四位简写（`#fff` / `#fff8`）展开成六位/八位——CSS 压缩会把 `#ffffff`
 *          压成 `#fff`，留着简写就各处自己解释一遍
 */
function toHex(color: string): string {
  const shorthand = /^#([0-9a-fA-F]{3,4})$/.exec(color);
  if (shorthand) {
    const digits = shorthand[1];
    return `#${digits
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (!match) return color;
  const [r, g, b, a] = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((part) => Number(part));
  if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) {
    return color;
  }
  const byte = (value: number) =>
    Math.round(Math.max(0, Math.min(255, value)))
      .toString(16)
      .padStart(2, "0");
  // 百分比写法（rgb(50% 50% / 20%)）里的 alpha 也可能带 %。
  const alpha = a === undefined || Number.isNaN(a) ? "" : byte((a > 1 ? a / 100 : a) * 255);
  return `#${byte(r)}${byte(g)}${byte(b)}${alpha}`;
}

/**
 * 读一个颜色令牌的取值并归一格式。
 *
 * @param name - CSS 自定义属性名（如 `--accent`）
 * @returns `#RRGGBB[AA]` 颜色文本；令牌未定义时返回空串原样透传的结果
 */
export function tokenColor(name: string): string {
  return toHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}

/**
 * 把一个设计令牌算成浏览器认账的具体颜色。
 *
 * @param name - CSS 自定义属性名
 * @returns 求值后的 CSS 颜色文本；求不出时返回 null
 * @remarks 供 CSS 之外的消费者用（Mermaid、原生窗口）。令牌可能写成 `var(--别的令牌)`
 *          或 `color-mix(...)`：`getPropertyValue` 读回来还是那串未求值的记号，直接喂给
 *          Mermaid 就成了废值。这种写法先挂一个隐藏探针，让浏览器按 `color` 属性算完
 *          再读回来——算色这件事只有引擎自己靠得住。
 */
export function computedColor(name: string): string | null {
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(raw)) return raw;
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.color = `var(${name})`;
  root.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || null;
}
