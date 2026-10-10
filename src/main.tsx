import React from "react";
import ReactDOM from "react-dom/client";
import { resolveLang } from "./i18n";
import { ensureFileIcons } from "./lib/fileIcons";
import { loadHistory } from "./lib/history";
import { loadLspConfig } from "./lib/lspConfig";
import { loadSettings } from "./lib/settings";
import "./themes/tokens.css";
import "./styles.css";

/**
 * monaco 在模块求值时就固化自己的文案，语言表必须先进去，
 * 所以界面整体延后到设置读回来之后再 import。
 */
async function bootstrap() {
  // 三份配置一起读：语言服务那份首帧的 reconcile 就要用，晚一步会多起一次进程；
  // 历史记录决定首帧打开哪个工程，晚一步会先闪一下空态。
  const [settings, history, lspConfig] = await Promise.all([
    loadSettings(),
    loadHistory(),
    loadLspConfig(),
  ]);
  // 上一回页面留下的 shell 与语言服务先收干净：两者一挂载就会起新进程，晚了就来不及了。
  // 语言服务这条走 `lib/lsp`（只有 Tauri 壳），不要引 `lib/lspClient`——它拉得到 monaco，
  // 会在启动路径上多打出一个几百模块的 chunk。
  const { termReap } = await import("./lib/term");
  await termReap().catch(() => {});
  const { lspReap } = await import("./lib/lsp");
  await lspReap().catch(() => {});
  if (resolveLang(settings.language || null) === "zh") {
    await import("monaco-editor/nls/lang/zh-cn.js");
  }
  const [{ default: App }, { SettingsProvider }, { HistoryProvider }, { LspConfigProvider }] =
    await Promise.all([
      import("./App"),
      import("./hooks/useSettings"),
      import("./hooks/useHistory"),
      import("./hooks/useLspConfig"),
    ]);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SettingsProvider initial={settings}>
        <HistoryProvider initial={history}>
          <LspConfigProvider initial={lspConfig}>
            <App />
          </LspConfigProvider>
        </HistoryProvider>
      </SettingsProvider>
    </React.StrictMode>
  );
  // 界面已挂载后再后台取文件图标数据（约 2.6MB 独立 chunk），不阻塞首屏；
  // 到位后订阅者自动重渲染，先渲染出来的单色占位被换成彩色图标。
  void ensureFileIcons();
}

void bootstrap();
