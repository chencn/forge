import { useCallback, useRef } from "react";

/**
 * 把一份「每次渲染都换身份」的回调稳成同一条引用，里面永远调最新那版。
 *
 * 递给 `memo` 过的面板的回调得是同一条引用，否则浅比较第一关就过不去；可这些回调
 * 又真要读到当前的文档、当前的仓库，不能闭住旧的。用「最新那份」的 ref 两头都满足：
 * 引用不变，逻辑跟着当前渲染走。只在渲染期读，不进依赖数组。
 */
export function useStable<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: Args) => latest.current(...args), []);
}
