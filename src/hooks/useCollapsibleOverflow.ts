import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 「先按高度裁住，真被裁掉了才给出展开/收起」这套动作（对照参考实现的同名 hook）。
 * 裁到多高由调用方的 CSS 类决定，这里不重复任何数值门槛。
 *
 * `contentRef` 绑到带裁剪类的那个节点，`contentKey` 传能代表正文的值（正文本身、分片
 * 数组都行），正文变了就重新量一次。
 */
export function useCollapsibleOverflow<T extends HTMLElement>(contentKey: unknown): {
  contentRef: RefObject<T | null>;
  isOverflowing: boolean;
  expanded: boolean;
  toggle: () => void;
} {
  const contentRef = useRef<T>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    // 展开之后没什么可再量的：调用方撤掉了裁剪类，clientHeight 自然等于 scrollHeight，
    // 量出来只会是 false，把「收起」按钮弄丢。冻住上一次的结论。
    if (expanded) return;
    const element = contentRef.current;
    if (!element) return;
    // 交给浏览器排版时再量：观察者在节点首次排版时报告一次（contentKey 变了就换一个
    // 观察者，正文变化因此会重新量），之后每次尺寸变化再报。在 effect 里直接读高度会
    // 从 React 的 effect 里同步触发一次排版，而长会话里被裁的块有几十个。
    const observer = new ResizeObserver(() => {
      // 两个读数都取自当前这个被裁住的节点：clientHeight 被调用方的类压住，
      // scrollHeight 永远是没裁的高度。
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentKey, expanded]);
  return { contentRef, isOverflowing, expanded, toggle: () => setExpanded((value) => !value) };
}
