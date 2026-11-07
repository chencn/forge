/** 提交说明挂在仓库上，不跟提交面板走。面板卸掉再打开，说明还在。 */

/** 各仓库根的提交说明草稿（内存态，不持久化）。 */
const drafts = new Map<string, string>();
/** 各仓库根的草稿订阅者。 */
const listeners = new Map<string, Set<(message: string) => void>>();

/** 读某仓库根当前挂着的提交说明；没有返回空串。 */
export function commitDraft(root: string): string {
  return drafts.get(root) ?? "";
}

/** 写某仓库根的提交说明并广播；相同值不动作，空串即清除。 */
export function setCommitDraft(root: string, message: string): void {
  const prev = drafts.get(root) ?? "";
  if (prev === message) return;
  if (message) drafts.set(root, message);
  else drafts.delete(root);
  listeners.get(root)?.forEach((fn) => fn(message));
}

/** 订阅某仓库根的草稿变化。返回取消函数。 */
export function subscribeCommitDraft(root: string, fn: (message: string) => void): () => void {
  let set = listeners.get(root);
  if (!set) {
    set = new Set();
    listeners.set(root, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(root);
  };
}
