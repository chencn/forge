import { useEffect, useRef } from "react";
import { getProjectAvatarBackground, getProjectAvatarInitials, getProjectGradientColorIndex } from "../lib/projectAvatar";

interface ProjectAvatarProps {
  name: string;
  path: string;
  /** 边长。顶栏那颗是 20。 */
  size?: number;
  /** 顶栏这颗负责把渐变的高点对准自己。 */
  anchorGradient?: boolean;
}

/**
 * 项目两字头像。圆角是边长的 0.2，字号是边长的 13/20。
 */
export default function ProjectAvatar({
  name,
  path,
  size = 20,
  anchorGradient = false,
}: ProjectAvatarProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (!anchorGradient) return;
    root.setAttribute("data-project-color", String(getProjectGradientColorIndex(path)));
    const node = ref.current;
    if (!node) {
      return () => root.removeAttribute("data-project-color");
    }

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0) return;
        root.style.setProperty(
          "--project-gradient-x",
          `${Math.round(rect.left + rect.width / 2)}px`,
        );
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      root.removeAttribute("data-project-color");
      root.style.removeProperty("--project-gradient-x");
    };
  }, [anchorGradient, path]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="project-avatar"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.2,
        background: getProjectAvatarBackground(path),
        fontSize: Math.max(8, Math.floor((13 * size) / 20)),
      }}
    >
      {getProjectAvatarInitials(name)}
    </span>
  );
}
