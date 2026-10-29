import { describe, expect, it } from "vitest";
import {
  SETTINGS_TREE,
  filterSettingsTree,
  getPageBreadcrumb,
} from "../../src/features/settings/model/settingsModel";
import {
  resolvePageId,
  toLegacyModule,
} from "../../src/features/settings/model/legacyAdapter";

describe("openidea 设置菜单模型与路由适配器", () => {
  it("必须完整包含 8 大顶级分类且各分类子项齐全", () => {
    const topIds = SETTINGS_TREE.map((node) => node.id);
    expect(topIds).toEqual([
      "appearance",
      "keymap",
      "editor",
      "vcs",
      "project",
      "build",
      "languages",
      "tools",
    ]);

    // 验证 AI 助理完整归入工具子节点
    const toolsNode = SETTINGS_TREE.find((n) => n.id === "tools");
    expect(toolsNode).toBeDefined();
    const aiNode = toolsNode?.children?.find((c) => c.id === "tools.ai");
    expect(aiNode).toBeDefined();
    expect(aiNode?.children?.map((c) => c.id)).toEqual([
      "tools.ai.cli",
      "tools.ai.providers",
      "tools.ai.commit",
      "tools.ai.skills",
      "tools.ai.mcp",
      "tools.ai.hooks",
      "tools.ai.archived",
    ]);
  });

  it("支持中文、英文、拼音等多维度关键字搜索过滤", () => {
    // 搜索 "Git"：应命中版本控制节点（含 Git 关键词）
    const gitFiltered = filterSettingsTree(SETTINGS_TREE, "Git");
    expect(gitFiltered.some((n) => n.id === "vcs")).toBe(true);
    const vcsNode = gitFiltered.find((n) => n.id === "vcs");
    expect(vcsNode?.children?.some((c) => c.id === "vcs.git")).toBe(true);

    // 搜索 "MCP"：应命中工具下的 AI 助理下的 MCP 节点
    const mcpFiltered = filterSettingsTree(SETTINGS_TREE, "MCP");
    expect(mcpFiltered.length).toBe(1);
    expect(mcpFiltered[0]!.id).toBe("tools");

    // 空搜索词应返回完整树
    expect(filterSettingsTree(SETTINGS_TREE, "").length).toBe(8);
  });

  it("能为任意层级页面精准生成面包屑导航路径", () => {
    const crumb1 = getPageBreadcrumb("tools.ai.mcp");
    expect(crumb1).toEqual(["工具", "AI 助理", "MCP 服务协议"]);

    const crumb2 = getPageBreadcrumb("editor.font");
    expect(crumb2).toEqual(["编辑器", "字体"]);

    const crumbTop = getPageBreadcrumb("keymap");
    expect(crumbTop).toEqual(["按键映射"]);
  });

  it("向后兼容：旧版 SettingsModule 与新树形 PageId 双向无缝转换", () => {
    // 旧版 13 个模块全部能正确定位到新树节点
    expect(resolvePageId("general")).toBe("appearance.theme");
    expect(resolvePageId("editor")).toBe("editor.general");
    expect(resolvePageId("shortcuts")).toBe("keymap");
    expect(resolvePageId("terminal")).toBe("tools.terminal");
    expect(resolvePageId("lsp")).toBe("languages.lsp");
    expect(resolvePageId("aiCli")).toBe("tools.ai.cli");
    expect(resolvePageId("modelProviders")).toBe("tools.ai.providers");
    expect(resolvePageId("aiCommit")).toBe("tools.ai.commit");
    expect(resolvePageId("skills")).toBe("tools.ai.skills");
    expect(resolvePageId("mcp")).toBe("tools.ai.mcp");
    expect(resolvePageId("hooks")).toBe("tools.ai.hooks");
    expect(resolvePageId("aiArchived")).toBe("tools.ai.archived");
    expect(resolvePageId("about")).toBe("tools.about");

    // 反向映射
    expect(toLegacyModule("tools.ai.mcp")).toBe("mcp");
    expect(toLegacyModule("languages.lsp")).toBe("lsp");
    expect(toLegacyModule("unknown.id")).toBe("general");
  });
});
