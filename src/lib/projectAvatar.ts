/**
 * 项目色和两字头像，对照 Lithe 的 Islands 配色。
 * 颜色由路径的 FNV-1a 决定，同一个工程每次都是同一档。
 */

const PROJECT_GRADIENT_COLOR_COUNT = 9;
const FNV_OFFSET_BASIS = 14_695_981_039_346_656_037n;
const FNV_PRIME = 1_099_511_628_211n;
const UINT64_MASK = (1n << 64n) - 1n;

/** 浅色顶栏晕染色，对应 RecentProject.ColorN.MainToolbarGradientStart。 */
export const PROJECT_GRADIENT_LIGHT = [
  "#f7d7cb",
  "#f5e6b8",
  "#e2f2c9",
  "#cbe4f7",
  "#d4d2fc",
  "#ecd3f5",
  "#e4d3f5",
  "#cef0e9",
  "#ceedd4",
] as const;

/** 深色顶栏晕染色。 */
export const PROJECT_GRADIENT_DARK = [
  "#664832",
  "#5e4724",
  "#45522f",
  "#335661",
  "#394773",
  "#613861",
  "#503d70",
  "#325959",
  "#365439",
] as const;

/** 头像渐变：左下是 end，右上是 start。 */
const PROJECT_AVATAR_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#e08855", "#e9806f"],
  ["#b08b14", "#bb7f19"],
  ["#a1a359", "#87aa59"],
  ["#3b92b8", "#6183ec"],
  ["#3574f0", "#7a64f0"],
  ["#c84d8f", "#a956cf"],
  ["#955ae0", "#a84de0"],
  ["#24a394", "#279ccd"],
  ["#5fad65", "#3d968b"],
];

/** 1 到 9。Windows 路径不分大小写，斜杠先归一。 */
export function getProjectGradientColorIndex(projectPath: string): number {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(normalized)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MASK;
  }
  return Number(hash % BigInt(PROJECT_GRADIENT_COLOR_COUNT)) + 1;
}

export function getProjectAvatarBackground(projectPath: string): string {
  const [start, end] = PROJECT_AVATAR_GRADIENTS[getProjectGradientColorIndex(projectPath) - 1];
  return `linear-gradient(to top right, ${end}, ${start})`;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** 两个字：驼峰取大写，否则用分隔符切开的首尾两词。 */
export function getProjectAvatarInitials(name: string): string {
  const camelCase = camelCaseInitials(name);
  if (camelCase.length === 2) return camelCase;

  const text = name.trim();
  for (const delimiters of [" ", ",", "-", "_", ".", "`'\""]) {
    const words = text
      .split(new RegExp(`[${delimiters.replace(/[-\\\]^]/g, "\\$&")}]`))
      .map((word) => Array.from(word).filter((character) => LETTER_OR_DIGIT.test(character)))
      .filter((characters) => characters.length > 0);
    if (words.length >= 2) {
      return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
    }
  }

  return camelCase;
}

function camelCaseInitials(text: string): string {
  const characters = Array.from(text);
  const start = characters.findIndex((character) => /\p{L}/u.test(character));
  if (start < 0) return "";

  const initials: string[] = [];
  for (let index = start; index < characters.length; index++) {
    const character = characters[index];
    if (!LETTER_OR_DIGIT.test(character)) break;
    if (index === start || /\p{Lu}/u.test(character)) initials.push(character);
    if (initials.length === 2) break;
  }
  return initials.join("").toUpperCase();
}
