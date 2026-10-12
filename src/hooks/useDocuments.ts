import { useCallback, useMemo, useRef, useState } from "react";
import { errorText, fileStamp, readFile, writeFile } from "../lib/fs";
import { codedError } from "../lib/errors";
import { samePath } from "../lib/format";
import { languageForPath } from "../lib/monacoEnv";
import { docKindOf, hasTextContent, previewsFromDisk } from "../lib/docKind";
import type { DocKind } from "../lib/docKind";

/** 文档的展示视图：源码还是渲染后的预览。 */
export type DocView = "source" | "preview";

/**
 * 搜索命中要落到的位置。
 *
 * `line` 与 `column` 都从 1 起，直接是后端 `TextHit` 给的那两个数：行号按行算，
 * 列号按**字符**算。monaco 的列按 UTF-16 码元算，宽字符会让两者错开，
 * 所以换算放在编辑器那一侧按真实行内容做，不在这里折算。
 */
export interface RevealTarget {
  /** 落在哪篇文档上；路径比对走 `samePath`，大小写与分隔符不参与。 */
  path: string;
  line: number;
  column: number;
  /** 命中本身有多长（按字符数）。给了就把这一段选住，IDEA 落点也是选中的。 */
  length: number;
  /** 同一个位置连点两次也要再跳一回，靠这个序号让 effect 重新走一遍。 */
  token: number;
}

/** 一个已打开的编辑器文档。 */
export interface OpenDocument {
  /** 文件绝对路径，同时作为标签的唯一键。 */
  path: string;
  /** 显示名（不含路径）。 */
  name: string;
  /** 按扩展名判定的文档类型，决定能开哪些视图。 */
  kind: DocKind;
  /** 当前视图。markdown / svg 可切换，其余恒为 source。 */
  view: DocView;
  /** 编辑器里的当前文本，含未保存改动；图片文档为空。 */
  contents: string;
  /** 上次与磁盘一致的文本，用来判定是否已修改。 */
  baseline: string;
  /** 行尾风格，保存时交给后端归一。 */
  lineEnding: "crlf" | "lf";
  /** 原文件的 UTF-8 BOM，保存时保留。 */
  hasBom: boolean;
  /** Monaco 语言 id。 */
  language: string;
  /** 只读预览：二进制、超大或带只读属性的文件。 */
  readOnly: boolean;
  /** 读取中：此时 contents 还是空的，编辑器要等加载完再建 model。 */
  loading: boolean;
  /** 读取失败的原因；有值时正文为空，标签仍显示以便查看原因。 */
  error: string | null;
  /** 最后一次与磁盘同步时那份文件的修改时间（unix 毫秒）。 */
  diskMs: number;
  /** 图片文档的磁盘指纹，变了就换 asset URL 的查询串，逼 webview 重取。 */
  stamp: number;
  /**
   * 这份内容是不是就来自磁盘上那个路径。
   *
   * 从 git 历史打开的文档是虚拟的（路径带 `@哈希` 后缀），磁盘上没有它，
   * 图片预览没法用 asset 协议去取，只能看源码。
   */
  onDisk: boolean;
}

/** 这份文档能不能在源码与预览之间切。 */
export function canPreview(doc: OpenDocument): boolean {
  // markdown 的预览渲染的是手里的文本，虚拟文档照样能看；
  // svg 的图片视图要经 asset 协议读磁盘，只有真在磁盘上的才行。
  return doc.kind === "markdown" || (doc.kind === "svg" && doc.onDisk);
}

/**
 * 打开时先给哪个视图。
 *
 * 能预览的先给预览：markdown 与 svg 打开就是想看渲染结果，要看源文再切过去。
 * 纯文本没有预览，只能是源码。
 */
function defaultView(kind: DocKind): DocView {
  return kind === "text" || kind === "image" ? "source" : "preview";
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function useDocuments(reportError: (message: string) => void) {
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [activePath, writeActivePath] = useState<string | null>(null);
  /** 等着被编辑器消费的那一处定位；一次只挂一个，跳完就清。 */
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const revealSeq = useRef(0);
  /** 监听回调要读到最新的文档列表，不能拿渲染时闭住的那份。 */
  const listRef = useRef<OpenDocument[]>(documents);
  listRef.current = documents;
  const activeRef = useRef<string | null>(activePath);
  activeRef.current = activePath;
  /** 正在写盘的文件锁：防止编辑器失焦、切标签与窗口失焦同刻触发时对同一文件并发写盘。 */
  const savingRef = useRef<Map<string, Promise<boolean>>>(new Map());

  /**
   * 改列表只走这一条：先记进 ref 再交给 React。同一个事件里连着写两次（批量关闭
   * 就是先关掉确认过的、再关掉队列里的），第二次读到的是第一次的结果，
   * 而不是渲染时闭住的那份旧数组——否则前一次白关，标签又活回来。
   */
  const write = useCallback((next: OpenDocument[]) => {
    listRef.current = next;
    setDocuments(next);
  }, []);

  const activate = useCallback((path: string | null) => {
    activeRef.current = path;
    writeActivePath(path);
  }, []);

  const upsert = useCallback(
    (doc: OpenDocument) => {
      const current = listRef.current;
      const index = current.findIndex((item) => samePath(item.path, doc.path));
      if (index < 0) write([...current, doc]);
      else {
        const next = [...current];
        next[index] = doc;
        write(next);
      }
    },
    [write]
  );

  /**
   * 打开一篇文档。`at` 是给搜索命中留的：带上就同时排一个定位，
   * 并把 markdown / svg 直接开到源码视图，因为跳过去是要看那一行文字，不是看渲染结果。
   */
  const open = useCallback(
    async (path: string, at?: { line: number; column?: number; length?: number }) => {
      activate(path);
      if (at) {
        revealSeq.current += 1;
        setReveal({
          path,
          line: Math.max(1, at.line),
          column: Math.max(1, at.column ?? 1),
          length: Math.max(0, at.length ?? 0),
          token: revealSeq.current,
        });
      }
      const current = listRef.current;
      /**
       * 已经开着的不再读盘：读回来那份会直接盖掉 `contents`/`baseline`，
       * 用户没保存的改动就静默没了，不进撤销栈也报不出错。
       * 加载中（标签已显示、正文还在飞）同样退出，否则会并发起第二次读。
       * 只有上次读取失败的才放行，让「再点一次」等于重试。
       */
      const existing = current.find((item) => samePath(item.path, path));
      if (existing && existing.error === null) return;
      if (!current.some((item) => samePath(item.path, path))) write([...current, placeholder(path)]);
      const kind = docKindOf(path);
      try {
        // 已知的二进制格式：读不出文本也没有预览，打开前就说明，别等 readFile 报错。
        if (kind === "binary") {
          upsert({
            ...placeholder(path),
            kind,
            readOnly: true,
            loading: false,
            error: codedError("BINARY", path),
          });
          return;
        }
        // 位图是二进制，readFile 会以非 UTF-8 拒收，所以只取指纹，正文交给 asset 协议。
        if (!hasTextContent(kind)) {
          const stamp = await fileStamp(path);
          upsert({
            ...placeholder(path),
            kind,
            readOnly: true,
            loading: false,
            error: null,
            diskMs: stamp.modifiedMs,
            stamp: stamp.modifiedMs || stamp.size,
          });
          return;
        }
        const content = await readFile(path);
        // svg 两样都要：正文给源码视图，指纹给图片视图做缓存失效。
        const stamp = previewsFromDisk(kind)
          ? await fileStamp(path).catch(() => null)
          : null;
        upsert({
          path,
          name: nameOf(path),
          kind,
          view: at && kind !== "text" ? "source" : defaultView(kind),
          onDisk: true,
          contents: content.contents,
          baseline: content.contents,
          lineEnding: content.lineEnding,
          hasBom: content.hasBom,
          language: languageForPath(path),
          readOnly: false,
          loading: false,
          error: null,
          diskMs: content.modifiedMs,
          stamp: stamp ? stamp.modifiedMs || stamp.size : 0,
        });
      } catch (cause) {
        const message = errorText(cause);
        upsert({ ...placeholder(path), kind, readOnly: true, loading: false, error: message });
        reportError(message);
      }
    },
    [activate, reportError, upsert, write]
  );

  /** 切换一篇文档的视图（markdown 的源码 / 预览、svg 的图片 / 源码）。 */
  const setView = useCallback(
    (path: string, view: DocView) => {
      write(
        listRef.current.map((item) => (samePath(item.path, path) ? { ...item, view } : item))
      );
    },
    [write]
  );

  /**
   * 打开一处搜索命中。
   *
   * 文件已经开着时只切过去并跳行，不重读磁盘：`open` 那条会把磁盘那份写回文档，
   * 用户没保存的改动就没了。命中要落的是他眼前那份文字。
   */
  const openHit = useCallback(
    async (path: string, line: number, column?: number, length?: number) => {
      const existing = listRef.current.find((item) => samePath(item.path, path));
      if (existing && !existing.loading) {
        activate(existing.path);
        revealSeq.current += 1;
        setReveal({
          path: existing.path,
          line: Math.max(1, line),
          column: Math.max(1, column ?? 1),
          length: Math.max(0, length ?? 0),
          token: revealSeq.current,
        });
        // 跳的是那一行文字，markdown 与 svg 停在预览视图时要把视图扳回源码。
        if (existing.view !== "source") setView(existing.path, "source");
        return;
      }
      await open(path, { line, column, length });
    },
    [activate, open, setView]
  );

  const update = useCallback(
    (path: string, contents: string) => {
      write(
        listRef.current.map((item) => (samePath(item.path, path) ? { ...item, contents } : item))
      );
    },
    [write]
  );

  /** 把一份不在磁盘上的文本（某个版本下的文件）当只读文档开出来。 */
  const openVirtual = useCallback(
    (path: string, contents: string, language: string) => {
      activate(path);
      upsert({
        path,
        name: nameOf(path),
        kind: docKindOf(path),
        // 虚拟文档不在磁盘上：svg 的图片视图取不到，留在源码；markdown 预览仍可用。
        view: "source",
        onDisk: false,
        contents,
        baseline: contents,
        lineEnding: "lf",
        hasBom: false,
        language,
        readOnly: true,
        loading: false,
        error: null,
        diskMs: 0,
        stamp: 0,
      });
    },
    [activate, upsert]
  );

  /**
   * 开一份只摆说明的文档：内容打不开（例如 git 里那个版本是二进制），
   * 但标签要留着，让那句原因有地方站。
   */
  const openNotice = useCallback(
    (path: string, error: string) => {
      activate(path);
      upsert({ ...placeholder(path), readOnly: true, loading: false, error });
    },
    [activate, upsert]
  );

  const save = useCallback(
    async (path: string): Promise<boolean> => {
      // 若同一路径已有写盘请求在飞，先等上一趟落定，再按最新文本决定是否需要补存。
      const pending = savingRef.current.get(path);
      if (pending) {
        await pending;
        const after = listRef.current.find((item) => samePath(item.path, path));
        if (!after || after.readOnly || after.contents === after.baseline) return true;
      }

      const doc = listRef.current.find((item) => samePath(item.path, path));
      if (!doc || doc.readOnly) return false;

      const task = (async () => {
        try {
          const written = await writeFile(path, doc.contents, doc.lineEnding, doc.hasBom);
          // 写盘要跨一次 IPC，期间用户可能已经在敲下一个字：回写前重读当前条目，
          // 有新编辑就保留手里那份正文，只认领磁盘基线——否则刚敲的内容会被
          // 保存前的快照整段抹掉（还不进撤销栈）。
          const fresh = listRef.current.find((item) => samePath(item.path, path));
          if (!fresh) return false;
          const editedDuringSave = fresh.contents !== doc.contents;
          upsert({
            ...fresh,
            baseline: written.contents,
            contents: editedDuringSave ? fresh.contents : written.contents,
            diskMs: written.modifiedMs,
            // svg 图片视图经 asset 协议读盘，保存后刷新指纹才能让 <img> 立即重取新图。
            stamp: previewsFromDisk(fresh.kind)
              ? written.modifiedMs || fresh.stamp
              : fresh.stamp,
          });
          return true;
        } catch (cause) {
          reportError(errorText(cause));
          return false;
        } finally {
          savingRef.current.delete(path);
        }
      })();

      savingRef.current.set(path, task);
      return task;
    },
    [reportError, upsert]
  );

  /**
   * 把所有没保存的文档挨个写回磁盘，返回存了几份。
   *
   * 失焦自动保存和退出前强制保存都走这条。串行而不是并发：同一份文件可能被
   * 两个入口碰到，写盘顺序乱了磁盘上就是半新半旧。
   */
  const saveAll = useCallback(async (): Promise<number> => {
    const dirty = listRef.current.filter(
      (doc) => !doc.readOnly && doc.contents !== doc.baseline
    );
    let done = 0;
    for (const doc of dirty) {
      if (await save(doc.path)) done += 1;
    }
    return done;
  }, [save]);

  /**
   * 文件监听报来一批磁盘上动过的路径，规则只有一条：不动用户正在写的东西。
   *
   * 没改过的文档跟着磁盘走；有没保存改动的保持原样，用户下一次保存就是他手里那份。
   * 两边都改了的内容合并不了，所以选「编辑器赢」而不是弹一张要人当场选边界的框。
   */
  const noteExternalChange = useCallback(
    async (paths: string[]) => {
      const hits = listRef.current.filter(
        (doc) => doc.contents === doc.baseline && paths.some((path) => samePath(path, doc.path))
      );
      for (const doc of hits) {
        try {
          // 位图没有正文可重载，只需要换一下缓存失效串，让 <img> 重取。
          if (!hasTextContent(doc.kind)) {
            const stamp = await fileStamp(doc.path);
            // await 之后文件可能已经关掉，重找一次，找不到就不动。
            const fresh = listRef.current.find((item) => samePath(item.path, doc.path));
            if (!fresh) continue;
            const token = stamp.modifiedMs || stamp.size;
            if (token === fresh.stamp) continue;
            upsert({ ...fresh, stamp: token, diskMs: stamp.modifiedMs, error: null });
            continue;
          }
          const content = await readFile(doc.path);
          // 读盘要跨一次 IPC，期间用户可能已经开始编辑：重读当前条目，
          // 不再干净（contents 与 baseline 有出入）就跳过重载，磁盘版本
          // 不能盖掉用户手里那份——快照时干净不代表此刻还干净。
          const fresh = listRef.current.find((item) => samePath(item.path, doc.path));
          if (!fresh || fresh.contents !== fresh.baseline) continue;
          // svg 的图片视图也读磁盘，指纹得跟着换，否则 <img> 还拿旧缓存。
          const stamp = previewsFromDisk(fresh.kind)
            ? await fileStamp(fresh.path).catch(() => null)
            : null;
          // 只是被 touch 了一下（构建工具常这么干）就别重载，免得光标白重置一次。
          if (content.contents === fresh.baseline && content.modifiedMs === fresh.diskMs) {
            // 正文没变也要认指纹：内容换了但 mtime 撞上的话，图片这边得重取。
            if (stamp && (stamp.modifiedMs || stamp.size) !== fresh.stamp) {
              upsert({ ...fresh, stamp: stamp.modifiedMs || stamp.size });
            }
            continue;
          }
          upsert({
            ...fresh,
            contents: content.contents,
            baseline: content.contents,
            lineEnding: content.lineEnding,
            hasBom: content.hasBom,
            diskMs: content.modifiedMs,
            stamp: stamp ? stamp.modifiedMs || stamp.size : fresh.stamp,
            error: null,
            loading: false,
            readOnly: false,
          });
        } catch (cause) {
          // 读不回来多半是文件被删了：留着这份文本，把原因写在正文区。
          const fresh = listRef.current.find((item) => samePath(item.path, doc.path));
          if (!fresh) continue;
          upsert({
            ...fresh,
            readOnly: true,
            loading: false,
            error: errorText(cause),
          });
        }
      }
    },
    [upsert]
  );

  const close = useCallback(
    (path: string) => {
      const current = listRef.current;
      const index = current.findIndex((item) => samePath(item.path, path));
      const next = current.filter((item) => !samePath(item.path, path));
      write(next);
      if (activeRef.current !== null && samePath(activeRef.current, path)) {
        activate((next[Math.min(index, next.length - 1)] ?? null)?.path ?? null);
      }
    },
    [activate, write]
  );

  /** 一次关掉一批：逐个调 close 会让每次的旧快照互相覆盖，结果只剩最后一个生效。 */
  const closeMany = useCallback(
    (paths: string[]) => {
      const survivors = listRef.current.filter((item) => !paths.some((p) => samePath(p, item.path)));
      write(survivors);
      const active = activeRef.current;
      if (active !== null && paths.some((p) => samePath(p, active))) {
        activate(survivors[survivors.length - 1]?.path ?? null);
      }
    },
    [activate, write]
  );

  const closeAll = useCallback(() => {
    write([]);
    activate(null);
  }, [activate, write]);

  const revealDone = useCallback(() => setReveal(null), []);

  const dirty = useCallback(
    (path: string) => {
      const doc = documents.find((item) => samePath(item.path, path));
      return Boolean(doc && doc.contents !== doc.baseline);
    },
    [documents]
  );

  // 整个返回值必须稳定：App 里 `useEffect(..., [docs])` 挂的是 Tauri 事件监听，
  // 每次渲染换一个新对象就等于每次渲染跑一对 listen/unlisten IPC。
  return useMemo(
    () => ({
      documents,
      activePath,
      setActivePath: activate,
      open,
      openHit,
      reveal,
      revealDone,
      openVirtual,
      openNotice,
      update,
      setView,
      save,
      saveAll,
      noteExternalChange,
      close,
      closeMany,
      closeAll,
      dirty,
    }),
    [
      activate,
      activePath,
      close,
      closeAll,
      closeMany,
      dirty,
      documents,
      noteExternalChange,
      open,
      openHit,
      openNotice,
      openVirtual,
      reveal,
      revealDone,
      save,
      saveAll,
      setView,
      update,
    ]
  );
}

function placeholder(path: string): OpenDocument {
  const kind = docKindOf(path);
  return {
    path,
    name: nameOf(path),
    kind,
    view: defaultView(kind),
    onDisk: true,
    contents: "",
    baseline: "",
    lineEnding: "lf",
    hasBom: false,
    language: languageForPath(path),
    readOnly: true,
    loading: true,
    error: null,
    diskMs: 0,
    stamp: 0,
  };
}
