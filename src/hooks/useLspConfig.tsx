import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { lspProbe } from "../lib/lsp";
import type { LspServerProbe } from "../lib/lsp";
import { saveLspConfig, serverEntries } from "../lib/lspConfig";
import type { LspConfig, LspServerConfig } from "../lib/lspConfig";
import { useLspSessions } from "./useLspSessions";
import type { LspSessions } from "./useLspSessions";

interface LspConfigValue {
  /** 当前生效的语言服务配置。 */
  config: LspConfig;
  /** 改一个 server 的那一项，整份写回文件。 */
  patchServer: (id: string, next: Partial<LspServerConfig>) => void;
  /** 每个 server 的安装状态；一次都没有探测时是 null，界面不绘制徽章。 */
  probes: Record<string, LspServerProbe> | null;
  /** 执行一轮探测。后端会把「启用外部档但本机未安装」的档位回退为 off，返回的即是校正后的配置。 */
  reprobe: () => Promise<void>;
  /** 正在探测，按钮该置灰。 */
  probing: boolean;
}

/**
 * 会话状态单独一档：那份每 3 秒换一次新对象。
 * 跟配置放一起会让 App 每 3 秒整树重渲染，而真正看它的只有底部状态条和设置页。
 */
const LspSessionsContext = createContext<LspSessions | null>(null);

/** 在跑的会话状态。挂在这里而不是各界面自己轮，两处看的是同一份。 */
export function useLspSessionStatuses(): LspSessions {
  const value = useContext(LspSessionsContext);
  if (!value) throw new Error("useLspSessionStatuses 必须在 LspConfigProvider 内使用");
  return value;
}

const LspConfigContext = createContext<LspConfigValue | null>(null);

/** 读语言服务配置；提供者拿不到就报错。 */
export function useLspConfig(): LspConfigValue {
  const value = useContext(LspConfigContext);
  if (!value) throw new Error("useLspConfig 必须在 LspConfigProvider 内使用");
  return value;
}

interface LspConfigProviderProps {
  /** 入口在渲染前读好的那份配置，首帧的 reconcile 就要用它。 */
  initial: LspConfig;
  children: ReactNode;
}

export function LspConfigProvider({
  initial,
  children,
}: LspConfigProviderProps): React.JSX.Element {
  const [config, setConfig] = useState<LspConfig>(initial);
  const [probes, setProbes] = useState<Record<string, LspServerProbe> | null>(null);
  const [probing, setProbing] = useState(false);
  /** 探测回来的配置已经是后端写好的那份，这一份不再往回写。 */
  const skipSave = useRef(false);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    void saveLspConfig(config);
  }, [config]);

  const patchServer = useCallback((id: string, next: Partial<LspServerConfig>) => {
    setConfig((current) => {
      const entry = current.servers[id];
      if (!entry) return current;
      return { ...current, servers: { ...current.servers, [id]: { ...entry, ...next } } };
    });
  }, []);

  const reprobe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try {
      const report = await lspProbe();
      const byId: Record<string, LspServerProbe> = {};
      for (const item of report.servers) byId[item.id] = item;
      setProbes(byId);
      skipSave.current = true;
      setConfig(report.config);
    } catch {
      // 纯浏览器预览时没这条命令，徽标就留空。
      setProbes(null);
    } finally {
      setProbing(false);
    }
  }, []);

  // 只有真有人用外部档时才轮会话状态：没人用就没东西可采。
  const sessions = useLspSessions(
    serverEntries(config).some((entry) => entry.mode === "lsp")
  );

  const value = useMemo(
    () => ({ config, patchServer, probes, reprobe, probing }),
    [config, patchServer, probes, reprobe, probing]
  );

  return (
    <LspConfigContext.Provider value={value}>
      <LspSessionsContext.Provider value={sessions}>{children}</LspSessionsContext.Provider>
    </LspConfigContext.Provider>
  );
}
