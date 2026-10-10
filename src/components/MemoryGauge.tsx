import { useEffect, useRef, useState } from "react";
import Popover from "./Popover";
import { sysMemory } from "../lib/sys";
import type { Memory, MemoryPart } from "../lib/sys";
import { useI18n } from "../i18n";

/** 状态栏右下角的内存读数刷新间隔。 */
const POLL_MS = 5000;

/**
 * 状态栏那格内存。
 *
 * 单独成一个组件是必须的：读数每 5 秒换一个新对象，放在 App 里就是每 5 秒整棵 IDE 树
 * 重渲染一次，而真正要看的只有这一格。
 */
export default function MemoryGauge() {
  const { t } = useI18n();
  const [memory, setMemory] = useState<Memory | null>(null);
  /** 浮层展开。悬停 */
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef(0);

  useEffect(() => {
    let alive = true;
    const read = () => {
      sysMemory()
        .then((next) => {
          if (alive) setMemory(next);
        })
        .catch(() => {
          // 纯浏览器预览时没有这个命令，读数不画。
        });
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 与旁边语言服务那格同一套：指针从这一格挪进浮层要穿过 4px 间隙，穿过的一瞬间会算「离开」，
  // 所以收起延后一拍，别让浮层闪掉。浮层在 DOM 上是这一格的子孙，停在浮层里不算离开。
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /** 一档一行：宿主与 WebView 走词条，其余按可执行文件名，多于一台带 ×N。 */
  const label = (part: MemoryPart) => {
    const base =
      part.kind === "host"
        ? t("status.memory.host")
        : part.kind === "webview"
          ? t("status.memory.webview")
          : part.program;
    return part.count > 1 ? `${base} ×${part.count}` : base;
  };

  if (!memory || memory.totalMb <= 0) return null;

  return (
    <span
      className="status-memory"
      ref={anchor}
      aria-label={t("status.memory")}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {memory.appMb}/{memory.totalMb}M
      {open ? (
        <Popover anchor={anchor.current} onClose={hide} minWidth={230} modal={false}>
          <div className="popover-label">{t("status.memory")}</div>
          {memory.parts.map((part) => (
            <div className="memory-row" key={`${part.kind}|${part.program}`}>
              <span className="popover-item-label">{label(part)}</span>
              <span className="memory-mb">{part.mb} MB</span>
            </div>
          ))}
          <div className="popover-sep" />
          <div className="memory-row">
            <span className="popover-item-label">
              {t("status.memory.total", {
                count: memory.parts.reduce((sum, part) => sum + part.count, 0),
              })}
            </span>
            <span className="memory-mb">{memory.appMb} MB</span>
          </div>
        </Popover>
      ) : null}
    </span>
  );
}
