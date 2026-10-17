import { invoke } from "@tauri-apps/api/core";

/** macOS 的主修饰键是 Cmd 不是 Ctrl：窗口级快捷键与菜单文案都按平台取。 */
export const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent);

/** 资源管理器右键菜单只在 Windows 上登记。 */
export const IS_WINDOWS =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** 快捷键文案里的主修饰键（Ctrl / Cmd）。 */
export const MOD_LABEL = IS_MAC ? "Cmd" : "Ctrl";

/** 一组同归属的进程，来自 Rust `MemoryPart`。 */
export interface MemoryPart {
  /** host 是宿主自身，webview 是 WebView2 的渲染进程，child 是本应用派生的其它进程。 */
  kind: "host" | "webview" | "child";
  /** 可执行文件名，小写；host 档为空串。 */
  program: string;
  /** 该档进程私有工作集的合计，MB。 */
  mb: number;
  /** 该档进程数。 */
  count: number;
}

/** 进程内存读数，来自 Rust `Memory`。 */
export interface Memory {
  /** 本应用及其全部后代进程的合计私有工作集，MB。不用工作集：那会把共享页在每个进程各算一遍。 */
  appMb: number;
  /** 物理内存总量，MB；取不到时为 0。 */
  totalMb: number;
  /** 分组明细，占用降序。各档取整后相加，所以合计恒等于各档之和。 */
  parts: MemoryPart[];
}

export function sysMemory(): Promise<Memory> {
  return invoke<Memory>("sys_memory");
}
