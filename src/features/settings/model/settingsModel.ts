import type { ComponentType, ReactNode } from "react";

export interface SettingsOptionSpec {
  id: string;
  label: string;
  hint?: ReactNode;
  keywords?: string[];
}

export interface SettingsSectionSpec {
  title?: string;
  description?: string;
  options?: SettingsOptionSpec[];
}

export interface SettingsPageSpec {
  id: string;
  title: string;
  group?: string;
  order: number;
  keywords?: string[];
  sections?: SettingsSectionSpec[];
  /** 自定义渲染的设置页组件 */
  component?: ComponentType<SettingsPageProps>;
}

export interface SettingsPageProps {
  workspace: string | null;
  onLspKick?: () => void;
  onLspWake?: (server: string) => Promise<boolean>;
}

export interface SettingsTreeNode {
  id: string;
  title: string;
  pageId?: string;
  group?: string;
  keywords?: string[];
  children?: SettingsTreeNode[];
}

/** 8 大顶级分类定义 */
export const SETTINGS_GROUPS = [
  { id: "appearance", title: "外观与行为" },
  { id: "keymap", title: "按键映射" },
  { id: "editor", title: "编辑器" },
  { id: "vcs", title: "版本控制" },
  { id: "project", title: "项目结构" },
  { id: "build", title: "构建、执行、部署" },
  { id: "languages", title: "语言与框架" },
  { id: "tools", title: "工具" },
] as const;

/**
 * 完整设置菜单树结构（包含 8 大分类及全部子菜单）
 */
export const SETTINGS_TREE: SettingsTreeNode[] = [
  {
    id: "appearance",
    title: "外观与行为",
    children: [
      { id: "appearance.general", pageId: "appearance.general", title: "外观", keywords: ["主题", "Theme", "Dark", "Light", "界面缩放", "配色"] },
      { id: "appearance.system", pageId: "appearance.system", title: "系统设置", keywords: ["启动", "关闭", "工作区", "Multi-root", "更新", "Update"] },
      { id: "appearance.notifications", pageId: "appearance.notifications", title: "通知", keywords: ["气泡", "Toast", "位置", "Position", "免打扰"] },
    ],
  },
  {
    id: "keymap",
    pageId: "keymap",
    title: "按键映射",
    keywords: ["快捷键", "Keymap", "Hotkeys", "VS Code", "IntelliJ", "Sublime", "Keybindings"],
  },
  {
    id: "editor",
    title: "编辑器",
    children: [
      { id: "editor.general", pageId: "editor.general", title: "常规", keywords: ["保存", "Save", "滚动", "Scroll", "光标闪烁", "Caret"] },
      { id: "editor.font", pageId: "editor.font", title: "字体", keywords: ["Font", "字体大小", "字号", "行高", "Line height"] },
      { id: "editor.colorScheme", pageId: "editor.colorScheme", title: "配色方案", keywords: ["语法高亮", "Color Scheme", "Token colors"] },
      { id: "editor.codeStyle", pageId: "editor.codeStyle", title: "代码样式", keywords: ["Tab", "制表符", "Indent", "缩进", "空格"] },
      { id: "editor.fileTypes", pageId: "editor.fileTypes", title: "文件类型", keywords: ["忽略文件", "Ignored", "隐藏文件", "Hidden", "Exclude"] },
      { id: "editor.minimap", pageId: "editor.minimap", title: "缩略图", keywords: ["Minimap", "代码小地图", "代码概览"] },
    ],
  },
  {
    id: "vcs",
    title: "版本控制",
    children: [
      { id: "vcs.general", pageId: "vcs.general", title: "版本控制", keywords: ["Git", "VCS", "版本管理", "仓库"] },
      { id: "vcs.git", pageId: "vcs.git", title: "Git", keywords: ["Git 路径", "提交", "Commit", "Push", "分支"] },
      { id: "vcs.confirmation", pageId: "vcs.confirmation", title: "确认与回滚", keywords: ["危险操作", "回滚", "Rollback", "二次确认", "Discard"] },
    ],
  },
  {
    id: "project",
    title: "项目结构",
    children: [
      { id: "project.sdk", pageId: "project.sdk", title: "SDK 与运行环境", keywords: ["SDK", "JDK", "Node", "Rust", "Toolchain", "工具链"] },
      { id: "project.roots", pageId: "project.roots", title: "内容根与模块", keywords: ["Content Root", "Modules", "工作区根", "源码目录"] },
    ],
  },
  {
    id: "build",
    title: "构建、执行、部署",
    children: [
      { id: "build.tools", pageId: "build.tools", title: "构建工具", keywords: ["Maven", "Cargo", "Gradle", "NPM", "Build"] },
      { id: "build.runConfigs", pageId: "build.runConfigs", title: "运行/调试配置", keywords: ["Run", "Debug", "运行配置", "Run Targets"] },
      { id: "build.deployment", pageId: "build.deployment", title: "部署与连接", keywords: ["Deployment", "SSH", "Remote", "远端同步"] },
    ],
  },
  {
    id: "languages",
    title: "语言与框架",
    children: [
      { id: "languages.lsp", pageId: "languages.lsp", title: "语言服务器 (LSP)", keywords: ["LSP", "Language Server", "Rust Analyzer", "TypeScript", "Python", "gopls"] },
      { id: "languages.schemas", pageId: "languages.schemas", title: "模式与语法", keywords: ["JSON Schema", "YAML", "Grammars", "代码补全"] },
    ],
  },
  {
    id: "tools",
    title: "工具",
    children: [
      {
        id: "tools.ai",
        title: "AI 助理",
        children: [
          { id: "tools.ai.cli", pageId: "tools.ai.cli", title: "命令行与会话", keywords: ["AI", "Claude", "Codex", "Chat", "会话保留", "Token"] },
          { id: "tools.ai.providers", pageId: "tools.ai.providers", title: "模型提供商", keywords: ["API Key", "Anthropic", "OpenAI", "Endpoint", "模型"] },
          { id: "tools.ai.commit", pageId: "tools.ai.commit", title: "智能 Git 提交", keywords: ["AI Commit", "提交信息生成", "Prompt"] },
          { id: "tools.ai.skills", pageId: "tools.ai.skills", title: "技能与提示词", keywords: ["Skills", "Prompts", "技能扩展"] },
          { id: "tools.ai.mcp", pageId: "tools.ai.mcp", title: "MCP 服务协议", keywords: ["MCP", "Model Context Protocol", "上下文扩展"] },
          { id: "tools.ai.hooks", pageId: "tools.ai.hooks", title: "自动化钩子", keywords: ["Hooks", "自动化", "生命周期"] },
          { id: "tools.ai.archived", pageId: "tools.ai.archived", title: "归档会话", keywords: ["Archived", "历史归档", "导出"] },
        ],
      },
      { id: "tools.terminal", pageId: "tools.terminal", title: "终端", keywords: ["Terminal", "Shell", "PowerShell", "CMD", "Bash", "响铃", "光标"] },
      { id: "tools.diff", pageId: "tools.diff", title: "差异与合并", keywords: ["Diff", "Merge", "HTTP Response", "冲突解决"] },
      { id: "tools.external", pageId: "tools.external", title: "外部工具", keywords: ["External Tools", "外部命令", "命令行工具"] },
      { id: "tools.about", pageId: "tools.about", title: "关于", keywords: ["About", "版本", "检查更新", "Updater", "License"] },
    ],
  },
];

/**
 * 将树展开为列表，方便平铺搜索
 */
export function flattenTree(nodes: SettingsTreeNode[], parentTitles: string[] = []): Array<{ node: SettingsTreeNode; path: string[] }> {
  const result: Array<{ node: SettingsTreeNode; path: string[] }> = [];
  for (const n of nodes) {
    const currentPath = [...parentTitles, n.title];
    result.push({ node: n, path: currentPath });
    if (n.children && n.children.length > 0) {
      result.push(...flattenTree(n.children, currentPath));
    }
  }
  return result;
}

/**
 * 根据搜索关键字过滤树节点
 */
export function filterSettingsTree(nodes: SettingsTreeNode[], query: string): SettingsTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  function filterNode(node: SettingsTreeNode): SettingsTreeNode | null {
    const titleMatch = node.title.toLowerCase().includes(q);
    const keywordMatch = node.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false;
    const filteredChildren = node.children
      ? node.children.map(filterNode).filter((c): c is SettingsTreeNode => c !== null)
      : undefined;

    if (titleMatch || keywordMatch || (filteredChildren && filteredChildren.length > 0)) {
      return {
        ...node,
        children: filteredChildren,
      };
    }
    return null;
  }

  return nodes.map(filterNode).filter((n): n is SettingsTreeNode => n !== null);
}

/**
 * 获取某个页面的面包屑路径
 */
export function getPageBreadcrumb(pageId: string, nodes: SettingsTreeNode[] = SETTINGS_TREE, currentPath: string[] = []): string[] | null {
  for (const node of nodes) {
    const nextPath = [...currentPath, node.title];
    if (node.pageId === pageId) {
      return nextPath;
    }
    if (node.children) {
      const found = getPageBreadcrumb(pageId, node.children, nextPath);
      if (found) return found;
    }
  }
  return null;
}
