/** 从现有 Lezer 树生成导航大纲，不启动语言服务器，也不扫描磁盘上的旧正文。 */
import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { reportOutline, type OutlineSymbol } from "../editorOutline";

const DECLARATIONS: Record<string, OutlineSymbol["kind"]> = {
  FunctionDeclaration: "function", FunctionDefinition: "function", FunctionItem: "function",
  MethodDeclaration: "method", MethodDefinition: "method", ConstructorDeclaration: "method",
  ClassDeclaration: "class", ClassDefinition: "class", StructItem: "class", ImplItem: "class",
  InterfaceDeclaration: "interface", TraitItem: "interface",
  TypeAliasDeclaration: "type", TypeDeclaration: "type", TypeItem: "type",
  EnumDeclaration: "enum", EnumItem: "enum",
  NamespaceDeclaration: "namespace", ModuleDeclaration: "namespace", ModItem: "namespace",
  PropertyDeclaration: "property", Property: "property",
  VariableDeclarator: "variable", ConstItem: "variable", StaticItem: "variable", LetDeclaration: "variable",
};
const NAME = /^(VariableDefinition|VariableName|PropertyDefinition|TypeDefinition|Definition|BoundIdentifier|TypeIdentifier|Identifier|PropertyName|Name|TypeName)$/;
const DEFINITION_NAME = /^(VariableDefinition|PropertyDefinition|TypeDefinition|Definition|BoundIdentifier)$/;

export function extractOutline(state: EditorState): OutlineSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 25) ?? syntaxTree(state);
  const text = (node: SyntaxNode) => state.sliceDoc(node.from, node.to).replace(/\s+/g, " ").slice(0, 120);
  const nameOf = (node: SyntaxNode) => {
    let fallback: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      // Java 方法的返回 TypeName 在声明 Definition 前面，优先取明确的名字节点。
      if (DEFINITION_NAME.test(child.name)) return child;
      if (!fallback && NAME.test(child.name)) fallback = child;
    }
    return fallback;
  };
  const labelOf = (node: SyntaxNode) => {
    const raw = text(node);
    const quote = raw[0];
    // JSON 的 PropertyName 就是带引号的字符串节点，导航里只显示键名。
    const quoted = node.name === "PropertyName"
      && raw.length >= 2
      && (quote === "\"" || quote === "'")
      && raw.endsWith(quote);
    return { name: quoted ? raw.slice(1, -1) : raw, selectionFrom: quoted ? node.from + 1 : node.from };
  };
  const make = (node: SyntaxNode, name: SyntaxNode, kind: OutlineSymbol["kind"]): OutlineSymbol => {
    const label = labelOf(name);
    return { name: label.name, kind, from: node.from, to: node.to, selectionFrom: label.selectionFrom, children: [] };
  };
  const visit = (node: SyntaxNode, into: OutlineSymbol[]) => {
    // JS/TS 的一次声明可包含多个绑定，每个绑定只管自己的初始化范围。
    if (node.name === "VariableDeclaration") {
      let target = into;
      let previous: OutlineSymbol | undefined;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "VariableDefinition" || child.name === "ArrayPattern" || child.name === "ObjectPattern") {
          if (previous) previous.to = child.from;
          previous = make(node, child, "variable");
          previous.from = child.from;
          into.push(previous);
          target = previous.children;
        } else visit(child, target);
      }
      return;
    }
    let target = into;
    const kind = DECLARATIONS[node.name];
    const name = kind ? nameOf(node) : null;
    if (kind && name) {
      const item = make(node, name, kind);
      into.push(item);
      target = item.children;
    } else if (node.name === "ArrowFunction" || node.name === "FunctionExpression") {
      const parent = node.parent;
      const argument = parent && /^(ArgList|Arguments|ArgumentList)$/.test(parent.name);
      const callee = argument ? parent.parent?.firstChild : null;
      const ownName = nameOf(node);
      // 参数名不是函数名：匿名回调沿调用表达式命名，保留 filter/map/useMemo 等层级。
      const label = callee ? `${text(callee)}() callback` : node.name === "FunctionExpression" && ownName ? text(ownName) : null;
      if (label) {
        const item: OutlineSymbol = { name: label, kind: "function", from: node.from, to: node.to, selectionFrom: node.from, children: [] };
        into.push(item);
        target = item.children;
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, target);
  };
  const items: OutlineSymbol[] = [];
  visit(tree.topNode, items);
  return items;
}

/** 仅由源码编辑器装配：分栏各持一份大纲，diff/聊天预览不会覆盖导航状态。 */
export function outlineExtension(pathOf: (state: EditorState) => string) {
  return ViewPlugin.fromClass(class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private items: OutlineSymbol[] = [];
    constructor(private view: EditorView) { this.refresh(); }
    private publish() {
      const path = pathOf(this.view.state);
      if (path) reportOutline(path, this.items, this.view.state.selection.main.head);
    }
    private refresh() {
      this.items = extractOutline(this.view.state);
      this.publish();
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        // 防抖解析期间同步映射范围，避免快速编辑后立即点击跳到旧偏移。
        const map = (items: OutlineSymbol[]): OutlineSymbol[] => items.map((item) => ({
          ...item, from: update.changes.mapPos(item.from), to: update.changes.mapPos(item.to, 1),
          selectionFrom: update.changes.mapPos(item.selectionFrom), children: map(item.children),
        }));
        this.items = map(this.items);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 150);
      } else if (syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.refresh();
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) this.publish();
    }
    destroy() { clearTimeout(this.timer); }
  });
}
