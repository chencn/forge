/** 提交说明挂在仓库上，不跟提交面板走。面板卸掉再打开，说明还在。 */

const drafts = new Map<string, string>();
const listeners = new Map<string, Set<(message: string) => void>>();

export function commitDraft(root: string): string {
  return drafts.get(root) ?? "";
}

export function setCommitDraft(root: string, message: string): void {
  const prev = drafts.get(root) ?? "";
  if (prev === message) return;
  if (message) drafts.set(root, message);
  else drafts.delete(root);
  listeners.get(root)?.forEach((fn) => fn(message));
}

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
