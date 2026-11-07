import type { GitBranch, GitTag } from "./git";
import type { BranchSettings } from "./settings";
import type { RefTarget } from "./refMenu";

/** 分支弹层的一行：分组标题或一个引用。 */
export type BranchPopupRow =
  | { type: "group"; key: string; label: string; depth: number; expanded: boolean; parent?: string }
  | { type: "ref"; key: string; label: string; depth: number; parent: string; target: RefTarget; current: boolean; favorite: boolean; upstream: string; ahead: number; behind: number };

/** 扁平树模型：搜索展开命中路径，退出搜索恢复用户自己的折叠状态。 */
export function branchPopupRows(branches: readonly GitBranch[], tags: readonly GitTag[], recent: readonly string[], query: string,
  options: BranchSettings, expanded: ReadonlyMap<string, boolean>, labels: Record<"recent" | "local" | "remote" | "tag", string>): BranchPopupRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const hit = (name: string) => name.toLocaleLowerCase().includes(needle);
  const favorite = (name: string) => options.favorites.includes(name);
  const rank = (branch: GitBranch) => branch.current ? 0 : favorite(branch.name) ? 1 : 2;
  const sorted = [...branches].filter((b) => !b.remote || !b.name.endsWith("/HEAD"))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const locals = sorted.filter((b) => !b.remote);
  const byName = new Map(locals.map((b) => [b.name, b]));
  const recents = needle || !options.showRecent ? [] : [...new Set(recent)].flatMap((name) => {
    const branch = byName.get(name);
    return branch && !branch.current ? [branch] : [];
  }).slice(0, 5);
  const rows: BranchPopupRow[] = [];
  const open = (key: string, fallback: boolean) => !!needle || (expanded.get(key) ?? fallback);
  const add = (group: "recent" | "local" | "remote" | "tag", refs: Extract<BranchPopupRow, { type: "ref" }>[], byDefault: boolean) => {
    const matches = refs.filter((r) => hit(r.target.name));
    if (!matches.length) return;
    const key = `group:${group}`;
    const expandedNow = open(key, byDefault);
    rows.push({ type: "group", key, label: labels[group], depth: 0, expanded: expandedNow });
    if (!expandedNow) return;
    const level = (items: typeof matches, parent: string, depth: number) => {
      const folders = new Map<string, typeof matches>();
      const leaves: typeof matches = [];
      for (const item of items) {
        const slash = options.groupByDirectory && group !== "tag" ? item.label.indexOf("/") : -1;
        if (slash > 0 && slash < item.label.length - 1) {
          const folder = item.label.slice(0, slash);
          const inner = folders.get(folder) ?? [];
          inner.push({ ...item, label: item.label.slice(slash + 1) });
          folders.set(folder, inner);
        } else leaves.push({ ...item, depth, parent });
      }
      rows.push(...leaves.filter((r) => r.current || r.favorite));
      for (const [label, children] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
        const folderKey = `${parent}/${label}`;
        const expandedFolder = open(folderKey, group === "recent" || (group === "remote" && depth === 1) || children.some((r) => r.current));
        rows.push({ type: "group", key: folderKey, label, parent, depth, expanded: expandedFolder });
        if (expandedFolder) level(children, folderKey, depth + 1);
      }
      rows.push(...leaves.filter((r) => !r.current && !r.favorite));
    };
    level(matches, key, 1);
  };
  const refsOf = (list: readonly GitBranch[], group: string): Extract<BranchPopupRow, { type: "ref" }>[] => list.map((b) => ({
    type: "ref", key: `${group}:${b.name}`, label: b.name, depth: 1, parent: `group:${group}`,
    target: { name: b.name, kind: b.remote ? "remote" : "local" }, current: b.current, favorite: favorite(b.name), upstream: b.upstream,
    ahead: b.ahead, behind: b.behind,
  }));
  add("recent", refsOf(recents, "recent"), true);
  add("local", refsOf(locals, "local"), !recents.length);
  add("remote", refsOf(sorted.filter((b) => b.remote), "remote"), false);
  if (options.showTags) add("tag", [...tags].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).map((tag) => ({
    type: "ref", key: `tag:${tag.name}`, label: tag.name, depth: 1, parent: "group:tag", target: { name: tag.name, kind: "tag" },
    current: false, favorite: false, upstream: tag.target, ahead: 0, behind: 0,
  })), false);
  return rows;
}
