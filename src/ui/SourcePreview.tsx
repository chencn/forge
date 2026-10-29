/**
 * 只读代码行切片预览组件（带行号与高亮区间标记）。
 * 用于各类结果树（问题诊断、TODO、查找引用等）侧边的快速预览面板。
 * 调用者提供异步文本加载函数（从内存缓冲或磁盘文件读取）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import styles from "./SourcePreview.module.css";

export interface SourceHighlight {
  line: number;
  /** 行内 UTF-16 列区间 [startCol, endCol] */
  ranges: ReadonlyArray<readonly [number, number]>;
}

/** 当前行上下窗口渲染缓冲行数 */
const WINDOW = 300;

export interface SourcePreviewProps {
  path: string | null;
  /** 0-based 目标行号，自动居中并作为当前高亮行展示 */
  line: number;
  highlights?: readonly SourceHighlight[];
  /** 异步文本加载器（如 fs 或 open document） */
  load: (path: string) => Promise<string>;
  /** 递增版本号可主动触发重新加载相同文件 */
  version?: number;
  className?: string;
  emptyText?: string;
}

export function SourcePreview({
  path,
  line,
  highlights = [],
  load,
  version = 0,
  className,
  emptyText = "选择一项以查看代码预览",
}: SourcePreviewProps) {
  const [text, setText] = useState<{ path: string; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const current = text && text.path === path ? text : null;

  useEffect(() => {
    if (!path) return;
    let alive = true;
    // 80ms 防抖，避免键盘在树中上下快速移动时产生大量无用 IO
    const t = setTimeout(() => {
      load(path).then(
        (content) => {
          if (!alive) return;
          setText({ path, lines: content.split(/\r\n|\r|\n/) });
          setError(null);
        },
        (e) => alive && setError(String((e as Error)?.message ?? e))
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, version, load]);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (box && el) {
      box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
    }
  }, [current, line]);

  if (!path) {
    return (
      <div className={clsx(styles.preview, styles.empty, className)}>
        {emptyText}
      </div>
    );
  }
  if (error && !current) {
    return <div className={clsx(styles.preview, styles.empty, className)}>{error}</div>;
  }
  if (!current) {
    return <div className={clsx(styles.preview, className)} />;
  }

  const byLine = new Map(highlights.map((h) => [h.line, h.ranges]));
  const start = Math.max(0, line - WINDOW);
  const end = Math.min(current.lines.length, line + WINDOW);
  const rows: ReactNode[] = [];

  for (let n = start; n < end; n++) {
    const content = current.lines[n] ?? "";
    const ranges = byLine.get(n);
    rows.push(
      <div
        key={n}
        data-line={n}
        className={clsx(styles.codeLine, n === line && styles.currentLine)}
      >
        <span className={styles.gutter}>{n + 1}</span>
        <span className={styles.code}>
          {ranges ? highlight(content, ranges) : content || " "}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={clsx(styles.preview, className)}
      role="region"
      aria-label="代码预览"
    >
      <pre className={styles.pre}>{rows}</pre>
    </div>
  );
}

function highlight(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>
): ReactNode[] {
  const parts: ReactNode[] = [];
  let pos = 0;
  [...ranges]
    .sort((a, b) => a[0] - b[0])
    .forEach(([s, e], i) => {
      if (s < pos || e <= s) return;
      if (s > pos) parts.push(text.slice(pos, s));
      parts.push(
        <mark key={i} className={styles.match}>
          {text.slice(s, e)}
        </mark>
      );
      pos = e;
    });
  if (pos < text.length) parts.push(text.slice(pos));
  return parts;
}
