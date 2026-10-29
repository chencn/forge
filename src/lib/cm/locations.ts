/**
 * 跳转结果的列表面板：定义落在多处、以及「查找用法」时开在编辑器底下那一块。
 *
 * CodeMirror 没有内置的位置列表面板（它的查找面板只列文本命中），Monaco 那版是自带的，
 * 换过来就得自己搭一层。数据挂在一条 StateField 上，面板由这条 field 通过 `showPanel`
 * 提供——于是换文档（`setState` 重建 field）时面板自然收掉，不需要谁去记得关它。
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { keymap, showPanel, type Command, type EditorView, type Panel } from "@codemirror/view";
import { translate } from "../../i18n";
import { basenameOf, samePath } from "../format";
import { readFile } from "../fs";
import { openTargetInEditor } from "../editorEnv";
import { pathOf } from "../cmEditor";

/** 一条结果；行列都从 1 起，与 `openTargetInEditor` 同一口径。 */
export interface LocationItem {
  path: string;
  line: number;
  column: number;
  /** 那一行的正文。同文档的当场取，别的文件异步补；取不到就留空，只画位置。 */
  text: string;
}

interface LocationList {
  title: string;
  items: LocationItem[];
}

const setLocations = StateEffect.define<LocationList | null>();

/** 一次列表里最多补几份正文：用法命中散在几百个文件时不该把磁盘扫一遍。 */
const PREVIEW_FILES = 40;

const locationsField = StateField.define<LocationList | null>({
  create: () => null,
  update(list, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLocations)) return effect.value;
    }
    return list;
  },
  provide: (field) =>
    showPanel.from(field, (list) => (list ? (view: EditorView) => locationsPanel(view, list) : null)),
});

/** 行号右边那截正文；`title` 上留全路径，鼠标停上去能看到完整位置。 */
function rowOf(item: LocationItem, onPick: () => void): { row: HTMLButtonElement; text: HTMLSpanElement } {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "lsp-locations-row";
  const where = document.createElement("span");
  where.className = "lsp-locations-where";
  where.textContent = `${basenameOf(item.path)}:${item.line}`;
  where.title = `${item.path}:${item.line}:${item.column}`;
  const text = document.createElement("span");
  text.className = "lsp-locations-text";
  text.textContent = item.text;
  row.append(where, text);
  row.addEventListener("click", onPick);
  return { row, text };
}

function locationsPanel(view: EditorView, list: LocationList): Panel {
  let alive = true;
  const dom = document.createElement("div");
  dom.className = "lsp-locations";

  const head = document.createElement("div");
  head.className = "lsp-locations-head";
  const title = document.createElement("span");
  title.textContent = list.items.length
    ? `${list.title} · ${translate("editor.locations.count", { count: list.items.length })}`
    : list.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "lsp-locations-close";
  close.textContent = "×";
  close.title = translate("editor.cm.close");
  close.setAttribute("aria-label", translate("editor.cm.close"));
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "lsp-locations-list";
  if (!list.items.length) {
    const empty = document.createElement("div");
    empty.className = "lsp-locations-empty";
    empty.textContent = translate("editor.locations.empty");
    body.append(empty);
  }

  /** 同一份文件只读一次：按路径攒着，最后一起发。 */
  const pending = new Map<string, Array<{ line: number; text: HTMLSpanElement }>>();
  const here = pathOf(view.state);
  for (const item of list.items) {
    const { row, text } = rowOf(item, () => {
      openTargetInEditor(item.path, item.line, item.column);
      view.focus();
    });
    if (!item.text && !(here && samePath(here, item.path))) {
      const bucket = pending.get(item.path);
      if (bucket) bucket.push({ line: item.line, text });
      else if (pending.size < PREVIEW_FILES) pending.set(item.path, [{ line: item.line, text }]);
    }
    body.append(row);
  }
  dom.append(head, body);

  const rows = Array.from(body.querySelectorAll<HTMLButtonElement>(".lsp-locations-row"));
  const shutdown = () => {
    view.dispatch({ effects: setLocations.of(null) });
    view.focus();
  };
  close.addEventListener("click", shutdown);
  dom.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      shutdown();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const at = rows.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = rows[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1)];
    next?.focus();
  });

  for (const [path, targets] of pending) {
    void readFile(path)
      .then((file) => {
        if (!alive) return;
        const lines = file.contents.split(/\r\n|\n|\r/);
        for (const target of targets) {
          if (!target.text.isConnected) continue;
          target.text.textContent = (lines[target.line - 1] ?? "").trim();
        }
      })
      .catch(() => {
        // 读不动（已删、太大、没权限）就只留「文件:行号」——位置本身仍然是答案。
      });
  }

  return {
    dom,
    top: false,
    mount: () => {
      rows[0]?.focus();
    },
    destroy: () => {
      alive = false;
    },
  };
}

/** 开列表；已经开着时同名面板会被换掉（field 的值变了，`showPanel` 的构造函数也就变了）。 */
export function showLocations(view: EditorView, title: string, items: LocationItem[]): void {
  view.dispatch({ effects: setLocations.of({ title, items }) });
}

/** 关掉列表；没开着时返回 false，让 Escape 继续往引擎那套里走。 */
export const closeLocations: Command = (view) => {
  if (!view.state.field(locationsField)) return false;
  view.dispatch({ effects: setLocations.of(null) });
  view.focus();
  return true;
};

export const locationsExtensions: Extension[] = [
  locationsField,
  keymap.of([{ key: "Escape", run: closeLocations }]),
];
