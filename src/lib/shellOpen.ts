import { invoke } from "@tauri-apps/api/core";

/** 一次从资源管理器带进来的路径。文件夹和文本文件已经在后端分开。 */
export interface ShellPlan {
  folders: string[];
  files: string[];
}

/** 按当前开关把资源管理器右键菜单写成一致的状态。
 *
 * 返回 `null` 表示一切正常；返回字符串表示 Win11 新菜单没装上、已退回经典动词，
 * 设置页应当把这条原因报给用户。 */
export function applyShellIntegration(input: {
  openFolder: boolean;
  openFile: boolean;
  defaultFile: boolean;
  label: string;
  extraExtensions: string[];
}): Promise<string | null> {
  return invoke<string | null>("shell_integration_apply", input);
}

/** 内置文本扩展名。设置页用来拦住对已有格式的修改。 */
export function builtinShellExtensions(): Promise<string[]> {
  return invoke<string[]>("shell_builtin_extensions");
}

/** 取走还没处理的启动路径。没有时两列都是空的。 */
export function takeShellOpen(): Promise<ShellPlan> {
  return invoke<ShellPlan>("shell_open_take");
}
