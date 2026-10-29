import { useEffect, useState } from "react";
import { prepareHighlight } from "./grammars";

/**
 * 主线程同步渲染（md 预览、工具详情里的代码块）用的重渲染触发器。
 *
 * 语法包按语言懒加载，第一次遇到某门语言时同步渲染只能先出素文本。这个钩子把那批
 * 语法装上，装好了让计数 +1，调用方把它放进 useMemo 依赖里就会重算一次；
 * 语言早就在内存里时计数不动，正在键入的正文因此不会被多渲染一遍。
 *
 * 聊天那条链不用它：解析在渲染 Worker 里，Worker 直接 await prepareHighlight 再出块，
 * 交给 React 的 HTML 已经是终态。
 */
export function useGrammarsReady(langs: readonly string[]): number {
  const key = langs.join(",");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void prepareHighlight(key.split(",")).then((loaded) => {
      if (live && loaded) setNonce((current) => current + 1);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return nonce;
}
