/**
 * 跳转目标的编辑器内选择器：定义、声明、类型声明、实现多处命中时，把候选
 * 锚在发起跳转的那个位置弹一层让人挑（对标 IDE 的 Choose Declaration 弹层），
 * 不再丢到底部面板里。「查找用法」要的是通览，仍走 `cm/locations.ts` 的面板。
 *
 * CodeMirror 没有「按位置开交互浮层」的命令，浮层一律由 `showTooltip` 这条
 * facet 提供；上下键和回车用一条高优先 keymap 拦，光标不动、只有候选在动。
 */
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { keymap, showTooltip, type Command, type EditorView, type Tooltip } from "@codemirror/view";
import { openTargetInEditor } from "../editorEnv";
import { basenameOf, samePath } from "../format";
import { readFile } from "../fs";
import { pathOf } from "../cmEditor";
import type { LocationItem } from "./locations";

/** 一条候选；行列从 1 起，与 `LocationItem` 同一口径。 */
export interface ChooserItem {
  path: string;
  line: number;
  column: number;
  /** 候选行上的符号名；同文档当场取标识符，别的文件等正文补进来再取。 */
  label: string;
  /** 候选行的正文预览；同文档当场取，别的文件异步补。 */
  preview: string;
}

interface ChooserState {
  pos: number;
  title: string;
  items: ChooserItem[];
  active: number;
}

const setChooser = StateEffect.define<ChooserState | null>();

const chooserField = StateField.define<ChooserState | null>({
  create: () => null,
  update(state, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setChooser)) return effect.value;
    }
    return transaction.docChanged ? null : state;
  },
  provide: (field) =>
    showTooltip.from(field, (state): Tooltip | null => {
      if (!state) return null;
      return {
        pos: state.pos,
        above: false,
        create: () => ({ dom: chooserDom(state, pick) }),
      };
    }),
});

/** 候选行右侧的位置串；行上的 `title` 留全路径，鼠标停上去能看到完整位置。 */
function whereOf(item: ChooserItem): string {
  return `${basenameOf(item.path)}:${item.line}`;
}

function chooserDom(state: ChooserState, pick: (item: ChooserItem) => void): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-chooser";
  dom.setAttribute("role", "listbox");

  const title = document.createElement("div");
  title.className = "cm-lsp-chooser-title";
  title.textContent = state.title;
  dom.append(title);

  state.items.forEach((item, at) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = at === state.active ? "cm-lsp-chooser-row is-active" : "cm-lsp-chooser-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", at === state.active ? "true" : "false");
    row.title = `${item.path}:${item.line}:${item.column}`;

    const label = document.createElement("span");
    label.className = "cm-lsp-chooser-label";
    label.textContent = item.label;
    const preview = document.createElement("span");
    preview.className = "cm-lsp-chooser-preview";
    preview.textContent = item.preview;
    const where = document.createElement("span");
    where.className = "cm-lsp-chooser-where";
    where.textContent = whereOf(item);
    row.append(label, preview, where);

    row.addEventListener("click", () => pick(item));
    if (at === state.active) {
      // 重渲染（上下键）后保持可见，不靠浏览器猜。
      requestAnimationFrame(() => {
        // jsdom 没有这个方法；排版本来就不是这里的被测对象。
        row.scrollIntoView?.({ block: "nearest" });
      });
    }
    dom.append(row);
  });
  return dom;
}

/** 同一份文件只读一次；候选散在多个文件时只补前几个，别把磁盘扫一遍。 */
const PREVIEW_FILES = 20;

/** 整台应用只有一台编辑器实例；行点击时从这里拿，弹层随文档切换已自动收掉。 */
let ownerView: EditorView | null = null;

function fillPreviews(view: EditorView, state: ChooserState): void {
  const pending = new Map<string, ChooserItem[]>();
  for (const item of state.items) {
    if (item.preview) continue;
    const bucket = pending.get(item.path);
    if (bucket) bucket.push(item);
    else if (pending.size < PREVIEW_FILES) pending.set(item.path, [item]);
  }
  // 全部读完再重渲染一次：每份文件各 dispatch 一遍既闪也没必要。
  void Promise.all(
    [...pending].map(([path, items]) =>
      readFile(path)
        .then((file) => {
          const lines = file.contents.split(/\r\n|\n|\r/);
          for (const item of items) {
            const line = (lines[item.line - 1] ?? "").trim();
            item.preview = line;
            // 声明行上第一个标识符就是那个名字；取不到就保留文件名。
            const name = line.match(/[$_\w]+/)?.[0];
            if (name) item.label = name;
          }
        })
        .catch(() => {
          // 读不动（已删、太大、没权限）就只留「文件:行号」——位置本身仍然是答案。
        }),
    ),
  ).then(() => {
    const current = view.state.field(chooserField, false);
    // 弹层已经收掉（切文档、Escape）就不重开。
    if (!current || current.pos !== state.pos || current.title !== state.title) return;
    view.dispatch({ effects: setChooser.of({ ...current, items: [...current.items] }) });
  });
}

function pick(item: ChooserItem): void {
  const view = ownerView;
  if (!view) return;
  openTargetInEditor(item.path, item.line, item.column);
  view.dispatch({ effects: setChooser.of(null) });
  view.focus();
}

/**
 * 开选择器：`items` 里同文档的候选当场补上标识符与正文，别的文件异步补。
 * `pos` 是发起跳转的位置，弹层锚在那里。
 */
export function showDeclarationChooser(
  view: EditorView,
  pos: number,
  title: string,
  items: LocationItem[],
): void {
  const state = view.state;
  const chooserItems: ChooserItem[] = items.map((item) => ({
    path: item.path,
    line: item.line,
    column: item.column,
    label: "",
    preview: item.text,
  }));
  const here = pathOf(state);
  for (const item of chooserItems) {
    // 同文档的候选按目标列取标识符：声明行开头往往是修饰符（export、const），
    // 行首第一个词不一定是名字。别的文件还没有正文，等异步补全后再取。
    const sameDoc = !!here && samePath(here, item.path);
    const source = sameDoc && item.line >= 1 && item.line <= state.doc.lines
      ? state.doc.line(item.line).text
      : item.preview;
    const from = sameDoc ? item.column - 1 : 0;
    const aligned = from >= 0 && from < source.length && /^[$_\w]/.test(source.slice(from))
      ? from
      : source.search(/[$_\w]/);
    const name = aligned >= 0 ? source.slice(aligned).match(/^[$_\w]+/)?.[0] : undefined;
    if (source) item.preview = source.trim();
    item.label = name ?? basenameOf(item.path);
  }
  const chooser: ChooserState = { pos, title, items: chooserItems, active: 0 };
  ownerView = view;
  view.dispatch({ effects: setChooser.of(chooser) });
  fillPreviews(view, chooser);
}

function pickActive(view: EditorView): boolean {
  const state = view.state.field(chooserField, false);
  if (!state) return false;
  const item = state.items[state.active];
  if (item) pick(item);
  else view.dispatch({ effects: setChooser.of(null) });
  return true;
}

/** 关掉选择器；没开着时返回 false，让 Escape 继续往后面那几条命令走。 */
export const closeChooser: Command = (view) => {
  if (!view.state.field(chooserField, false)) return false;
  view.dispatch({ effects: setChooser.of(null) });
  return true;
};

function moveActive(view: EditorView, delta: number): boolean {
  const state = view.state.field(chooserField, false);
  if (!state) return false;
  const active = Math.min(Math.max(state.active + delta, 0), state.items.length - 1);
  view.dispatch({ effects: setChooser.of({ ...state, active }) });
  return true;
}

const chooserKeys = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (view) => moveActive(view, 1) },
    { key: "ArrowUp", run: (view) => moveActive(view, -1) },
    { key: "Enter", run: pickActive },
    { key: "Escape", run: closeChooser },
  ]),
);

export const chooserExtensions: Extension[] = [chooserField, chooserKeys];
