import { KEPT_FILE_MODELS, nextKeptPaths } from "./keptModels";

export { KEPT_FILE_MODELS, nextKeptPaths };

/** 引擎手上那份「这篇还留不留」的清理：名单在本模块算，删什么由引擎自己决定。 */
type RetentionSweep = (keep: readonly string[], openPaths: readonly string[]) => void;

let recent: string[] = [];
const sweeps: RetentionSweep[] = [];

/**
 * 编辑器模块在自身加载时登记回收，返回退订。
 *
 * 本模块不 import 任何引擎：它只算「最近看过的哪几篇该留着」，删哪份由引擎自己认。
 * 登记的就正文编辑器那一层（`cmEditor.ts`）；比对页那些一次性的视图不占常驻 state，不进这里。
 */
export function registerRetentionSweep(sweep: RetentionSweep): () => void {
  sweeps.push(sweep);
  return () => {
    const at = sweeps.indexOf(sweep);
    if (at >= 0) sweeps.splice(at, 1);
  };
}

/** 把不在最近几篇里的正文 model 关掉；标签还在，切回来用文档正文重建。 */
export function retainEditorModels(activePath: string | null, openPaths: readonly string[]): void {
  recent = nextKeptPaths(recent, activePath, openPaths, KEPT_FILE_MODELS);
  for (const sweep of sweeps) sweep(recent, openPaths);
}
