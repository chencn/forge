/**
 * 带有 JetBrains IDE 风格的拖拽分栏分割条组件。
 * 1px 精准发丝线分割、无缝的 6px 扩展点击区域、键盘可访问微调以及双击居中复位。
 */
import {
  createContext,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import styles from "./Splitter.module.css";

export type SplitDirection = "horizontal" | "vertical";

interface SplitContextValue {
  direction: SplitDirection;
  onDragDelta: (handleIndex: number, deltaRatio: number) => void;
  onReset: (handleIndex: number) => void;
}

const SplitContext = createContext<SplitContextValue | null>(null);

export interface SplitGroupProps {
  direction?: SplitDirection;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function SplitGroup({
  direction = "horizontal",
  children,
  className,
  style,
}: SplitGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  const onDragDelta = (_handleIndex: number, _delta: number) => {
    // 基础布局扩展钩子
  };

  const onReset = (_handleIndex: number) => {
    // 双击复位钩子
  };

  return (
    <SplitContext.Provider value={{ direction, onDragDelta, onReset }}>
      <div
        ref={groupRef}
        className={clsx(
          styles.group,
          direction === "horizontal" ? styles.horizontal : styles.vertical,
          className
        )}
        style={style}
      >
        {children}
      </div>
    </SplitContext.Provider>
  );
}

export interface SplitPanelProps {
  size?: number | string;
  minSize?: number | string;
  maxSize?: number | string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function SplitPanel({
  size,
  minSize,
  maxSize,
  children,
  className,
  style,
}: SplitPanelProps) {
  const inlineStyle: CSSProperties = {
    ...style,
    flex: size !== undefined ? `0 0 ${typeof size === "number" ? `${size}px` : size}` : "1 1 0",
    minWidth: minSize !== undefined ? (typeof minSize === "number" ? `${minSize}px` : minSize) : undefined,
    maxWidth: maxSize !== undefined ? (typeof maxSize === "number" ? `${maxSize}px` : maxSize) : undefined,
  };

  return (
    <div className={clsx(styles.panel, className)} style={inlineStyle}>
      {children}
    </div>
  );
}

export interface SplitHandleProps {
  /** 是否绘制 1px 发丝线，false 时仅保留隐形交互热区 */
  hairline?: boolean;
  onDelta?: (deltaPx: number) => void;
  onReset?: () => void;
  className?: string;
  "aria-label"?: string;
}

export function SplitHandle({
  hairline = true,
  onDelta,
  onReset,
  className,
  ...aria
}: SplitHandleProps) {
  const ctx = useContext(SplitContext);
  const isHorizontal = ctx ? ctx.direction === "horizontal" : true;
  const [active, setActive] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY };
    setActive(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const delta = isHorizontal ? e.clientX - startRef.current.x : e.clientY - startRef.current.y;
    startRef.current = { x: e.clientX, y: e.clientY };
    onDelta?.(delta);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (startRef.current) {
      startRef.current = null;
      setActive(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // 捕获已释放
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 20 : 5;
    if (isHorizontal) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onDelta?.(-step);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onDelta?.(step);
      }
    } else {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onDelta?.(-step);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onDelta?.(step);
      }
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      aria-label={aria["aria-label"] ?? "调整分栏大小"}
      className={clsx(
        styles.handle,
        isHorizontal ? styles.handleVertical : styles.handleHorizontal,
        !hairline && styles.invisible,
        active && styles.active,
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
