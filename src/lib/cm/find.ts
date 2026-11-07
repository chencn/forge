/**
 * 对齐 IntelliJ IDEA 的文件内查找栏：界面由应用提供，匹配、跳转和替换仍走 CodeMirror。
 * 使用 search.createPanel 保留引擎的高亮和面板生命周期，避免再维护一套搜索状态。
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel,
  replaceAll, replaceNext, search, searchPanelOpen, setSearchQuery,
} from "@codemirror/search";
import { translate as t } from "../../i18n";
import type { TranslationKey } from "../../i18n/lang/zh";
import "./find.css";

interface Scope { from: number; to: number }
type Context = "any" | "comments" | "strings" | "exceptComments" | "exceptStrings" | "code";
interface Filter { scope: Scope | null; context: Context }
const setFilter = StateEffect.define<Filter>();
const filter = StateField.define<Filter>({
  create: () => ({ scope: null, context: "any" }),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFilter)) return effect.value;
    if (!value.scope || !tr.docChanged) return value;
    // 替换边界上的文字仍属于选区；选区外相邻的输入不扩大搜索范围。
    const from = tr.changes.mapPos(value.scope.from, 1);
    const to = tr.changes.mapPos(value.scope.to, -1);
    return { ...value, scope: { from, to: Math.max(from, to) } };
  },
});

type LiteralKind = "comment" | "string";
const literalHighlighter = tagHighlighter([{ tag: tags.comment, class: "comment" }, { tag: tags.string, class: "string" }]);
const literalCache = new WeakMap<object, Array<Scope & { kind: LiteralKind }>>();

/** 按语法高亮标签分类；模板字符串里的插值表达式仍是代码。 */
function literalKindAt(state: EditorState, pos: number): LiteralKind | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  let ranges = literalCache.get(tree);
  if (!ranges) {
    ranges = [];
    highlightTree(tree, literalHighlighter, (from, to, kind) => {
      ranges!.push({ from, to, kind: kind.includes("comment") ? "comment" : "string" });
    });
    literalCache.set(tree, ranges);
  }
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const range = ranges[mid];
    if (pos < range.from) high = mid - 1;
    else if (pos >= range.to) low = mid + 1;
    else return range.kind;
  }
  return null;
}

function accepts(_match: string, state: EditorState, from: number, to: number): boolean {
  const { scope, context } = state.field(filter);
  if (scope && (from < scope.from || to > scope.to)) return false;
  if (context === "any") return true;
  const kind = literalKindAt(state, from);
  return context === "comments" ? kind === "comment"
    : context === "strings" ? kind === "string"
    : context === "exceptComments" ? kind !== "comment"
    : context === "exceptStrings" ? kind !== "string" : kind === null;
}

const panels = new WeakMap<EditorView, FindPanel>();
const historyKey = (kind: string) => `forge.editor.${kind}History.v1`;
function history(kind: string): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(historyKey(kind)) ?? "[]");
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
  } catch { return []; }
}
function remember(kind: string, value: string): void {
  if (!value.trim()) return;
  try {
    localStorage.setItem(historyKey(kind), JSON.stringify([value, ...history(kind).filter((v) => v !== value)].slice(0, 20)));
  } catch { /* 禁用存储时仍可正常查找。 */ }
}

/** Ctrl+F 只查找，Ctrl+R / Ctrl+H 才展开替换；多行选区在替换模式下成为搜索范围。 */
export function openFind(view: EditorView, replace = false): boolean {
  const previous = getSearchQuery(view.state);
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const scoped = replace && !view.state.readOnly && selected.includes("\n");
  const searchText = scoped ? "" : selected && selected.length < 10_000
    ? previous.regexp ? selected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : selected
    : previous.search.includes("\n") ? "" : previous.search;
  openSearchPanel(view);
  view.dispatch({ effects: [
    setFilter.of({ ...view.state.field(filter), scope: scoped ? selection : null }),
    setSearchQuery.of(new SearchQuery({ ...previous, search: searchText, literal: !previous.regexp, test: accepts })),
  ] });
  panels.get(view)?.showReplace(replace);
  panels.get(view)?.focusSearch();
  return true;
}

function closeFind(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) return false;
  panels.get(view)?.remember();
  view.dispatch({ effects: setFilter.of({ ...view.state.field(filter), scope: null }) });
  closeSearchPanel(view);
  view.focus();
  return true;
}

// 小图标使用固定 SVG 路径，避免按钮文字随字体变化而挤压搜索框。
const icons = {
  history: "M9 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM13 12l3 3M16 6l2 2 2-2",
  newline: "M17 5v7H5m4-4-4 4 4 4",
  previous: "m6 10 6-6 6 6M12 4v16",
  next: "m6 14 6 6 6-6M12 4v16",
  filter: "M4 4h16l-6 7v7l-4 2v-9Z",
  expand: "m9 6 6 6-6 6",
  close: "m6 6 12 12M6 18 18 6",
} as const;
type Icon = keyof typeof icons;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
function button(label: string, run: () => void, icon?: Icon): HTMLButtonElement {
  const node = element("button", "forge-find-button");
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  if (icon) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "aria-hidden": "true" })) svg.setAttribute(key, value);
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", icons[icon]);
    svg.append(path);
    node.append(svg);
  }
  node.onclick = run;
  return node;
}

class FindPanel implements Panel {
  // 自定义面板必须自己声明位置；search.top 只会被引擎的默认面板读取。
  readonly top = true;
  readonly dom = element("div", "cm-search forge-find");
  private readonly searchInput = this.input("search");
  private readonly replaceInput = this.input("replace");
  private readonly searchBox = this.field(this.searchInput);
  private readonly replaceBox = this.field(this.replaceInput);
  private readonly counter = element("span", "forge-find-count");
  private readonly replaceButtons = element("div", "forge-find-replacements");
  private readonly menu = element("div", "forge-find-menu");
  private readonly toggles = new Map<"caseSensitive" | "wholeWord" | "regexp", HTMLButtonElement>();
  private readonly replaceToggle: HTMLButtonElement;
  private readonly filterToggle: HTMLButtonElement;
  private readonly replaceActions: HTMLButtonElement[] = [];
  private readonly navigation: HTMLButtonElement[] = [];
  private savedSelection: Scope | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private menuAnchor: HTMLButtonElement | null = null;

  constructor(private readonly view: EditorView) {
    panels.set(view, this);
    const selection = view.state.selection.main;
    this.savedSelection = selection.empty ? null : selection;
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", t("editor.cm.find"));
    this.searchInput.setAttribute("main-field", "true");
    for (const [key, label, text] of [
      ["caseSensitive", "search.option.case", "Cc"],
      ["wholeWord", "search.option.words", "W"],
      ["regexp", "search.option.regex", ".*"],
    ] as const) {
      const toggle = button(t(label), () => this.toggle(key));
      toggle.textContent = text;
      toggle.name = key;
      toggle.setAttribute("aria-pressed", "false");
      this.toggles.set(key, toggle);
      this.searchBox.append(toggle);
    }
    const actions = element("div", "forge-find-actions");
    this.counter.setAttribute("aria-live", "polite");
    this.counter.setAttribute("role", "status");
    this.filterToggle = button(t("editor.find.filter"), () => this.filters(), "filter");
    this.filterToggle.setAttribute("aria-haspopup", "menu");
    this.replaceToggle = button(t("editor.find.showReplace"), () => this.showReplace(this.replaceBox.hidden), "expand");
    this.replaceToggle.classList.add("forge-find-expand");
    this.navigation.push(
      button(`${t("editor.cm.previous")} (Shift+Enter)`, () => this.step(false), "previous"),
      button(`${t("editor.cm.next")} (Enter)`, () => this.step(true), "next"));
    actions.append(this.counter, ...this.navigation, this.filterToggle);
    const close = button(`${t("editor.cm.close")} (Esc)`, () => { closeFind(view); }, "close");
    close.classList.add("forge-find-close");
    for (const [label, command] of [["editor.cm.replace", replaceNext], ["editor.cm.replaceAll", replaceAll]] as const) {
      const action = button(t(label), () => {
        this.remember();
        command(view);
      });
      action.textContent = t(label);
      this.replaceActions.push(action);
      this.replaceButtons.append(action);
    }
    this.menu.hidden = true;
    this.menu.setAttribute("role", "menu");
    // IDEA 的替换箭头独占左列，两行输入框共用同一列，展开时不会横向跳动。
    this.dom.append(this.replaceToggle, this.searchBox, actions, close, this.replaceBox, this.replaceButtons, this.menu);
    this.dom.onkeydown = (event) => this.keydown(event);
    this.showReplace(false);
    this.refresh();
  }

  private input(name: "search" | "replace"): HTMLTextAreaElement {
    const input = element("textarea", "forge-find-input");
    input.name = name;
    input.rows = 1;
    input.wrap = "off";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = t(name === "search" ? "editor.cm.find" : "editor.cm.replace");
    input.setAttribute("aria-label", input.placeholder);
    input.oninput = () => this.commit(name === "search");
    return input;
  }

  private field(input: HTMLTextAreaElement): HTMLDivElement {
    const box = element("div", "forge-find-field");
    const recent = button(t("editor.find.history"), () => this.recent(input, recent), "history");
    recent.setAttribute("aria-haspopup", "menu");
    const newline = button(`${t("editor.find.newLine")} (Ctrl+Shift+Enter)`, () => this.newline(input), "newline");
    box.append(recent, input, newline);
    return box;
  }

  showReplace(show: boolean): void {
    show = show && !this.view.state.readOnly;
    this.replaceBox.hidden = this.replaceButtons.hidden = !show;
    this.replaceToggle.hidden = this.view.state.readOnly;
    this.replaceToggle.setAttribute("aria-pressed", String(show));
    this.replaceToggle.setAttribute("aria-expanded", String(show));
    const label = t(show ? "editor.find.hideReplace" : "editor.find.showReplace");
    this.replaceToggle.title = label;
    this.replaceToggle.setAttribute("aria-label", label);
    if (!show && this.replaceBox.contains(this.view.root.activeElement)) this.searchInput.focus();
    this.view.requestMeasure();
  }

  private commit(incremental = false): void {
    const previous = getSearchQuery(this.view.state);
    const query = new SearchQuery({ ...previous, search: this.searchInput.value, replace: this.replaceInput.value,
      literal: !previous.regexp, test: (_match, state, from, to) => accepts(_match, state, from, to) });
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (incremental && query.valid) {
      const from = this.view.state.selection.main.from;
      this.view.dispatch({ selection: { anchor: from } });
      findNext(this.view);
    }
  }

  private toggle(key: "caseSensitive" | "wholeWord" | "regexp"): void {
    const query = getSearchQuery(this.view.state);
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...query, [key]: !query[key], literal: key === "regexp" ? query.regexp : query.literal })) });
    this.commit(true);
  }

  private newline(input: HTMLTextAreaElement): void {
    const start = input.selectionStart;
    input.setRangeText("\n", start, input.selectionEnd, "end");
    this.commit(input === this.searchInput);
    input.focus();
  }

  private step(forward: boolean): void {
    this.remember();
    (forward ? findNext : findPrevious)(this.view);
  }

  remember(): void {
    remember("search", this.searchInput.value);
    if (!this.replaceBox.hidden) remember("replace", this.replaceInput.value);
  }

  private popup(anchor: HTMLButtonElement, items: Array<{ label: string; checked?: boolean; disabled?: boolean; run: () => void }>): void {
    const wasOpen = !this.menu.hidden && this.menuAnchor === anchor;
    this.hideMenu();
    if (wasOpen) return;
    this.menu.replaceChildren();
    for (const item of items) {
      const entry = button(item.label, () => { this.hideMenu(); this.searchInput.focus(); item.run(); });
      entry.textContent = item.label.replace(/\n/g, "⏎");
      entry.disabled = !!item.disabled;
      entry.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (item.checked !== undefined) entry.setAttribute("aria-checked", String(item.checked));
      this.menu.append(entry);
    }
    const own = this.dom.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    this.menu.style.left = `${Math.min(rect.left - own.left, Math.max(0, own.width - 280))}px`;
    this.menu.style.top = `${rect.bottom - own.top + 5}px`;
    this.menu.hidden = false;
    this.menuAnchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  private hideMenu(): void {
    this.menu.hidden = true;
    this.menuAnchor?.setAttribute("aria-expanded", "false");
    this.menuAnchor = null;
  }

  private recent(input: HTMLTextAreaElement, anchor: HTMLButtonElement): void {
    const values = history(input.name);
    this.popup(anchor, values.length ? values.map((value) => ({ label: value, run: () => {
      input.value = value;
      this.commit(input === this.searchInput);
      input.focus();
    } })) : [{ label: t("editor.find.noHistory"), disabled: true, run: () => {} }]);
  }

  private toggleScope(): void {
    const current = this.view.state.field(filter);
    const selection = this.view.state.selection.main;
    const saved = this.savedSelection;
    const scope = current.scope ? null : saved && saved.to <= this.view.state.doc.length ? saved : selection.empty ? null : selection;
    this.view.dispatch({ effects: setFilter.of({ ...current, scope }) });
    this.commit(true);
  }

  private filters(): void {
    const current = this.view.state.field(filter);
    const contexts: Array<[Context, TranslationKey]> = [
      ["any", "editor.find.anywhere"], ["comments", "editor.find.inComments"], ["strings", "editor.find.inStrings"],
      ["exceptComments", "editor.find.exceptComments"], ["exceptStrings", "editor.find.exceptStrings"], ["code", "editor.find.codeOnly"],
    ];
    this.popup(this.filterToggle, [
      { label: `${t("editor.find.inSelection")} (Alt+E)`, checked: !!current.scope,
        disabled: !current.scope && !this.savedSelection && this.view.state.selection.main.empty, run: () => this.toggleScope() },
      ...contexts.map(([context, label]) => ({ label: t(label), checked: current.context === context, run: () => {
        this.view.dispatch({ effects: setFilter.of({ ...this.view.state.field(filter), context }) });
        this.commit(true);
      } })),
    ]);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (!this.menu.hidden) {
      const entries = [...this.menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        const anchor = this.menuAnchor;
        this.hideMenu(); anchor?.focus(); return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = entries.indexOf(this.view.root.activeElement as HTMLButtonElement);
        entries[(index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length]?.focus();
        return;
      }
    }
    const input = event.target === this.replaceInput ? this.replaceInput : this.searchInput;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(this.view); }
    else if (event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.newline(input); }
    else if (event.key === "Tab" && !event.shiftKey && event.target === this.searchInput && !this.replaceBox.hidden) {
      event.preventDefault(); this.replaceInput.focus();
    }
    else if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = ({ KeyC: "caseSensitive", KeyW: "wholeWord", KeyX: "regexp" } as const)[event.code as "KeyC" | "KeyW" | "KeyX"];
      if (key) { event.preventDefault(); this.toggle(key); }
      else if (event.code === "KeyE") { event.preventDefault(); this.toggleScope(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); (input.parentElement?.firstChild as HTMLButtonElement).click(); }
    } else if (event.target instanceof HTMLTextAreaElement && (event.key === "Enter" || event.key === "F3" || (!input.value.includes("\n") && /ArrowUp|ArrowDown/.test(event.key)))) {
      event.preventDefault();
      if (input === this.replaceInput && event.key === "Enter" && !event.shiftKey) {
        this.remember(); (event.ctrlKey || event.metaKey ? replaceAll : replaceNext)(this.view);
      } else this.step(event.shiftKey || event.key === "ArrowUp" ? false : true);
    } else if (runScopeHandlers(this.view, event, "search-panel")) event.preventDefault();
  }

  private refresh(): void {
    const query = getSearchQuery(this.view.state);
    if (this.searchInput.value !== query.search) this.searchInput.value = query.search;
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace;
    for (const input of [this.searchInput, this.replaceInput]) input.rows = Math.min(5, input.value.split("\n").length);
    for (const [key, toggle] of this.toggles) toggle.setAttribute("aria-pressed", String(query[key]));
    let total = 0, current = 0, capped = false;
    if (query.valid) {
      const selected = this.view.state.selection.main;
      const cursor = query.getCursor(this.view.state);
      const start = performance.now();
      for (let result = cursor.next(); !result.done; result = cursor.next()) {
        total++;
        if (result.value.from === selected.from && result.value.to === selected.to) current = total;
        // 限制计数耗时；大文件仍由引擎负责导航，不阻塞输入。
        if (total >= 9_999 || (total % 256 === 0 && performance.now() - start > 30)) { capped = true; break; }
      }
    }
    const invalid = !!query.search && (!query.valid || total === 0);
    this.searchInput.setAttribute("aria-invalid", String(invalid));
    this.searchBox.classList.toggle("is-invalid", invalid);
    this.counter.textContent = query.search && !query.valid ? t("editor.find.badRegex") : !total ? t("editor.find.noResults") : `${current || "?"}/${total}${capped ? "+" : ""}`;
    this.counter.classList.toggle("is-invalid", invalid);
    const { scope, context } = this.view.state.field(filter);
    this.filterToggle.setAttribute("aria-pressed", String(!!scope || context !== "any"));
    for (const action of this.navigation) action.disabled = !query.valid || !total;
    for (const action of this.replaceActions) action.disabled = !query.valid || !total || this.view.state.readOnly;
    if (this.view.state.readOnly) this.showReplace(false);
  }

  private readonly outside = (event: Event) => { if (!this.dom.contains(event.target as Node)) this.hideMenu(); };
  focusSearch(): void {
    this.searchInput.focus(); this.searchInput.select();
  }
  mount(): void {
    this.view.dom.ownerDocument.addEventListener("pointerdown", this.outside);
    this.focusSearch();
  }
  update(update: ViewUpdate): void {
    if (update.docChanged && this.savedSelection) {
      this.savedSelection = { from: update.changes.mapPos(this.savedSelection.from, 1), to: update.changes.mapPos(this.savedSelection.to, -1) };
    }
    clearTimeout(this.timer);
    if (update.docChanged) this.timer = setTimeout(() => this.refresh(), 150);
    else if (update.selectionSet || update.transactions.some((tr) => tr.effects.length)) this.refresh();
  }
  destroy(): void {
    clearTimeout(this.timer);
    this.view.dom.ownerDocument.removeEventListener("pointerdown", this.outside);
    panels.delete(this.view);
  }
}

export const forgeSearch: Extension = [
  filter,
  search({ top: true, literal: true, createPanel: (view) => new FindPanel(view),
    scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }) }),
  Prec.high(keymap.of([
    { key: "Mod-f", run: (view) => openFind(view), scope: "editor search-panel" },
    { key: "Escape", run: closeFind, scope: "editor search-panel" },
  ])),
];
