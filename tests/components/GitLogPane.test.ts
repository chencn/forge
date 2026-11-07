// @vitest-environment jsdom
import { act, createElement, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitState } from '../../src/hooks/useGitState';

const h = vi.hoisted(() => ({
  scheme: 'idea' as 'idea' | 'vscode' | 'eclipse',
  commit: { hash: 'abc123', short: 'abc', author: 'Tester', authoredMs: 1, subject: 'change', refs: 'HEAD -> main', parents: ['parent'] },
  file: { path: 'src/main.ts', oldPath: '', status: 'M', added: 1, removed: 1 },
}));
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'zh-CN' }) }));
vi.mock('../../src/hooks/useSettings', () => ({ useSettings: () => ({ settings: { editor: { keymap: h.scheme }, vcs: { limitHistoryRows: 1000 } } }) }));
vi.mock('../../src/components/EntryIcon', () => ({ default: () => null }));
vi.mock('../../src/lib/git', async (original) => ({
  ...await original<typeof import('../../src/lib/git')>(),
  gitAuthors: async () => ['Tester'],
  gitLog: vi.fn(async () => [h.commit]),
  gitCommitDetail: async () => ({ ...h.commit, email: '', body: '', committer: 'Tester', committerEmail: '', committedMs: 1, files: [h.file] }),
}));

import GitLogPane from '../../src/components/GitLogPane';
import GitHistoryTabs from '../../src/components/GitHistoryTabs';
import { gitLog } from '../../src/lib/git';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';

let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof GitLogPane>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(gitLog).mockClear();
  h.scheme = 'idea';
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  props = {
    // 组件只读取这些字段；测试桩不启动 useGitState 的后端命令与轮询。
    git: { root: 'D:/repo', branches: [], tags: [], lastCommit: h.commit,
      status: { branch: 'main', detached: false }, probe: { remotes: ['origin'] },
      absoluteOf: (path: string) => `D:/repo/${path}` } as unknown as GitState,
    reportError: vi.fn(), onFileAction: vi.fn(), onCompareWork: vi.fn(), onEditSource: vi.fn(),
    onRefAction: vi.fn(), onCommitAction: vi.fn(), onCompareCommits: vi.fn(),
    options: DEFAULT_SETTINGS.branches, onOptions: vi.fn(), repoName: 'repo',
    reference: '', setReference: vi.fn(), compareRef: null, setCompareRef: vi.fn(),
    pathFilter: '', setPathFilter: vi.fn(),
  };
});

describe('文件历史与主日志的隔离', () => {
  it('文件名 log 不与主日志冲突，切换保留主筛选，关闭历史返回主日志', async () => {
    const selectHistory = vi.fn();
    const closeHistory = vi.fn();
    function Workbench() {
      const [paths, setPaths] = useState(['log', 'src/main.ts']);
      const [active, setActive] = useState('log');
      return createElement(GitHistoryTabs, { ...props, reference: 'main', historyPaths: paths, activeHistory: active,
        onSelectHistory: (path) => { selectHistory(path); setActive(path); },
        onCloseHistory: (path) => { closeHistory(path); setPaths((values) => values.filter((value) => value !== path)); setActive(''); },
      });
    }
    await act(async () => root.render(createElement(Workbench)));
    expect(gitLog).toHaveBeenCalledWith('D:/repo', expect.objectContaining({ path: 'log', reference: '', author: '', text: '' }));
    expect(gitLog).toHaveBeenCalledWith('D:/repo', expect.objectContaining({ path: '', reference: 'main' }));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const main = tabs[0];
    await act(async () => { main.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(selectHistory).toHaveBeenLastCalledWith('');
    const history = tabs[1];
    await act(async () => { history.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(selectHistory).toHaveBeenLastCalledWith('log');
    await press(history, 'Delete');
    expect(closeHistory).toHaveBeenCalledWith('log');
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="tab"]')!.click(); });
    expect(selectHistory).toHaveBeenLastCalledWith('');
    expect(gitLog).toHaveBeenCalledWith('D:/repo', expect.objectContaining({ path: '', reference: 'main' }));
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render() {
  await act(async () => root.render(createElement(GitLogPane, props)));
}
async function press(target: Element, key: string, modifiers: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })); });
}

describe('日志快捷键的焦点与方案边界', () => {
  it('从日志选中提交创建分支先于全局动作处理，并限定在提交列', async () => {
    await render();
    const applicationHandler = vi.fn();
    window.addEventListener('keydown', applicationHandler);
    try {
      await press(host.querySelector('.log-list')!, 'n', { ctrlKey: true, altKey: true });
      expect(props.onCommitAction).toHaveBeenCalledWith('newBranch', h.commit);
      expect(applicationHandler).not.toHaveBeenCalled();
      await press(host.querySelector('.log-detail')!, 'n', { ctrlKey: true, altKey: true });
      expect(props.onCommitAction).toHaveBeenCalledOnce();
      expect(applicationHandler).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('keydown', applicationHandler); }
  });

  it('已有选区也不能从面板外或输入框触发旧日志动作，修饰键必须精确匹配', async () => {
    await render();
    const detail = host.querySelector('.log-detail')!;
    await press(document.body, 'd', { ctrlKey: true });
    await press(host.querySelector('input')!, 'd', { ctrlKey: true });
    await press(detail, 'd', { ctrlKey: true, shiftKey: true });
    expect(props.onFileAction).not.toHaveBeenCalled();
    await press(detail, 'd', { ctrlKey: true });
    expect(props.onFileAction).toHaveBeenCalledWith('diff', expect.objectContaining({ hash: h.commit.hash }), h.file);
    await press(detail, 'F4', { shiftKey: true });
    expect(props.onEditSource).not.toHaveBeenCalled();
    await press(detail, 'F4');
    expect(props.onEditSource).toHaveBeenCalledWith(h.file.path);
  });

  it('切换 Eclipse 后打开源文件用 F12，旧 IDEA 的 F4 立即失效', async () => {
    await render();
    h.scheme = 'eclipse';
    // memo 组件需要一次 props 更新；生产中的 Context 更新同样会重新渲染。
    props = { ...props, repoName: 'changed' };
    await render();
    const detail = host.querySelector('.log-detail')!;
    await press(detail, 'F4');
    expect(props.onEditSource).not.toHaveBeenCalled();
    await press(detail, 'F12');
    expect(props.onEditSource).toHaveBeenCalledWith(h.file.path);
  });
});
