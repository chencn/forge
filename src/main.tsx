import React from "react";
import ReactDOM from "react-dom/client";
import { ensureFileIcons } from "./lib/fileIcons";
import { loadHistory } from "./lib/history";
import { loadLspConfig } from "./lib/lspConfig";
import { loadSettings } from "./lib/settings";
import "@fontsource-variable/jetbrains-mono";
import "./themes/tokens.css";
import "./styles.css";

/**
 * 界面整体延后到三份配置读回来之后再 import：读回之前渲染首帧，会先闪一下空态，
 * 语言服务还会多起一次进程。
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
  // 这两条各自只走 `lib/term` 与 `lib/lsp`（只有 Tauri 壳的那一层），别换成 `lspClient`——
  // 那条会连带把编辑器与 i18n 整串模块都拉进启动路径上。
  const { termReap } = await import("./lib/term");
  await termReap().catch(() => {});
  const { lspReap } = await import("./lib/lsp");
  await lspReap().catch(() => {});
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
