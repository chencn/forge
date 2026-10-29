import { useCallback, useMemo, useRef, useState } from "react";
import { errorText, fileStamp, readFile, writeFile, type FileContent } from "../lib/fs";
import { codedError, parseSaveConflict } from "../lib/errors";
import { recordSnapshot } from "../lib/localHistory";
import { canonicalPath, pathWithin, samePath } from "../lib/format";
import { languageForPath } from "../lib/editorEnv";
import { docKindOf, hasTextContent, previewsFromDisk } from "../lib/docKind";
import type { DocKind } from "../lib/docKind";

/** 文档的展示视图：源码、渲染后的预览、或分栏（左编辑右预览）。 */
export type DocView = "source" | "preview" | "split";

/**
 * 搜索命中要落到的位置。
 *
 * `line` 与 `column` 都从 1 起，直接是后端 `TextHit` 给的那两个数：行号按行算，
 * 列号按**字符**算。编辑器里的位置按 UTF-16 码元计，宽字符会让两者错开，
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
  /** 打开该文档时所属的工作区根目录；用于多工作区页签隔离（含跳转到外部库或父级仓库的文件）。 */
  root: string;
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
  /** 文本编码标签（`utf-8` / `gb18030`），打开时认下，保存时按它回写。 */
  encoding: "utf-8" | "gb18030";
  /** 语言 id（`languageForPath` 那张表给的）。 */
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

/**
 * 保存被乐观锁拒掉时挂出来的一份冲突现场。
 *
 * 除了后端回的路径与两个 mtime，还带上编辑器手里那份（`ours`）与共同祖先（`baseline`）——
 * 三向视图拿这三份加「读回来的磁盘那份」就够了，不必再让对话框去猜当前文档。
 */
export interface SaveConflictInfo {
  path: string;
  diskMs: number;
  baseMs: number;
  name: string;
  language: string;
  /** 编辑器手里那份（未保存改动）。 */
  ours: string;
  /** 上次与磁盘一致的那份，三路合并的共同祖先。 */
  base: string;
  lineEnding: "crlf" | "lf";
  hasBom: boolean;
  encoding: "utf-8" | "gb18030";
}

/** 这份文档能不能在源码与预览之间切。 */
export function canPreview(doc: OpenDocument): boolean {  // markdown 的预览渲染的是手里的文本，虚拟文档照样能看；
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

/** 判定一篇文档是否归属于指定工作区根：优先按打开时记录的所属根匹配，确保外部库跳转与父级仓库虚拟文档归属正确。 */
export function belongsToRoot(doc: OpenDocument, targetRoot: string): boolean {
  return doc.root ? samePath(doc.root, targetRoot) : pathWithin(targetRoot, doc.path);
}

/** 自己写盘之后，认这段时间内的监听回声为同一件事的尾巴，不再读一遍盘。 */
const SELF_WRITE_WINDOW_MS = 1200;

const ENCODER = new TextEncoder();

/** 一份文本按 UTF-8 占多少字节：判断磁盘上是不是就是手里这份，不用整读回来。 */
const utf8Length = (text: string) => ENCODER.encode(text).length;

export function useDocuments(
  reportError: (message: string) => void,
  workspaceRoot: string | null = null
) {
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
  /** 记录当前激活的工作区根，供异步或全局跳转打开文档时绑定所属工作区。 */
  const rootRef = useRef<string>(workspaceRoot ?? "");
  rootRef.current = workspaceRoot ?? "";
  /** 正在写盘的文件锁：防止编辑器失焦、切标签与窗口失焦同刻触发时对同一文件并发写盘。 */
  const savingRef = useRef<Map<string, Promise<boolean>>>(new Map());
  /**
   * 最近一次写盘成功的时间戳，按规范化路径存。
   *
   * 保存返回的那份正文与 mtime 就是磁盘现状，紧跟其后的监听回声再 `readFile` 一遍
   * 纯属白读一趟 IPC；这一串时间戳就是让回声认出「这是我自己刚写的」。窗口外自然过期。
   */
  const savedAtRef = useRef<Map<string, number>>(new Map());

  /** 保存被乐观锁拒掉时挂在这：三向合并对话框消费它，解决或取消后清掉。 */
  const [conflict, setConflict] = useState<SaveConflictInfo | null>(null);

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
      const ownerRoot = rootRef.current;
      const current = listRef.current;
      const existing = current.find((item) => samePath(item.path, path));
      const targetPath = existing?.path ?? path;
      activate(targetPath);
      if (at) {
        revealSeq.current += 1;
        setReveal({
          path: targetPath,
          line: Math.max(1, at.line),
          column: Math.max(1, at.column ?? 1),
          length: Math.max(0, at.length ?? 0),
          token: revealSeq.current,
        });
      }
      /**
       * 已经开着的不再读盘：读回来那份会直接盖掉 `contents`/`baseline`，
       * 用户没保存的改动就静默没了，不进撤销栈也报不出错。
       * 加载中（标签已显示、正文还在飞）同样退出，否则会并发起第二次读。
       * 只有上次读取失败的才放行，让「再点一次」等于重试。
       */
      if (existing && existing.error === null) {
        const freshLanguage = languageForPath(targetPath, existing.contents);
        const shouldUpdateLang = freshLanguage !== existing.language;
        const shouldUpdateRoot = ownerRoot && !samePath(existing.root, ownerRoot);
        if (shouldUpdateLang || shouldUpdateRoot) {
          upsert({
            ...existing,
            language: freshLanguage,
            root: shouldUpdateRoot ? ownerRoot : existing.root,
          });
        }
        return;
      }
      if (!existing) write([...current, placeholder(targetPath, ownerRoot)]);
      const kind = docKindOf(targetPath);
      try {
        // 已知的二进制格式：读不出文本也没有预览，打开前就说明，别等 readFile 报错。
        if (kind === "binary") {
          upsert({
            ...placeholder(targetPath, ownerRoot),
            kind,
            readOnly: true,
            loading: false,
            error: codedError("BINARY", targetPath),
          });
          return;
        }
        // 位图是二进制，readFile 会以非 UTF-8 拒收，所以只取指纹，正文交给 asset 协议。
        if (!hasTextContent(kind)) {
          const stamp = await fileStamp(targetPath);
          upsert({
            ...placeholder(targetPath, ownerRoot),
            kind,
            readOnly: true,
            loading: false,
            error: null,
            diskMs: stamp.modifiedMs,
            stamp: stamp.modifiedMs || stamp.size,
          });
          return;
        }
        const content = await readFile(targetPath);
        // svg 两样都要：正文给源码视图，指纹给图片视图做缓存失效。
        const stamp = previewsFromDisk(kind)
          ? await fileStamp(targetPath).catch(() => null)
          : null;
        upsert({
          path: targetPath,
          root: ownerRoot,
          name: nameOf(targetPath),
          kind,
          view: at && kind !== "text" ? "source" : defaultView(kind),
          onDisk: true,
          contents: content.contents,
          baseline: content.contents,
          lineEnding: content.lineEnding,
          hasBom: content.hasBom,
          encoding: content.encoding,
          language: languageForPath(targetPath, content.contents),
          readOnly: false,
          loading: false,
          error: null,
          diskMs: content.modifiedMs,
          stamp: stamp ? stamp.modifiedMs || stamp.size : 0,
        });
      } catch (cause) {
        const message = errorText(cause);
        upsert({
          ...placeholder(targetPath, ownerRoot),
          kind,
          readOnly: true,
          loading: false,
          error: message,
        });
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
      const ownerRoot = rootRef.current;
      const existing = listRef.current.find((item) => samePath(item.path, path));
      if (existing && !existing.loading) {
        if (ownerRoot && !samePath(existing.root, ownerRoot)) {
          upsert({ ...existing, root: ownerRoot });
        }
        activate(existing.path);
        revealSeq.current += 1;
        setReveal({
          path: existing.path,
          line: Math.max(1, line),
          column: Math.max(1, column ?? 1),
          length: Math.max(0, length ?? 0),
          token: revealSeq.current,
        });
        // 跳的是那一行文字，markdown 与 svg 仅在纯预览视图时要把视图扳回源码（分栏模式下编辑器本就可见）。
        if (existing.view === "preview") setView(existing.path, "source");
        return;
      }
      await open(path, { line, column, length });
    },
    [activate, open, setView, upsert]
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
      const ownerRoot = rootRef.current;
      const targetPath = listRef.current.find((item) => samePath(item.path, path))?.path ?? path;
      activate(targetPath);
      upsert({
        path: targetPath,
        root: ownerRoot,
        name: nameOf(targetPath),
        kind: docKindOf(targetPath),
        // 虚拟文档不在磁盘上：svg 的图片视图取不到，留在源码；markdown 预览仍可用。
        view: "source",
        onDisk: false,
        contents,
        baseline: contents,
        lineEnding: "lf",
        hasBom: false,
        encoding: "utf-8",
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
      const ownerRoot = rootRef.current;
      const targetPath = listRef.current.find((item) => samePath(item.path, path))?.path ?? path;
      activate(targetPath);
      upsert({ ...placeholder(targetPath, ownerRoot), readOnly: true, loading: false, error });
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
          // 乐观锁：把打开时认下的 mtime 交给后端，写之前一比。对不上就拒写、报 CONFLICT_ON_WRITE，
          // 交回三向合并，而不是静默覆盖磁盘上别处（AI 工具 / 别的编辑器 / git）改的那一份。
          const written = await writeFile(
            path,
            doc.contents,
            doc.lineEnding,
            doc.hasBom,
            doc.encoding,
            doc.diskMs
          );
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
            // 后端可能把 GB18030 里少数不可表示的字退回存成 UTF-8，以它回的编码为准。
            encoding: written.encoding,
            // svg 图片视图经 asset 协议读盘，保存后刷新指纹才能让 <img> 立即重取新图。
            stamp: previewsFromDisk(fresh.kind)
              ? written.modifiedMs || fresh.stamp
              : fresh.stamp,
          });
          // 认领这份磁盘现状：紧随其后的监听回声不必再 readFile 一遍。
          savedAtRef.current.set(canonicalPath(path), Date.now());
          // 顺手打一条本地历史：按刚写盘这份（正文、行尾、编码、BOM）留一份，供事后回滚。
          void recordSnapshot(fresh.root, path, {
            savedAt: written.modifiedMs || Date.now(),
            contents: written.contents,
            lineEnding: written.lineEnding,
            hasBom: written.hasBom,
            encoding: written.encoding,
          });
          return true;
        } catch (cause) {
          const conflictInfo = parseSaveConflict(errorText(cause));
          if (conflictInfo) {
            // 磁盘被别处改过：把现场挂出来，交三向合并对话框处理，这里当「没存成」返回。
            const current = listRef.current.find((item) => samePath(item.path, path));
            setConflict({
              ...conflictInfo,
              name: current?.name ?? path.split(/[\\/]/).pop() ?? path,
              language: current?.language ?? "plaintext",
              ours: current?.contents ?? doc.contents,
              base: current?.baseline ?? doc.baseline,
              lineEnding: doc.lineEnding,
              hasBom: doc.hasBom,
              encoding: doc.encoding,
            });
          } else {
            reportError(errorText(cause));
          }
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

  /** 收掉冲突现场（对话框取消 / 已解决），不改磁盘也不改文档。 */
  const dismissConflict = useCallback(() => setConflict(null), []);

  /**
   * 接受磁盘那份：把编辑器文档刷成磁盘现在的内容并认领为基线，不写盘。
   *
   * 用户选了「以磁盘为准」，手里那份就丢了（他已在三向视图里看过），这里只让文档变干净、
   * 更新 `diskMs`，下次保存不会再撞同一处冲突。
   */
  const applyDiskVersion = useCallback(
    (path: string, disk: FileContent) => {
      const fresh = listRef.current.find((item) => samePath(item.path, path));
      if (!fresh) return;
      upsert({
        ...fresh,
        contents: disk.contents,
        baseline: disk.contents,
        lineEnding: disk.lineEnding,
        hasBom: disk.hasBom,
        encoding: disk.encoding,
        diskMs: disk.modifiedMs,
        error: null,
        loading: false,
        readOnly: false,
      });
      savedAtRef.current.set(canonicalPath(path), Date.now());
      setConflict(null);
    },
    [upsert]
  );

  /**
   * 三向合并定了结果（或选了「保留我的」直接用手里这份）后落盘。
   *
   * 仍以对话框实际读到的磁盘版本做乐观锁：对话框打开后若磁盘再次变化，本次写入也必须拒绝。
   * 新冲突以用户刚整理出的结果为本地版本、以上次看过的磁盘正文为共同祖先，避免丢掉合并工作。
   */
  const resolveConflict = useCallback(
    async (path: string, result: string, comparedDisk: FileContent): Promise<boolean> => {
      const doc = listRef.current.find((item) => samePath(item.path, path));
      if (!doc) return false;
      try {
        const written = await writeFile(
          path,
          result,
          doc.lineEnding,
          doc.hasBom,
          doc.encoding,
          comparedDisk.modifiedMs
        );
        const fresh = listRef.current.find((item) => samePath(item.path, path));
        if (!fresh) return false;
        upsert({
          ...fresh,
          contents: written.contents,
          baseline: written.contents,
          lineEnding: written.lineEnding,
          hasBom: written.hasBom,
          diskMs: written.modifiedMs,
          encoding: written.encoding,
        });
        savedAtRef.current.set(canonicalPath(path), Date.now());
        void recordSnapshot(fresh.root, path, {
          savedAt: written.modifiedMs || Date.now(),
          contents: written.contents,
          lineEnding: written.lineEnding,
          hasBom: written.hasBom,
          encoding: written.encoding,
        });
        setConflict(null);
        return true;
      } catch (cause) {
        const message = errorText(cause);
        const nextConflict = parseSaveConflict(message);
        if (nextConflict) {
          const fresh = listRef.current.find((item) => samePath(item.path, path));
          setConflict({
            ...nextConflict,
            name: fresh?.name ?? doc.name,
            language: fresh?.language ?? doc.language,
            ours: result,
            base: comparedDisk.contents,
            lineEnding: fresh?.lineEnding ?? doc.lineEnding,
            hasBom: fresh?.hasBom ?? doc.hasBom,
            encoding: fresh?.encoding ?? doc.encoding,
          });
        } else {
          reportError(message);
        }
        return false;
      }
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

  /** 把指定工作区根下所有未保存的文档挨个写回磁盘（关闭单个文件夹前若开启自动保存可用）。 */
  const saveAllForRoot = useCallback(
    async (root: string): Promise<number> => {
      const dirty = listRef.current.filter(
        (doc) => !doc.readOnly && doc.contents !== doc.baseline && belongsToRoot(doc, root)
      );
      let done = 0;
      for (const doc of dirty) {
        if (await save(doc.path)) done += 1;
      }
      return done;
    },
    [save]
  );

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
          // 自己刚写盘的那几秒：先拿一次 stat 验明回声是不是自己那次写的尾巴。
          // mtime 还是保存时认下的那个数，磁盘上就是手里这份，整读一遍纯属白读；
          // 对不上说明这几秒里又有别人动过，照常往下重读，不能让它藏在抑制窗口里。
          const key = canonicalPath(doc.path);
          const savedAt = savedAtRef.current.get(key);
          if (savedAt !== undefined) {
            if (Date.now() - savedAt > SELF_WRITE_WINDOW_MS) savedAtRef.current.delete(key);
            else {
              const stamp = await fileStamp(doc.path);
              const fresh = listRef.current.find((item) => samePath(item.path, doc.path));
              if (!fresh) continue;
              // mtime 拿不到（0）时不认这条捷径；mtime 对上了还要比一次字节数——FAT / exFAT
              // 和部分网络盘的 mtime 只到秒，同一秒里别人的改动否则会被当成自己的回声吞掉。
              // 对不上就照常往下重读：宁可多读一遍，也不能把外部改动藏在这道窗口里。
              if (
                stamp.modifiedMs !== 0 &&
                stamp.modifiedMs === fresh.diskMs &&
                utf8Length(fresh.contents) === stamp.size
              )
                continue;
            }
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
            encoding: content.encoding,
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
      savedAtRef.current.delete(canonicalPath(path));
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
      for (const path of paths) savedAtRef.current.delete(canonicalPath(path));
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
    savedAtRef.current.clear();
  }, [activate, write]);

  /** 关闭指定工作区根下的全部文档，保留其它常驻根已打开的文档不动。 */
  const closeForRoot = useCallback(
    (root: string) => {
      const closing = listRef.current.filter((item) => belongsToRoot(item, root));
      const survivors = listRef.current.filter((item) => !belongsToRoot(item, root));
      write(survivors);
      for (const doc of closing) savedAtRef.current.delete(canonicalPath(doc.path));
      const active = activeRef.current;
      if (active !== null && !survivors.some((item) => samePath(item.path, active))) {
        activate(survivors[survivors.length - 1]?.path ?? null);
      }
    },
    [activate, write]
  );

  const revealDone = useCallback(() => setReveal(null), []);

  const dirty = useCallback(
    (path: string) => {
      const doc = documents.find((item) => samePath(item.path, path));
      return Boolean(doc && doc.contents !== doc.baseline);
    },
    [documents]
  );

  /** 当前是否仍有可写的脏文档；从 ref 同步读取，供退出保存完成后立即判定。 */
  const hasDirty = useCallback(
    () => listRef.current.some((doc) => !doc.readOnly && doc.contents !== doc.baseline),
    []
  );

  /** 指定工作区根下是否存在尚未保存的脏文档（供顶栏工程切换器蓝点与关闭根前询问判定）。 */
  const hasDirtyForRoot = useCallback(
    (root: string) =>
      documents.some(
        (doc) => !doc.readOnly && doc.contents !== doc.baseline && belongsToRoot(doc, root)
      ),
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
      saveAllForRoot,
      noteExternalChange,
      close,
      closeMany,
      closeForRoot,
      closeAll,
      dirty,
      hasDirty,
      hasDirtyForRoot,
      conflict,
      dismissConflict,
      resolveConflict,
      applyDiskVersion,
    }),
    [
      activate,
      activePath,
      applyDiskVersion,
      close,
      closeAll,
      closeForRoot,
      closeMany,
      conflict,
      dirty,
      dismissConflict,
      documents,
      hasDirty,
      hasDirtyForRoot,
      noteExternalChange,
      open,
      openHit,
      openNotice,
      openVirtual,
      resolveConflict,
      reveal,
      revealDone,
      save,
      saveAll,
      saveAllForRoot,
      setView,
      update,
    ]
  );
}

function placeholder(path: string, root: string): OpenDocument {
  const kind = docKindOf(path);
  return {
    path,
    root,
    name: nameOf(path),
    kind,
    view: defaultView(kind),
    onDisk: true,
    contents: "",
    baseline: "",
    lineEnding: "lf",
    hasBom: false,
    encoding: "utf-8",
    language: languageForPath(path),
    readOnly: true,
    loading: true,
    error: null,
    diskMs: 0,
    stamp: 0,
  };
}
