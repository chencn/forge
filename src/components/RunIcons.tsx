import type { SVGProps } from "react";

/**
 * IDEA 运行/停止/重跑按钮用的图标。
 *
 * 形状直接取自 IntelliJ 的 `expui/run/*.svg`：三角、圆角方块、环形箭头。
 * 原图标把颜色写死在 fill/stroke 里；这里改成 `currentColor`，由按钮的
 * CSS 决定是白（实心底上）还是绿/红（无底状态），一套形状两处用。
 */

type Props = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number, props: SVGProps<SVGSVGElement>) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": true as const,
    ...props,
  };
}

/** 运行：实心三角（expui/run/run.svg 的路径，填充与描边同色）。 */
export function RunIcon({ size = 16, ...props }: Props) {
  return (
    <svg {...base(size, props)}>
      <path
        d="M13.5 7.13397C14.1667 7.51888 14.1667 8.48112 13.5 8.86602L4.5 14.0622C3.83333 14.4471 3 13.966 3 13.1962L3 2.80385C3 2.03405 3.83333 1.55292 4.5 1.93782L13.5 7.13397Z"
        fill="currentColor"
        stroke="currentColor"
      />
    </svg>
  );
}

/** 停止：圆角方块（expui/run/stop.svg）。 */
export function StopIcon({ size = 16, ...props }: Props) {
  return (
    <svg {...base(size, props)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * 重跑：环形箭头（expui/run/rerun.svg）。
 *
 * 原图标是双色——箭头绿、外圈弧线灰；这里两个 path 各带一个 class，
 * 由 CSS 决定配色：主工具栏那颗压在实心底上，两段都取 `currentColor`（白）；
 * 运行面板动作条那颗照 IDEA 原样，弧线灰、箭头绿。两处共用一套形状。
 */
export function RerunIcon({ size = 16, ...props }: Props) {
  return (
    <svg {...base(size, props)}>
      <path
        className="rerun-arrow"
        d="M10 9.50217C10 9.10959 10.4317 8.87015 10.7647 9.07801L14.7667 11.5758C15.0804 11.7716 15.0804 12.2284 14.7667 12.4242L10.7647 14.922C10.4317 15.1299 10 14.8904 10 14.4978V9.50217Z"
        fill="currentColor"
      />
      <path
        className="rerun-arc"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14 1.5C14 1.22386 13.7761 1 13.5 1C13.2239 1 13 1.22386 13 1.5V4.68235C11.9256 3.06631 10.0877 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14V13C5.23858 13 3 10.7614 3 8C3 5.23858 5.23858 3 8 3C9.63527 3 11.0878 3.78495 12.0005 5H9.5C9.22386 5 9 5.22386 9 5.5C9 5.77614 9.22386 6 9.5 6H14V1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 滚动到末尾：右侧一个向下的箭头（expui/general/scrollDown.svg）。 */
export function ScrollToEndIcon({ size = 16, ...props }: Props) {
  return (
    <svg {...base(size, props)}>
      <path
        d="M1.5 3.5H5.5M1.5 8H5.5M1.5 12.5H14.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.5 3C11.7761 3 12 3.22386 12 3.5L12 9.29291L14.1465 7.14646C14.3417 6.95119 14.6583 6.9512 14.8536 7.14646C15.0488 7.34172 15.0488 7.65831 14.8536 7.85357L11.8536 10.8536C11.6583 11.0488 11.3417 11.0488 11.1464 10.8536L8.14648 7.85356C7.95121 7.6583 7.95122 7.34172 8.14648 7.14646C8.34174 6.9512 8.65832 6.9512 8.85358 7.14646L11 9.29289L11 3.5C11 3.22386 11.2239 3 11.5 3Z"
        fill="currentColor"
      />
    </svg>
  );
}
