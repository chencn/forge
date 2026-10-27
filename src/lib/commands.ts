/**
 * 命令面板里的一条动作。
 *
 * App 在渲染期把可独立执行的操作（打开面板、运行、保存……）汇成一张表交给
 * 随处搜索的「动作」页签；label 在构造处就已经翻译好，shortcut 只是展示串，
 * 真正的键位匹配仍由各自的 keydown 监听器用 shortcuts.ts 完成。
 */
export interface ForgeCommand {
  /** 稳定 id，测试与未来的键位指派都用它对齐。 */
  id: string;
  /** 已翻译的展示名。 */
  label: string;
  /** 展示用的组合键（如 "Ctrl+Shift+F"）；上下文动作可能没有。 */
  shortcut?: string;
  run: () => void;
}
