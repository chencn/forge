/**
 * 随处搜索的取数编排（抄 IntelliJ IDEA 的 everywhere/controller.ts）。
 *
 * 每个数据分节各查各的、各自收口：任何一节先答上来就先进列表，不等别人。
 * 新一轮查询把旧的顶掉——这边的后端命令是一次性 Promise，没有「取消」这回事，
 * 所以只靠代号（gen）认账：回来的那份结果对不上自己那节的现行代号就整份丢掉。
 * 输入没变的分节不重查，比如某一节点「更多」时，别节的结果原样留着。
 *
 * 少了 IntelliJ IDEA 那侧的三样：漏斗过滤器、按根算的范围选择、语言服务的符号合并——
 * 这边都没有等价的数据源。
 */
import type { FileHit, ScanFilter, SearchOptions, SymbolHit, TextPage } from "./fs";
import type { ForgeCommand } from "./commands";
import { basenameOf, pathWithin, samePath } from "./format";
import { parseLocationQuery } from "./seQuery";
import {
  ALL_TAB_LIMIT,
  RECENT_LIMIT,
  TAB_LIMIT,
  fileItem,
  isTypeKind,
  matchActions,
  sectionsFor,
  symbolItem,
  textItem,
  type FileItem,
  type SeItem,
  type SeTab,
  type SectionId,
  type SectionState,
} from "./seModel";

/** 正文那一档少于这么多字符就不查，否则整棵树被第一个字母刷一遍。 */
export const TEXT_MIN_QUERY = 2;

/** 分节每次要多少条：「最近」按自己的档，其余看是不是 All 页签（那边每节只留几行）。 */
export function sectionLimit(tab: SeTab, section: SectionId, extra: number): number {
  if (section === "recent" || section === "recentActions") return RECENT_LIMIT + extra;
  return (tab === "all" ? ALL_TAB_LIMIT : TAB_LIMIT) + extra;
}

/**
 * 外部数据源。全部是可注入的窄接口，编排本身不碰 Tauri：
 * 前端测试直接塞假实现，跳过后端比名字。
 */
export interface SeDeps {
  findFiles(query: string, limit: number, filter: ScanFilter): Promise<FileHit[]>;
  findSymbols(query: string, kindFilter: "types" | "all", limit: number, filter: ScanFilter): Promise<SymbolHit[]>;
  /** 一次一整页；`options.limit` 由编排填（多要一条用来判断「还有更多」）。 */
  searchText(query: string, options: SearchOptions, filter: ScanFilter): Promise<TextPage>;
  actions(): readonly ForgeCommand[];
  /** 最近打开过的文件绝对路径，新的在前。 */
  recentFiles(): string[];
  /** 最近执行过的动作 id，新的在前。 */
  recentActions(): string[];
  root(): string | null;
  now(): number;
}

export interface SeRequest {
  query: string;
  tab: SeTab;
  /** 「包括隐藏与忽略项」：勾上时可见性闸门全开。 */
  includeIgnored: boolean;
  /** 隐藏项与忽略前缀，来自资源管理器那两档设置。 */
  filter: ScanFilter;
  /** 正文那一档的开关（大小写 / 整词 / 正则 / 文件名过滤），条数由编排补。 */
  text: Omit<SearchOptions, "limit">;
  /** 各节经「更多」额外要的行数。 */
  extra: Partial<Record<SectionId, number>>;
}

export interface SeSnapshot {
  gen: number;
  sections: ReadonlyMap<SectionId, SectionState>;
  /** 从发起查询到最近一条结果落地花了多久（毫秒）；一条都没有时为 null。 */
  elapsed: number | null;
  /** 任何一节还在加载中就为真。 */
  loading: boolean;
  /** 这批分节答的是哪个词、哪个页签（旧查询的结果可能还挂着）。 */
  query: string;
  tab: SeTab | null;
  /** 正文那一档最近一次的整页结果，交给底部查找窗口用；没查过为 null。 */
  textPage: TextPage | null;
  /** 取数失败的原样错误串（`BAD_REGEX` 这类），由界面翻译成人话。 */
  failed: string | null;
}

export class SeController {
  private gen = 0;
  private sections = new Map<SectionId, SectionState>();
  private signatures = new Map<SectionId, string>();
  /** 每节现行的代号：回来的结果只有对上它才作数。 */
  private live = new Map<SectionId, number>();
  private started = 0;
  private req: { query: string; tab: SeTab | null } = { query: "", tab: null };
  private elapsed: number | null = null;
  private textPage: TextPage | null = null;
  private failed: string | null = null;
  private notifyQueued = false;
  private disposed = false;

  constructor(
    private readonly deps: SeDeps,
    private readonly onChange: (snapshot: SeSnapshot) => void
  ) {}

  run(request: SeRequest) {
    const gen = ++this.gen;
    this.disposed = false;
    this.req = { query: request.query, tab: request.tab };
    const parsed = parseLocationQuery(request.query, this.deps.root());
    const text = parsed.text.trim();
    const wanted = sectionsFor(request.tab, !text);
    this.started = this.deps.now();
    this.elapsed = null;
    this.textPage = null;
    this.failed = null;

    for (const id of [...this.sections.keys()]) {
      if (!wanted.includes(id)) {
        this.sections.delete(id);
        this.signatures.delete(id);
        this.live.delete(id);
      }
    }
    for (const id of wanted) {
      const limit = sectionLimit(request.tab, id, request.extra[id] ?? 0);
      const sig = JSON.stringify([
        request.query,
        request.tab,
        request.includeIgnored,
        request.filter,
        id === "text" ? request.text : null,
        limit
      ]);
      if (this.signatures.get(id) === sig && this.sections.has(id)) continue;
      this.signatures.set(id, sig);
      this.live.delete(id);
      const previous = this.sections.get(id);
      this.sections.set(id, {
        items: previous?.items ?? [],
        hasMore: previous?.hasMore ?? false,
        loading: true
      });
      this.live.set(id, gen);
      void this.start(id, gen, { text, line: parsed.line, col: parsed.col, request, limit });
    }
    this.notify();
  }

  /** 全丢掉；下一次 run() 从头再来。 */
  dispose() {
    this.disposed = true;
    this.sections.clear();
    this.signatures.clear();
    this.live.clear();
  }

  snapshot(): SeSnapshot {
    return {
      gen: this.gen,
      sections: new Map(this.sections),
      elapsed: this.elapsed,
      loading: [...this.sections.values()].some((section) => section.loading),
      query: this.req.query,
      tab: this.req.tab,
      textPage: this.textPage,
      failed: this.failed
    };
  }

  private isLive(id: SectionId, gen: number) {
    return !this.disposed && this.live.get(id) === gen;
  }

  private set(id: SectionId, gen: number, items: SeItem[], hasMore: boolean, loading: boolean) {
    if (!this.isLive(id, gen)) return;
    this.sections.set(id, { items, hasMore, loading });
    if (items.length) this.elapsed = Math.max(0, Math.round(this.deps.now() - this.started));
    if (!loading) this.live.delete(id);
    this.notify();
  }

  /** 一个微任务里并成一次回调：流式进来的一串 set 不该各刷一遍界面。 */
  private notify() {
    if (this.notifyQueued || this.disposed) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      if (!this.disposed) this.onChange(this.snapshot());
    });
  }

  /** 这一趟用的可见性闸门：勾了「包括隐藏与忽略项」就整个放开。 */
  private gate(request: SeRequest): ScanFilter {
    return request.includeIgnored ? { showHidden: true, ignored: [] } : request.filter;
  }

  private fail(gen: number, error: unknown) {
    if (this.disposed || this.gen !== gen) return;
    this.failed = error instanceof Error ? error.message : String(error);
  }

  private async start(
    id: SectionId,
    gen: number,
    q: { text: string; line: number | null; col: number | null; request: SeRequest; limit: number }
  ) {
    const { text, limit, request } = q;
    const gate = this.gate(request);
    try {
      switch (id) {
        case "recent": {
          const root = this.deps.root();
          const allPaths = this.deps.recentFiles();
          // 彻底按当前项目根过滤：不属于当前工程作用域的文件绝不出现在推荐列表中
          const paths = root
            ? allPaths.filter((path) => pathWithin(root, path) || samePath(root, path))
            : allPaths;
          const items = paths.slice(0, limit).map((path) => recentFileItem(path, root));
          this.set(id, gen, items, paths.length > limit, false);
          break;
        }
        case "recentActions": {
          const byId = new Map(this.deps.actions().map((command) => [command.id, command]));
          const items: SeItem[] = this.deps
            .recentActions()
            .map((actionId) => byId.get(actionId))
            .filter((command): command is ForgeCommand => !!command)
            .slice(0, limit)
            .map((command) => ({
              kind: "action",
              key: `a:${command.id}`,
              id: command.id,
              title: command.label,
              shortcut: command.shortcut,
              indices: [],
              score: 0
            }));
          this.set(id, gen, items, false, false);
          break;
        }
        case "files": {
          // 多要一条，才知道这一页到底截没截。
          const rawHits = await this.deps.findFiles(text, limit + 1, gate);
          const root = this.deps.root();
          // 项目级安全屏障：过滤确保属于当前根作用域
          const hits = root
            ? rawHits.filter((hit) => pathWithin(root, hit.path) || samePath(root, hit.path))
            : rawHits;
          this.set(
            id,
            gen,
            hits.slice(0, limit).map((hit) => fileItem(hit, text, q.line, q.col)),
            hits.length > limit,
            false
          );
          break;
        }
        case "classes":
        case "symbols": {
          const typesOnly = id === "classes";
          // All 页签的「符号」不收类型（那边已经有一整节「类」了），所以多要一半再剪。
          const excludeTypes = !typesOnly && request.tab === "all";
          const fetch = excludeTypes ? limit * 2 + 1 : limit + 1;
          const rawHits = await this.deps.findSymbols(text, typesOnly ? "types" : "all", fetch, gate);
          const root = this.deps.root();
          // 项目级安全屏障：过滤确保属于当前根作用域
          const within = root
            ? rawHits.filter((hit) => pathWithin(root, hit.path) || samePath(root, hit.path))
            : rawHits;
          const kept = excludeTypes ? within.filter((hit) => !isTypeKind(hit.kind)) : within;
          this.set(
            id,
            gen,
            kept.slice(0, limit).map((hit) => symbolItem(hit, text)),
            kept.length > limit || rawHits.length >= fetch,
            false
          );
          break;
        }
        case "actions": {
          const hits = matchActions(this.deps.actions(), text, this.deps.recentActions());
          this.set(id, gen, hits.slice(0, limit), hits.length > limit, false);
          break;
        }
        case "text": {
          if (text.length < TEXT_MIN_QUERY) {
            this.set(id, gen, [], false, false);
            break;
          }
          const page = await this.deps.searchText(text, { ...request.text, limit: limit + 1 }, gate);
          const root = this.deps.root();
          // 项目级安全屏障：过滤确保属于当前根作用域
          const filteredHits = root
            ? page.hits.filter((hit) => pathWithin(root, hit.path) || samePath(root, hit.path))
            : page.hits;
          if (this.isLive(id, gen)) this.textPage = { ...page, hits: filteredHits };
          this.set(id, gen, filteredHits.slice(0, limit).map(textItem), filteredHits.length > limit, false);
          break;
        }
      }
    } catch (error) {
      // 查不动的分节什么都不贡献，但原因留给界面说一句。
      this.fail(gen, error);
      this.set(id, gen, [], false, false);
    }
  }
}

/**
 * 最近文件转成一条文件行：后端没有它，名字与相对目录自己拆。
 */
export function recentFileItem(path: string, root: string | null): FileItem {
  const flat = path.replace(/\\/g, "/");
  const name = basenameOf(flat);
  const base = root?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  const container =
    base && (flat.startsWith(`${base}/`) || flat.toLowerCase().startsWith(`${base.toLowerCase()}/`))
      ? flat.slice(base.length + 1, flat.length - name.length).replace(/\/+$/, "")
      : "";
  return {
    kind: "file",
    key: `f:${path}`,
    path,
    name,
    dir: container,
    isDir: false,
    nameIndices: [],
    line: null,
    col: null
  };
}
