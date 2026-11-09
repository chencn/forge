// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import GitPanel from "../../src/components/GitPanel";
import GitViewTabs from "../../src/components/GitViewTabs";
import type { GitView } from "../../src/components/GitPanel";
import type { GitState } from "../../src/hooks/useGitState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: {
      vcs: {
        nonModalCommit: true, showRightMargin: false, limitSubjectLine: false, limitBodyLine: false,
        blankLineAfterSubject: false, wrapRightMargin: false, subjectLineLimit: 72, bodyLineLimit: 72,
        signOffCommit: false, checkTodo: false, warnBadFileNames: false, warnCrlf: false,
        warnDetachedHead: false, warnLargeFiles: false, warnBadCharConfirm: false, warnReservedConfirm: false,
        warnRebaseConfirm: false, warnCrlfConfirm: false, warnDetachedConfirm: false, largeFilesLimitMb: 10,
        clearInitialCommitMessage: false, issueNavigationPatterns: [], protectedBranches: "",
      },
    },
  }),
}));
vi.mock("../../src/lib/aiCommit", () => ({
  useAiCommitEnabled: () => false,
  loadAiCommitConfig: () => ({}),
  collectFilesDiff: vi.fn(async () => ""),
  generateAiCommitMessage: vi.fn(),
  cancelAiCommit: vi.fn(async () => true),
  formatAiCommitError: (error: unknown) => String(error),
}));
vi.mock("../../src/i18n", async (original) => ({
  ...await original<typeof import("../../src/i18n")>(),
  useI18n: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));

type PanelProps = ComponentProps<typeof GitPanel>;

let host: HTMLDivElement;
let root: Root;
let git: GitState;
let view: GitView;
let props: PanelProps;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  view = "commit";
  git = {
    root: "D:/repo",
    status: { branch: "master", detached: false, changes: [] },
    stashes: [
      { index: 0, message: "stash head", timeMs: 1 },
      { index: 1, message: "stash older", timeMs: 2 },
    ],
    shelves: [],
    branches: [], tags: [], operations: [],
    recovery: null, operation: null, pushing: null,
    probe: { available: true, repoRoot: "D:/repo", midMerge: false, midRebase: false, midCherryPick: false, midRevert: false },
    refresh: vi.fn(async () => {}),
    stashPush: vi.fn(async () => {}), stashApply: vi.fn(async () => {}),
    stashDrop: vi.fn(async () => {}), stashBranch: vi.fn(async () => {}),
    unshelve: vi.fn(async () => ({ conflicts: [] })), shelfRename: vi.fn(async () => {}),
    shelfDelete: vi.fn(async () => {}),
    absoluteOf: (path: string) => path,
    loadAmendTargets: vi.fn(async () => null),
  } as unknown as GitState;
  props = {
    git, view, onViewChange: (next: GitView) => { view = next; },
    onUpdate: vi.fn(), onPush: vi.fn(), workspaceRoot: "D:/repo",
    onOpenChange: vi.fn(), onOpenFile: vi.fn(), focusSignal: 0, rewordSignal: 0,
    onCommitted: vi.fn(), history: [], groupByDir: false, groupByModule: false,
    showIgnored: false, onToggleIgnored: vi.fn(), onToggleByDir: vi.fn(), onToggleByModule: vi.fn(),
    showOnDoubleClick: "preview", commitAllWhenNothingStaged: true, onOpenSource: vi.fn(),
    onOpenResolve: vi.fn(), repoName: "repo", onFileAction: vi.fn(), onUnignore: vi.fn(),
    onOpenCommitFile: vi.fn(),
  } as unknown as PanelProps;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** 页签画在 App 的头部那一层，面板只跟着 props.view 换内容，所以测试先把 view 灌回 props。 */
async function render() {
  props.view = view;
  await act(async () => root.render(createElement(GitPanel, props)));
}

/** 面板是 memo 的：改 git 里的数据要换个新引用，否则重渲染直接被跳过。 */
async function patchGit(next: Partial<GitState>) {
  git = { ...git, ...next };
  props.git = git;
  await render();
}

/** 某段界面是否还在显示：切走的页签靠 hidden 隐藏，实例仍留在 DOM 里。 */
function hidden(element: Element | null | undefined) {
  return !element || element.closest("[hidden]") !== null;
}

function stashRow(message: string) {
  return [...document.querySelectorAll("span")].find((s) => s.textContent === message);
}

const messageBox = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="git.messagePlaceholder"]');

describe("提交面板跟着头部页签换内容", () => {
  it("停在提交页：变更树与说明框可见，贮藏列表藏起来", async () => {
    await render();
    expect(hidden(messageBox())).toBe(false);
    expect(hidden(stashRow("stash head"))).toBe(true);
  });

  it("切到贮藏页：只显示贮藏列表，树专属动作与工具栏跟着收起", async () => {
    view = "stash";
    await render();
    expect(hidden(stashRow("stash head"))).toBe(false);
    expect(hidden(stashRow("stash older"))).toBe(false);
    expect(hidden(messageBox())).toBe(true);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("行尾只留删除，其余动作走右键菜单", async () => {
    view = "stash";
    await render();
    const actions = [...stashRow("stash head")!.parentElement!.querySelectorAll("button")];
    expect(actions.map((button) => button.textContent?.trim())).toEqual([""]);
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual(["git.stashDrop"]);
  });

  it("右键菜单给出全部动作", async () => {
    view = "stash";
    await render();
    const row = stashRow("stash head")!.parentElement!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    for (const key of ["git.stashApply", "git.stashPop", "git.stashBranch", "git.stashDrop"]) {
      expect(document.body.textContent).toContain(key);
    }
  });

  it("丢弃贮藏先弹二次确认，确认后才真的丢", async () => {
    view = "stash";
    await render();
    const trash = stashRow("stash head")!.parentElement!.querySelector<HTMLButtonElement>(
      '[aria-label="git.stashDrop"]'
    )!;

    // 第一次：点开确认框后取消，什么都不该发生。
    await act(async () => trash.click());
    expect(document.body.textContent).toContain("git.stashDropConfirm");
    expect(git.stashDrop).not.toHaveBeenCalled();
    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "dialog.cancel")!;
    await act(async () => cancel.click());
    expect(document.body.textContent).not.toContain("git.stashDropConfirm");
    expect(git.stashDrop).not.toHaveBeenCalled();

    // 第二次：确认，才落到 stashDrop。
    await act(async () => trash.click());
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "dialog.delete")!;
    await act(async () => confirm.click());
    expect(git.stashDrop).toHaveBeenCalledWith(0);
    expect(document.body.textContent).not.toContain("git.stashDropConfirm");
  });

  it("没有贮藏给空态；有搁置列表时不抢这句", async () => {
    view = "stash";
    await patchGit({ stashes: [] });
    expect(document.body.textContent).toContain("git.stashEmpty");

    await patchGit({ shelves: [{ id: "s1", name: "shelved work", files: [], timeMs: 3, branch: "master" }] });
    expect(document.body.textContent).not.toContain("git.stashEmpty");
    expect(document.body.textContent).toContain("git.shelfTitle");
    expect(hidden(stashRow("shelved work"))).toBe(false);
  });

  it("来回切页签不卸掉提交区，草稿留着", async () => {
    await render();
    const box = messageBox()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "草稿");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    view = "stash";
    await render();
    view = "commit";
    await render();
    expect(messageBox()?.value).toBe("草稿");
  });

  it("说明框要抢焦点时先回提交页", async () => {
    view = "stash";
    props.focusSignal = 1;
    await render();
    expect(view).toBe("commit");
  });
});

describe("工具窗口头部的提交/贮藏页签", () => {
  let tabsHost: HTMLDivElement;
  let tabsRoot: Root;

  beforeEach(() => {
    tabsHost = document.createElement("div");
    document.body.append(tabsHost);
    tabsRoot = createRoot(tabsHost);
  });

  afterEach(async () => {
    await act(async () => tabsRoot.unmount());
    tabsHost.remove();
  });

  async function renderTabs(stashCount: number, showCount: boolean, onSelect: (view: GitView) => void) {
    await act(async () => {
      tabsRoot.render(createElement(GitViewTabs, { view: "commit", onChange: onSelect, stashCount, showCount }));
    });
    return [...tabsHost.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
  }

  it("并列两个页签，选中的那颗带条数", async () => {
    const items = await renderTabs(2, true, () => {});
    expect(items.map((item) => item.textContent)).toEqual(["git.tabCommit", "git.tabStash2"]);
    expect(items.map((item) => item.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  it("点贮藏把视图交回 App；0 条不画计数", async () => {
    const picked: GitView[] = [];
    const items = await renderTabs(0, true, (next) => picked.push(next));
    expect(items[1]!.textContent).toBe("git.tabStash");
    await act(async () => items[1]!.click());
    expect(picked).toEqual(["stash"]);
  });

  it("侧栏太窄时收起计数", async () => {
    const items = await renderTabs(2, false, () => {});
    expect(items[1]!.textContent).toBe("git.tabStash");
  });
});
