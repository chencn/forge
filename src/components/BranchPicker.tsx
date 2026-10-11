import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  GitBranch,
  GitCommit,
  GitPullRequestArrow,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Star,
  Tag,
  Upload,
} from "lucide-react";
import Popover from "./Popover";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import type { GitState } from "../hooks/useGitState";
import type { GitBranch as GitBranchInfo, GitTag as GitTagInfo } from "../lib/git";
import { buildRefMenu, upstreamOf } from "../lib/refMenu";
import type { RefAction, RefTarget } from "../lib/refMenu";
import type { BranchSettings } from "../lib/settings";
import { withFavoriteToggled } from "../lib/settings";
import { useI18n } from "../i18n";

/** 弹层里能直接做的动作，具体执行留在 App。 */
export type BranchAction =
  | "update"
  | "commit"
  | "push"
  | "fetch"
  | "newBranch"
  | "newTag"
  | "checkoutRev"
  | "initRepo";

interface BranchPickerProps {
  git: GitState;
  /** 打开的那个文件夹；没开工程时是 null。没有仓库但有文件夹时，菜单给「创建 Git 仓库…」。 */
  folder: string | null;
  /** 最近签出过的分支，新的在前。 */
  recent: string[];
  onCheckout: (name: string) => void;
  onAction: (action: BranchAction) => void;
  /** 行上右键那套引用动作，与日志的分支树共用一份。 */
  onRefAction: (action: RefAction, target: RefTarget) => void;
  /** 「与当前比较」/「显示与工作树的差异」：改日志的两处筛选并把日志窗口叫出来。 */
  onRefInspect: (target: RefTarget, mode: "compare" | "worktree") => void;
  /** 头部齿轮那几条显示开关，落在全局设置里。 */
  options: BranchSettings;
  onOptions: (next: BranchSettings) => void;
}

/** 一行分支或标签；左侧图标是收藏开关，右侧留给上游分支名。 */
function RefRow({
  label,
  upstream,
  current,
  favorite = false,
  depth = 0,
  onPick,
  onToggleFavorite,
  onContextMenu,
}: {
  label: string;
  upstream?: string;
  current: boolean;
  /** 收藏的那一行图标换成实心星。 */
  favorite?: boolean;
  depth?: number;
  onPick: () => void;
  /** 点左侧图标翻收藏；IDEA 的 handleIconClick 就是这个。 */
  onToggleFavorite?: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
}) {
  const Icon = favorite ? Star : GitBranch;
  return (
    <button
      type="button"
      className={`branch-row${current ? " is-current" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={(event) => {
        const el = event.target as Element | null;
        if (el?.closest("svg") && onToggleFavorite) onToggleFavorite();
        else onPick();
      }}
      onContextMenu={onContextMenu}
    >
      <Icon size={13} className={favorite ? "ref-badge" : undefined} aria-hidden="true" />
      <span className="branch-row-label">{label}</span>
      {upstream ? (
        <span className="branch-row-upstream" title={upstream}>
          {upstream}
        </span>
      ) : null}
    </button>
  );
}

/** 弹层里一个可折叠分节：IDEA 把这四节当树节点画，箭头在左、标题跟着。 */
function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button type="button" className="branch-section" aria-expanded={open} onClick={onToggle}>
        {open ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
        <span>{title}</span>
      </button>
      {open ? children : null}
    </>
  );
}

/** 弹层没开时交回的那份空表：只读，所以整模块共用一个对象就够。 */
const EMPTY_LISTS: {
  locals: GitBranchInfo[];
  remotes: GitBranchInfo[];
  tags: GitTagInfo[];
  recents: GitBranchInfo[];
  groups: Map<string, GitBranchInfo[]>;
} = {
  locals: [],
  remotes: [],
  tags: [],
  recents: [],
  groups: new Map(),
};

/** IDEA 的分支芯片：一个搜索框同时管分支和管操作，下面按最近/本地/远程/标签分组。 */
export default function BranchPicker({
  git,
  folder,
  recent,
  onCheckout,
  onAction,
  onRefAction,
  onRefInspect,
  options,
  onOptions,
}: BranchPickerProps) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  /** 行上右键的菜单；弹层本身是 popover，菜单画在它上面一层。 */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 头部那颗抓取：跑起来时文案换成「抓取中…」，IDEA 同样只在这一颗上改字。 */
  const [fetching, setFetching] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const [gearMenu, setGearMenu] = useState<MenuAnchor | null>(null);
  /** 展开着的远程分组，按 remote 名记。 */
  const [openRemotes, setOpenRemotes] = useState<Set<string>>(new Set());
  /** IDEA 打开弹层时只摊开「最近」，本地/远程/标签都要人自己点开。 */
  const [closedSections, setClosedSections] = useState<Set<string>>(
    () => new Set(["local", "remote", "tag"])
  );
  const toggleSection = (key: string) =>
    setClosedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const inputRef = useRef<HTMLInputElement>(null);
  /** 弹层锚点用 ref 拿，别靠 event.currentTarget：updater 跑的时候它已经被清空。 */
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (anchor) inputRef.current?.focus();
    else setQuery("");
  }, [anchor]);

  const status = git.status;
  /** 一个远端都没配时抓取那颗点不动，IDEA 同样按 hasRemotes 关掉它。 */
  const remoteCount = git.probe?.remotes.length ?? 0;
  const needle = query.trim().toLowerCase();
  const hit = (name: string) => needle === "" || name.toLowerCase().includes(needle);
  /** 搜东西时不分节折叠：命中的行藏在收起的那节里就等于搜不到。 */
  const sectionOpen = (key: string) => needle !== "" || !closedSections.has(key);

  /** 收藏的引用全名名单，和日志的分支树共用这一份。Set 化是为了排序时那次比较不用扫全名单。 */
  const favorites = useMemo(() => new Set(options.favorites), [options.favorites]);
  const isFavorite = (name: string) => favorites.has(name);
  const toggleFavorite = (name: string) => onOptions(withFavoriteToggled(options, name));

  /**
   * 分组、过滤、排序都放进这里，并且弹层没开就直接交回空表。
   *
   * 原来这几段写在渲染体里：`Popover` 返回 null 只是不画，传给它的 children 表达式照样求值，
   * 所以 App 每次重渲染（轮询、拖分割条、打字）都带着几百条分支和标签各扫一遍、
   * 各排一遍、再各建一次 Map——而那会儿连浮层都还没露出来。
   */
  const lists = useMemo(() => {
    if (!anchor) return EMPTY_LISTS;
    /** 同一组里收藏的排前面，其余次序不动。 */
    const favoritesFirst = (list: GitBranchInfo[]) =>
      [...list].sort((a, b) => Number(favorites.has(b.name)) - Number(favorites.has(a.name)));
    const locals = favoritesFirst(
      git.branches.filter((branch) => !branch.remote && hit(branch.name))
    );
    const remotes = git.branches.filter((branch) => branch.remote && hit(branch.name));
    const tags = git.tags.filter((tag) => hit(tag.name));
    const localByName = new Map(locals.map((branch) => [branch.name, branch]));
    // 收藏过的分支已经在自己那组里排到前面了，「最近」那一节不再重复列。
    const recents: GitBranchInfo[] = recent
      .map((name) => localByName.get(name))
      .filter(
        (branch): branch is GitBranchInfo =>
          branch !== undefined && !branch.current && !favorites.has(branch.name)
      );

    const groups = new Map<string, GitBranchInfo[]>();
    for (const branch of favoritesFirst(remotes)) {
      const slash = branch.name.indexOf("/");
      const remote = slash > 0 ? branch.name.slice(0, slash) : branch.name;
      const list = groups.get(remote);
      if (list) list.push(branch);
      else groups.set(remote, [branch]);
    }
    return { locals, remotes, tags, recents, groups };
    // `hit` 只读 needle，而 needle 已在依赖里； favoritesFirst 只读 favorites。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, git.branches, git.tags, recent, favorites, needle]);
  const { locals, remotes, tags, recents, groups } = lists;

  // 动作名跟着界面语言走，但人搜的多半是英文命令名，两边都进匹配串。
  const sync: { key: BranchAction; label: string; icon: ReactNode; also: string }[] = [
    { key: "update", label: t("git.updateProject"), icon: <RefreshCw size={14} />, also: "update project pull merge" },
    { key: "commit", label: t("git.commit"), icon: <GitCommit size={14} />, also: "commit" },
    { key: "push", label: t("git.push"), icon: <Upload size={14} />, also: "push" },
    { key: "fetch", label: t("git.fetch"), icon: <Download size={14} />, also: "fetch" },
  ];
  const refs: { key: BranchAction; label: string; icon: ReactNode; also: string }[] = [
    { key: "newBranch", label: t("git.newBranch"), icon: <Plus size={14} />, also: "branch new" },
    { key: "newTag", label: t("git.newTag"), icon: <Tag size={14} />, also: "tag new" },
    {
      key: "checkoutRev",
      label: t("git.checkoutRev"),
      icon: <GitPullRequestArrow size={14} />,
      also: "checkout revision tag",
    },
  ];
  // IDEA 的「在搜索结果中加入操作」只管搜索那一档；没在搜的时候操作照常列。
  const listActions = needle === "" || options.actionsInSearch;
  const shownSync = listActions ? sync.filter((action) => hit(`${action.label} ${action.also}`)) : [];
  const shownRefs = listActions ? refs.filter((action) => hit(`${action.label} ${action.also}`)) : [];
  const shownRecents = options.showRecent ? recents : [];
  const shownTags = options.showTags ? tags : [];
  const nothingMatches =
    shownSync.length +
    shownRefs.length +
    shownRecents.length +
    locals.length +
    remotes.length +
    shownTags.length ===
    0;

  const pick = (name: string) => {
    setAnchor(null);
    onCheckout(name);
  };

  const run = (action: BranchAction) => {
    setAnchor(null);
    onAction(action);
  };

  /** 右键某行：菜单本体在 lib/refMenu，和日志的分支树是同一份。 */
  const refMenuFor =
    (target: RefTarget) =>
    (event: ReactMouseEvent) => {
      event.preventDefault();
      /** 挑了动作就把弹层收掉：签出、改名这些做完留在弹层里没有意义。 */
      const take = (act: () => void) => {
        setAnchor(null);
        act();
      };
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: buildRefMenu(target, {
          t,
          current: git.status?.branch ?? "",
          upstream: upstreamOf(git.branches, target),
          detached: git.status?.detached ?? false,
          onAction: (action, held) => take(() => onRefAction(action, held)),
          onCompareWith: (held) => take(() => onRefInspect(held, "compare")),
          onDiffWithWorktree: (held) => take(() => onRefInspect(held, "worktree")),
        }),
      });
    };

  const item = (action: { key: BranchAction; label: string; icon: ReactNode }) => (
    <button key={action.key} type="button" className="popover-item" onClick={() => run(action.key)}>
      {action.icon}
      <span>{action.label}</span>
    </button>
  );

  /** IDEA 的分支控件只画箭头不写数字，条数挪到悬停提示里。 */
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const syncText = [
    ahead > 0 ? t("git.aheadN", { count: ahead }) : "",
    behind > 0 ? t("git.behindN", { count: behind }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const baseTitle = git.root ?? t("git.noWorkspace");

  /**
   * 这里没有仓库，不等于「有仓库但一条分支都没有」：芯片不能摆成灰的 `—`，
   * 换成 IDEA 那颗「版本控制」，菜单里给「创建 Git 仓库…」。
   *
   * IDEA 那张菜单还有「共享到平台」「其他 VCS」「本地历史记录」三项，这边三样能力都没有，
   * 摆上去就是点了没反应的死控件，所以不给。连文件夹都没开时这一颗压根不画：
   * 没有工程就没有可接的版本控制，而「打开文件夹」主工具栏左边已经有了，不在这里摆第二个入口。
   */
  if (!git.root) {
    if (!folder) return null;
    return (
      <div className="toolbar-chip-host">
        <button
          type="button"
          ref={chipRef}
          className="toolbar-chip"
          aria-label={t("git.vcs")}
          aria-expanded={anchor !== null}
          title={folder}
          onClick={() => setAnchor((current) => (current ? null : chipRef.current))}
        >
          <GitBranch size={14} aria-hidden="true" />
          <span className="toolbar-chip-label">{t("git.vcs")}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>

        <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={260}>
          <button
            type="button"
            className="popover-item"
            onClick={() => {
              setAnchor(null);
              onAction("initRepo");
            }}
          >
            <GitBranch size={14} aria-hidden="true" />
            <span>{t("git.initRepo")}</span>
          </button>
        </Popover>
      </div>
    );
  }

  return (
    <div className="toolbar-chip-host">
      <button
        type="button"
        ref={chipRef}
        className="toolbar-chip"
        aria-label={t("panel.sourceControl")}
        aria-expanded={anchor !== null}
        title={syncText ? `${baseTitle} · ${syncText}` : baseTitle}
        onClick={() => setAnchor((current) => (current ? null : chipRef.current))}
      >
        <GitBranch size={14} aria-hidden="true" />
        <span className="toolbar-chip-label">{status?.branch ?? "—"}</span>
        {ahead + behind > 0 ? (
          <span className="branch-sync" aria-hidden="true">
            {behind > 0 ? (
              <svg viewBox="0 0 16 16" className="sync-in">
                <rect width="2" height="8.386" x="7.532" y="3.269" transform="rotate(45 8.532 7.462)" />
                <polygon points="4 5 11 12 4 12" />
              </svg>
            ) : null}
            {ahead > 0 ? (
              <svg viewBox="0 0 16 16" className="sync-out">
                <g transform="rotate(180 6 6.5)">
                  <rect width="2" height="8.386" x="3.532" y=".269" transform="rotate(45 4.532 4.462)" />
                  <polygon points="0 2 7 9 0 9" />
                </g>
              </svg>
            ) : null}
          </span>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={320}>
        {/* IDEA 的弹层头部只有两颗：抓取 + 齿轮，跟在搜索框右边。 */}
        <div className="popover-head">
          <label className="popover-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              placeholder={t("git.searchBranch")}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {/* IDEA 的抓取动作在执行时仅置灰禁用，按钮图标保持静态不转圈。 */}
          <button
            type="button"
            className="icon-button is-inline"
            disabled={remoteCount === 0 || fetching}
            onClick={() => {
              setFetching(true);
              void git.fetch().finally(() => setFetching(false));
            }}
            title={t(fetching ? "git.fetching" : "git.fetch")}
          >
            <Download size={14} />
          </button>
          <button
            type="button"
            ref={gearRef}
            className="icon-button is-inline"
            aria-haspopup="menu"
            title={t("git.viewOptions")}
            onClick={() => {
              if (gearMenu) {
                setGearMenu(null);
                return;
              }
              const box = gearRef.current?.getBoundingClientRect();
              if (!box) return;
              setGearMenu({
                x: box.right - 8,
                y: box.bottom + 2,
                items: [
                  {
                    label: t("git.actionsInSearch"),
                    checked: options.actionsInSearch,
                    onSelect: () => onOptions({ ...options, actionsInSearch: !options.actionsInSearch }),
                  },
                  { separator: true },
                  {
                    label: t("git.showRecentBranches"),
                    checked: options.showRecent,
                    onSelect: () => onOptions({ ...options, showRecent: !options.showRecent }),
                  },
                  {
                    label: t("git.showTags"),
                    checked: options.showTags,
                    onSelect: () => onOptions({ ...options, showTags: !options.showTags }),
                  },
                ],
              });
            }}
          >
            <Settings size={14} />
          </button>
        </div>

        {shownSync.length > 0 ? shownSync.map(item) : null}
        {shownRefs.length > 0 ? (
          <>
            <div className="popover-sep" />
            {shownRefs.map(item)}
          </>
        ) : null}

        {shownRecents.length > 0 ? (
          <>
            <div className="popover-sep" />
            <Section
              title={t("git.recentBranches")}
              open={sectionOpen("recent")}
              onToggle={() => toggleSection("recent")}
            >
              {shownRecents.map((branch) => (
                <RefRow
                  key={`recent-${branch.name}`}
                  label={branch.name}
                  upstream={branch.upstream}
                  current={false}
                  onPick={() => pick(branch.name)}
                  onToggleFavorite={() => toggleFavorite(branch.name)}
                  onContextMenu={refMenuFor({ name: branch.name, kind: "local" })}
                />
              ))}
            </Section>
          </>
        ) : null}

        {locals.length > 0 ? (
          <Section
            title={t("git.localBranches")}
            open={sectionOpen("local")}
            onToggle={() => toggleSection("local")}
          >
            {locals.map((branch) => (
              <RefRow
                key={`local-${branch.name}`}
                label={branch.name}
                upstream={branch.upstream}
                current={branch.current}
                favorite={isFavorite(branch.name)}
                onPick={() => pick(branch.name)}
                onToggleFavorite={() => toggleFavorite(branch.name)}
                onContextMenu={refMenuFor({ name: branch.name, kind: "local" })}
              />
            ))}
          </Section>
        ) : null}

        {groups.size > 0 ? (
          <Section
            title={t("git.remoteBranches")}
            open={sectionOpen("remote")}
            onToggle={() => toggleSection("remote")}
          >
            {[...groups.entries()].map(([remote, list]) => {
              const open = openRemotes.has(remote) || needle !== "";
              return (
                <div key={`remote-${remote}`}>
                  <button
                    type="button"
                    className="branch-group"
                    onClick={() =>
                      setOpenRemotes((current) => {
                        const next = new Set(current);
                        if (next.has(remote)) next.delete(remote);
                        else next.add(remote);
                        return next;
                      })
                    }
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>{remote}</span>
                  </button>
                  {open
                    ? list.map((branch) => (
                        <RefRow
                          key={branch.name}
                          // 远程分支按短名切：git 会自动建同名跟踪分支。
                          label={branch.name.slice(remote.length + 1)}
                          current={false}
                          depth={1}
                          favorite={isFavorite(branch.name)}
                          onPick={() => pick(branch.name.slice(remote.length + 1))}
                          onToggleFavorite={() => toggleFavorite(branch.name)}
                          onContextMenu={refMenuFor({ name: branch.name, kind: "remote" })}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </Section>
        ) : null}

        {shownTags.length > 0 ? (
          <Section
            title={t("git.tags")}
            open={sectionOpen("tag")}
            onToggle={() => toggleSection("tag")}
          >
            {shownTags.map((tag) => (
              <button
                key={`tag-${tag.name}`}
                type="button"
                className="branch-row"
                onClick={() => pick(tag.name)}
                onContextMenu={refMenuFor({ name: tag.name, kind: "tag" })}
              >
                <Tag size={13} aria-hidden="true" />
                <span className="branch-row-label">{tag.name}</span>
                <span className="branch-row-upstream">{tag.target}</span>
              </button>
            ))}
          </Section>
        ) : null}

        {nothingMatches ? <p className="popover-note">{t("git.searchNoHit")}</p> : null}
      </Popover>

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {gearMenu ? <ContextMenu anchor={gearMenu} onClose={() => setGearMenu(null)} /> : null}
    </div>
  );
}
