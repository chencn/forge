// 动画按组件定义执行；禁止重新引入跟随系统偏好关闭动画的隐式模式。
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../src", import.meta.url));
const forbidden = /\bprefers-reduced-motion\b/i;
const violations = [];
let checked = 0;

function report(file, source, position) {
  const line = source.slice(0, position).split("\n").length;
  violations.push(`${relative(root, file)}:${line}`);
}

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) { checkDirectory(file); continue; }
    if (!/\.(css|[cm]?[jt]sx?)$/.test(extname(file))) continue;
    checked++;
    const source = readFileSync(file, "utf8");
    if (extname(file) === ".css") {
      // 保留换行及字符位置，注释中的说明不算媒体查询。
      const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "));
      const match = forbidden.exec(css);
      if (match) report(file, source, match.index);
    } else {
      // 检查字符串值，覆盖 matchMedia 和 CSS-in-JS，同时忽略注释。
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && forbidden.test(node.text)) {
          report(file, source, node.getStart(tree));
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
}

checkDirectory(root);
if (violations.length) {
  console.error(`禁止按系统动画偏好关闭或削弱 Forge 动画：\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`动画策略检查通过（${checked} 个源文件）。`);
}
