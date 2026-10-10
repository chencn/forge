/**
 * monaco 与 xterm 的配色只认 `#RRGGBB` / `#RRGGBBAA`，别的写法都要先规整过来。
 *
 * 两种输入：
 * - `rgb()` / `rgba()` 换算成十六进制（含百分比写法）。
 * - 三位 / 四位简写（`#fff` / `#fff8`）展开成六位 / 八位。生产构建的 CSS 压缩会把
 *   `#ffffff` 压成 `#fff`，而 monaco 的颜色表只匹配六位，喂简写进去会**抛异常**
 *   （`Illegal value for token color`），一路冒到 `setTheme` 之外，把整棵界面掀掉。
 */
export function toHex(color: string): string {
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

/** 读一个颜色令牌，顺带换算格式。 */
export function tokenColor(name: string): string {
  return toHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}
