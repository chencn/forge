import { joinPath, samePath } from "./format";
import { RUN_KIND_ORDER } from "./runIcons";
import type { RunConfiguration } from "./runConfigs";

/** 装订线上的一个落点：这一行有几条可跑的。 */
export interface RunGutterTarget {
  line: number;
  /** 至少一条。同一行落进好几条时按位次排好，第一条就是默认那条。 */
  configs: RunConfiguration[];
}

/** 类型在权威列表里的位次；列表里没有的排到最后。 */
function rankOf(config: RunConfiguration): number {
  const at = RUN_KIND_ORDER.indexOf(config.kind);
  return at < 0 ? RUN_KIND_ORDER.length : at;
}

/**
 * 这一篇文档里哪几行有可跑的声明。
 *
 * 同一行可以落进好几条配置：一个带 `@SpringBootApplication` 的类既是 `bootRun` 那条也是主类那条；
 * 把 scripts 写成一行内联对象的 `package.json`，几条脚本也挤在同一行。装订线只画一个图标，
 * 所以把这一行的几条都交出去，由点的那一侧决定是直接跑还是让他挑。
 */
export function gutterTargets(
  configs: RunConfiguration[],
  root: string,
  docPath: string
): RunGutterTarget[] {
  if (!root || !docPath) return [];
  const byLine = new Map<number, RunConfiguration[]>();
  for (const config of configs) {
    if (config.unavailable) continue;
    for (const marker of config.markers ?? []) {
      if (!marker.file || marker.line < 1) continue;
      if (!samePath(joinPath(root, marker.file), docPath)) continue;
      const held = byLine.get(marker.line);
      if (!held) byLine.set(marker.line, [config]);
      else if (!held.some((item) => item.id === config.id)) held.push(config);
    }
  }
  return [...byLine.entries()]
    .map(([line, list]) => ({
      line,
      configs: list.sort((a, b) => rankOf(a) - rankOf(b)),
    }))
    .sort((a, b) => a.line - b.line);
}
