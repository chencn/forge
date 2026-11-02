import React from "react";
import ReactDOM from "react-dom/client";
import { ensureFileIcons } from "./lib/fileIcons";
import { loadHistory } from "./lib/history";
import { loadSettings } from "./lib/settings";
import { ensureLang, resolveLang } from "./i18n";
import { TooltipHost } from "./ui/Tooltip";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./themes/tokens.css";
import "./styles.css";

/**
 * 界面整体延后到两份配置读回来之后再 import：读回之前渲染首帧，会先闪一下空态。
 */
async function bootstrap() {
  // 两份配置一起读：历史记录决定首帧打开哪个工程，晚一步会先闪一下空态。
  const [settings, history] = await Promise.all([loadSettings(), loadHistory()]);
  // 词典按语言拆成了独立 chunk（见 i18n/index.tsx）：首帧前只把当前语言那一份装上，
  // 另外两种语言不必为一次打开付解析成本。
  await ensureLang(resolveLang(settings.language || null));
  // 上一回页面留下的 shell 先收干净：一挂载就会起新进程，晚了就来不及了。
  // 清理与 App chunk 的加载互不依赖：模块加载与清理全部一起发，最后只等清理落地。
  const [term, appModule, settingsModule, historyModule] = await Promise.all([
    import("./lib/term"),
    import("./App"),
    import("./hooks/useSettings"),
    import("./hooks/useHistory"),
  ]);
  await term.termReap().catch(() => {});
  const { default: App } = appModule;
  const { SettingsProvider } = settingsModule;
  const { HistoryProvider } = historyModule;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SettingsProvider initial={settings}>
        <HistoryProvider initial={history}>
          <App />
          {/* 工具栏按钮通过 data-tooltip 提供文案，由全局单例统一显示。 */}
          <TooltipHost />
        </HistoryProvider>
      </SettingsProvider>
    </React.StrictMode>
  );
  // 界面已挂载后再后台取文件图标数据（约 2.6MB 独立 chunk），不阻塞首屏；
  // 到位后订阅者自动重渲染，先渲染出来的单色占位被换成彩色图标。
  void ensureFileIcons();
}

void bootstrap();
