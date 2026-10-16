import { samePath } from "./format";
import { monaco } from "./monacoEditor";
import { KEPT_FILE_MODELS, nextKeptPaths } from "./keptModels";

export { KEPT_FILE_MODELS, nextKeptPaths };

let recent: string[] = [];
let retaining = false;

/** dispose 正在回收超限 model。这段时间里光标记录要留着。 */
export function isRetainingModels(): boolean {
  return retaining;
}

/** 把不在最近几篇里的文件 model 关掉。比对用的内存 model 不动。 */
export function retainEditorModels(activePath: string | null, openPaths: readonly string[]): void {
  recent = nextKeptPaths(recent, activePath, openPaths, KEPT_FILE_MODELS);
  const keep = recent;
  retaining = true;
  try {
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== "file") continue;
      const path = model.uri.fsPath;
      if (!openPaths.some((item) => samePath(item, path))) continue;
      if (keep.some((item) => samePath(item, path))) continue;
      model.dispose();
    }
  } finally {
    retaining = false;
  }
}
