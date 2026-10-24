import { useEffect, useRef } from "react";

type Checker = () => boolean;

/** 设置页一次只挂载一个带草稿的面板，所以一个登记位就够。 */
let checker: Checker | null = null;

/** 登记「现在有没有未保存内容」，返回注销函数；只有登记方自己能注销，避免互相覆盖后误清。 */
export function registerUnsavedChecker(next: Checker): () => void {
  checker = next;
  return () => { if (checker === next) checker = null; };
}

/** 面板用它把未保存状态挂到设置页的导航拦截上。 */
export function useUnsavedGuard(isDirty: () => boolean) {
  const latest = useRef(isDirty);
  latest.current = isDirty;
  useEffect(() => registerUnsavedChecker(() => latest.current()), []);
}

/** 当前挂载的面板是否有未保存的修改。 */
export function hasUnsavedSettings() {
  return checker?.() ?? false;
}
