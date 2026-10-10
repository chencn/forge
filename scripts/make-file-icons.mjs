/**
 * 生成脚本：把文件图标数据产出成一份「禁止手改」的 TypeScript 模块。
 *
 *   node scripts/make-file-icons.mjs
 *
 * 两级数据源，IDEA 优先、material 兜底：
 *   1. scripts/idea-icons/ —— 移植自 IntelliJ 的图标与映射（Apache 2.0），风格与 IDE 一致
 *   2. node_modules/material-icon-theme —— VS Code 官方文件图标主题（MIT），
 *      补 IDEA 没有的那些（package.json、pom.xml、yarn.lock…）
 *
 * 产出：
 *   src/lib/fileIconData.ts —— 映射表 + 内联 SVG（浅色与深色两套）
 *
 * 升级上游后：换掉 scripts/idea-icons/ 下的图标，或升级 material-icon-theme，再跑一次本脚本。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ICON_DIR = path.join(ROOT, "scripts/idea-icons");
const MATERIAL_DIR = path.join(ROOT, "node_modules/material-icon-theme");
const MATERIAL_JSON = path.join(MATERIAL_DIR, "dist/material-icons.json");
const OUT = path.join(ROOT, "src/lib/fileIconData.ts");

const mappings = JSON.parse(readFileSync(path.join(ICON_DIR, "mappings.json"), "utf8"));

/** 递归列出目录下所有 .svg，返回相对 ICON_DIR 的 posix 风格路径。 */
function listSvgs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSvgs(full));
    else if (name.endsWith(".svg")) out.push(path.relative(ICON_DIR, full).replaceAll("\\", "/"));
  }
  return out;
}

/**
 * 压缩 SVG：去换行、合并标签间空白、剥掉 <title> 与版权注释。
 * @description 行上已有 tooltip，装饰图标不该再带 title；版权注释每份都重复，压缩掉省体积，
 *   授权声明在 scripts/idea-icons/LICENSE.txt 与 NOTICE.txt 里统一保留。
 */
function compact(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\r?\n/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

// ---- 第一级：IDEA 图标（深浅两套分开收） ----
const light = {};
const dark = {};
for (const rel of listSvgs(ICON_DIR)) {
  const svg = compact(readFileSync(path.join(ICON_DIR, rel), "utf8"));
  if (/_dark\.svg$/.test(rel)) dark[rel] = svg;
  else light[rel] = svg;
}

/**
 * IDEA 的通用图标：指向它的映射说明 IDEA 对这个类型没有专属图标，
 * 这种条目要让位给 material，否则 `avi`、`mp4` 这些会一直顶着灰色文本图标。
 */
const IDEA_GENERIC = new Set([mappings.defaultFile, mappings.unknown]);

// ---- 第二级：material 图标（补 IDEA 缺的） ----
if (!existsSync(MATERIAL_JSON)) {
  throw new Error(
    `找不到 ${path.relative(ROOT, MATERIAL_JSON)}，先跑 npm install（material-icon-theme 是生成期的依赖）`
  );
}
const material = JSON.parse(readFileSync(MATERIAL_JSON, "utf8"));

/** material 图标 id → 统一的相对路径键；前缀 `material/` 和 IDEA 那套隔开，免得撞名。 */
const materialPath = (id) => `material/${id}.svg`;

/**
 * 取一个 material 图标的压缩 SVG。
 * @param id 图标 id
 * @returns SVG 文本；id 不存在或文件缺失时为空串
 */
function materialSvg(id) {
  const def = material.iconDefinitions[id];
  if (!def) return "";
  const file = path.resolve(MATERIAL_DIR, "dist", def.iconPath);
  if (!existsSync(file)) return "";
  return compact(readFileSync(file, "utf8"));
}

// 合并扩展名：material 打底，IDEA 的专属图标盖上去。
// IDEA 指向通用图标的条目不算「有」，跳过，让 material 的专属图标顶上来。
//
// material 的表里有两种键：单段（`rs`）和多段后缀（`d.ts`、`schema.json`）。
// 后者按 VS Code 的规矩是「文件名以它结尾就算」，不能塞进单段表——单段表只取
// 最后一个点之后，`foo.d.ts` 永远匹配不到 `d.ts`。分开放，解析时先查后缀表。
const extensions = {};
const suffixes = {};
for (const [ext, id] of Object.entries(material.fileExtensions)) {
  const svg = materialSvg(id);
  if (!svg) continue;
  light[materialPath(id)] = svg;
  if (ext.includes(".")) suffixes[ext] = materialPath(id);
  else extensions[ext] = materialPath(id);
}
for (const [ext, rel] of Object.entries(mappings.extensions)) {
  if (!IDEA_GENERIC.has(rel)) extensions[ext] = rel;
}

// 合并完整文件名：material 的那份最全（package.json、pom.xml…），IDEA 侧没有同名表。
const fileNames = {};
for (const [name, id] of Object.entries(material.fileNames)) {
  const svg = materialSvg(id);
  if (svg) {
    light[materialPath(id)] = svg;
    fileNames[name] = materialPath(id);
  }
}

// 目录名：只认 IDEA 那份（.git / build / dist / out / target…），不接 material 的
// 四千多条目录映射——目录图标保持 IDEA 一套，风格统一，也省掉上百 KB。
const folders = { ...mappings.folders };

const code = `/**
 * 文件图标数据 (src/lib/fileIconData.ts)
 * 【生成文件 · 禁止手改】由 scripts/make-file-icons.mjs 产出。
 *
 * 两级来源，IDEA 优先、material 兜底：
 *   - intellij-community 的 expui / language 图标（Apache 2.0，见 scripts/idea-icons/LICENSE.txt、NOTICE.txt）
 *   - vscode-material-icon-theme（MIT，见 node_modules/material-icon-theme/LICENSE）
 * 浅色 ${Object.keys(light).length} 个，深色 ${Object.keys(dark).length} 个。
 */

/** 扩展名（小写、不含点）→ 图标相对路径。 */
export const EXTENSION_ICONS: Record<string, string> = ${JSON.stringify(extensions)};

/** 多段后缀（小写、含点，如 d.ts / schema.json）→ 图标相对路径；文件名以它结尾即命中。 */
export const SUFFIX_ICONS: Record<string, string> = ${JSON.stringify(suffixes)};

/** 精确文件名（小写）→ 图标相对路径。先查这里，未命中再按扩展名。 */
export const FILE_NAME_ICONS: Record<string, string> = ${JSON.stringify(fileNames)};

/** 目录名（小写）→ 图标相对路径。 */
export const FOLDER_ICONS: Record<string, string> = ${JSON.stringify(folders)};

/** 无法识别时的通用文件图标。 */
export const DEFAULT_FILE = ${JSON.stringify(mappings.defaultFile)};
/** 通用文件夹图标。 */
export const DEFAULT_FOLDER = ${JSON.stringify(mappings.defaultFolder)};

/** 浅色主题：图标相对路径 → 内联 SVG。 */
export const ICONS_LIGHT: Record<string, string> = ${JSON.stringify(light)};

/** 深色主题：图标相对路径 → 内联 SVG。未收录的路径回退到浅色。 */
export const ICONS_DARK: Record<string, string> = ${JSON.stringify(dark)};
`;

writeFileSync(OUT, code);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log("✅ 已生成 src/lib/fileIconData.ts");
console.log(`   浅色 ${Object.keys(light).length} 个，深色 ${Object.keys(dark).length} 个`);
console.log(`   扩展名 ${Object.keys(extensions).length} 条，文件名 ${Object.keys(fileNames).length} 条，目录 ${Object.keys(folders).length} 条`);
console.log(`   体积 ${kb(Buffer.byteLength(code))}`);
