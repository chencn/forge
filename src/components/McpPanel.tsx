import { useEffect, useMemo, useState } from "react";
import { Copy, Download, Loader2, Plus, RefreshCw, Save, Search, Server, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { AI_NAMES } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import {
  MCP_TEMPLATE,
  cliAdminAvailable,
  defaultMarketParams,
  deleteMcp,
  hasRemoteMcpEnv,
  listMcp,
  mcpMarketDetail,
  mcpMarketProviders,
  mcpMarketResolve,
  mcpMarketSearch,
  mcpSummary,
  parseMcpSpec,
  saveMcp,
} from "../lib/aiManage";
import type {
  McpList,
  McpMarketDetail,
  McpMarketOption,
  McpMarketParameter,
  McpMarketProvider,
  McpMarketServer,
  McpServer,
} from "../lib/aiManage";
import { openExternal } from "../lib/fs";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";

const other = (provider: AiProvider): AiProvider => provider === "claude" ? "codex" : "claude";

/** 市场协议徽标；stdio 用小写，其余按 CLI 的通行写法显示。 */
function protocolLabel(protocol: string): string {
  const normalized = protocol.trim().toLowerCase();
  if (normalized === "http" || normalized === "streamable-http" || normalized === "streamablehttp") return "HTTP";
  if (normalized === "sse") return "SSE";
  if (normalized === "stdio") return "stdio";
  return protocol;
}

function parameterText(field: McpMarketParameter): string {
  if (!field.description) return "";
  return field.location ? `${field.location} · ${field.description}` : field.description;
}

/**
 * 本地 MCP 管理 + 市场：官方 MCP registry 与 Smithery。
 * Claude 写 `~/.claude.json` 的 `mcpServers`，Codex 写 `config.toml` 的 `[mcp_servers.<id>]`。
 * 市场装的是按目标 CLI 与所选安装方式生成的配置，参数必填项由后端再校验一次。
 */
export default function McpPanel() {
  const { t } = useI18n();
  const desktop = cliAdminAvailable();
  const [provider, setProvider] = useState<AiProvider>("claude");
  const [list, setList] = useState<McpList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [id, setId] = useState("");
  const [specText, setSpecText] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServer | null>(null);
  const [pendingCopy, setPendingCopy] = useState<{ id: string; spec: Record<string, unknown> } | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [baseline, setBaseline] = useState("");
  const [tab, setTab] = useState<"local" | "market">("local");

  const [marketProviders, setMarketProviders] = useState<McpMarketProvider[]>([]);
  const [market, setMarket] = useState("official_registry");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketResults, setMarketResults] = useState<McpMarketServer[] | null>(null);
  const [marketSelected, setMarketSelected] = useState<string | null>(null);
  const [marketDetail, setMarketDetail] = useState<McpMarketDetail | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketDetailLoading, setMarketDetailLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketDetailError, setMarketDetailError] = useState<string | null>(null);
  const [optionId, setOptionId] = useState("");
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [marketSpecText, setMarketSpecText] = useState("");
  const [marketBaseline, setMarketBaseline] = useState("");
  const [pendingInstall, setPendingInstall] = useState<{ serverId: string; name: string; spec: Record<string, unknown> } | null>(null);

  const editing = isNew || selectedId !== null;
  const localDirty = editing && specText !== baseline;
  const marketDirty = tab === "market" && marketSpecText !== marketBaseline;
  const dirty = localDirty || marketDirty;
  const guard = (action: () => void) => {
    if (dirty) setPendingLeave(() => action);
    else action();
  };
  useUnsavedGuard(() => dirty);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void mcpMarketProviders().then((value) => {
      if (!active || !value.length) return;
      setMarketProviders(value);
      setMarket((current) => value.some((item) => item.id === current) ? current : value[0].id);
    }).catch(() => { /* 来源列表拿不到时保留官方 registry 的默认值 */ });
    return () => { active = false; };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setBusy(true); setNotice(null); setList(null); setSelectedId(null); setIsNew(false); setId(""); setSpecText(""); setBaseline("");
    listMcp(provider)
      .then((value) => {
        if (!active) return;
        setList(value);
        if (value.servers[0]) {
          const text = JSON.stringify(value.servers[0].spec, null, 2);
          setSelectedId(value.servers[0].id);
          setId(value.servers[0].id);
          setSpecText(text);
          setBaseline(text);
        }
      })
      .catch((error) => { if (active) setNotice({ error: true, text: t("mcp.loadFailed", { message: String(error) }) }); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [provider, desktop, reloadToken]);

  const select = (server: McpServer) => {
    const text = JSON.stringify(server.spec, null, 2);
    setSelectedId(server.id); setIsNew(false); setId(server.id);
    setSpecText(text); setBaseline(text); setNotice(null);
  };

  const startNew = () => {
    const text = JSON.stringify(MCP_TEMPLATE, null, 2);
    setSelectedId(null); setIsNew(true); setId("");
    setSpecText(text); setBaseline(text); setNotice(null);
  };

  /** 远程 MCP 只读 headers；编辑器里留着 env 会让人以为它生效，保存前明确提示。 */
  const remoteEnvWarning = useMemo(() => {
    const parsed = parseMcpSpec(specText);
    return "error" in parsed ? false : hasRemoteMcpEnv(parsed.spec);
  }, [specText]);

  const readSpec = (): Record<string, unknown> | null => {
    const parsed = parseMcpSpec(specText);
    if ("error" in parsed) {
      setNotice({ error: true, text: parsed.error === "empty" ? t("mcp.emptySpec")
        : parsed.error === "object" ? t("mcp.invalidObject") : t("mcp.invalidJson", { message: parsed.error }) });
      return null;
    }
    return parsed.spec;
  };

  const save = async () => {
    const clean = id.trim();
    if (!clean || busy) return;
    if (clean !== id || clean.length > 128) {
      setNotice({ error: true, text: t("mcp.idInvalid") });
      return;
    }
    if (isNew && list?.servers.some((server) => server.id === clean)) {
      setNotice({ error: true, text: t("mcp.idExists", { id: clean }) });
      return;
    }
    const spec = readSpec();
    if (!spec) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await saveMcp(provider, clean, spec);
      setList(saved); setIsNew(false); setSelectedId(clean); setId(clean);
      // 用后端规范化后的结果回填，界面看到的就是磁盘上的真实配置。
      const text = JSON.stringify(saved.servers.find((server) => server.id === clean)?.spec ?? spec, null, 2);
      setSpecText(text); setBaseline(text);
      setNotice({ error: false, text: t("mcp.saved") });
    } catch (error) {
      setNotice({ error: true, text: t("mcp.saveFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const performCopy = async (id: string, spec: Record<string, unknown>) => {
    setBusy(true); setNotice(null);
    try {
      await saveMcp(other(provider), id, spec);
      setNotice({ error: false, text: t("mcp.copied", { name: AI_NAMES[other(provider)] }) });
    } catch (error) {
      setNotice({ error: true, text: t("mcp.copyFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const copyToOther = async () => {
    if (!selectedId || isNew || busy) return;
    const spec = readSpec();
    if (!spec) return;
    setBusy(true); setNotice(null);
    try {
      // 另一个 CLI 里已有同名服务器时先确认，避免静默覆盖它的配置。
      const target = await listMcp(other(provider));
      if (target.servers.some((server) => server.id === selectedId)) {
        setPendingCopy({ id: selectedId, spec });
      } else {
        await saveMcp(other(provider), selectedId, spec);
        setNotice({ error: false, text: t("mcp.copied", { name: AI_NAMES[other(provider)] }) });
      }
    } catch (error) {
      setNotice({ error: true, text: t("mcp.copyFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const remove = async (server: McpServer) => {
    setPendingDelete(null);
    setBusy(true); setNotice(null);
    try {
      const saved = await deleteMcp(provider, server.id);
      setList(saved); setSelectedId(null); setIsNew(false); setId(""); setSpecText(""); setBaseline("");
      if (saved.servers[0]) select(saved.servers[0]);
    } catch (error) {
      setNotice({ error: true, text: t("mcp.deleteFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const applyOption = (option: McpMarketOption | null) => {
    setOptionId(option?.id ?? "");
    setParamDraft(defaultMarketParams(option));
    const text = JSON.stringify(option?.spec ?? {}, null, 2);
    setMarketSpecText(text);
    setMarketBaseline(text);
  };

  const runMarketSearch = async (raw: string, source: string = market) => {
    if (!desktop || marketLoading) return;
    const query = raw.trim();
    setMarketLoading(true); setMarketError(null);
    try {
      const items = await mcpMarketSearch(source, query);
      setMarketResults(items);
      setMarketSelected((current) => current && items.some((item) => item.serverId === current)
        ? current
        : items[0]?.serverId ?? null);
    } catch (error) {
      setMarketResults(null);
      setMarketSelected(null);
      setMarketError(String(error));
    } finally {
      setMarketLoading(false);
    }
  };

  // 进入市场页或切换来源就搜一次；关键词只在按搜索/回车时生效，避免每敲一个字打一次网络。
  useEffect(() => {
    if (tab !== "market" || !desktop) return;
    let active = true;
    setMarketLoading(true); setMarketError(null);
    void mcpMarketSearch(market, marketQuery.trim())
      .then((items) => {
        if (!active) return;
        setMarketResults(items);
        setMarketSelected((current) => current && items.some((item) => item.serverId === current)
          ? current
          : items[0]?.serverId ?? null);
      })
      .catch((error) => {
        if (!active) return;
        setMarketResults(null);
        setMarketSelected(null);
        setMarketError(String(error));
      })
      .finally(() => { if (active) setMarketLoading(false); });
    return () => { active = false; };
    // marketQuery 是有意不放进依赖：输入时不自动发请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, market, desktop]);

  useEffect(() => {
    if (tab !== "market" || !marketSelected) {
      setMarketDetail(null);
      setMarketDetailError(null);
      setMarketDetailLoading(false);
      setOptionId("");
      setParamDraft({});
      setMarketSpecText("");
      setMarketBaseline("");
      return;
    }
    let active = true;
    setMarketDetailLoading(true);
    setMarketDetailError(null);
    void mcpMarketDetail(provider, market, marketSelected)
      .then((detail) => {
        if (!active) return;
        setMarketDetail(detail);
        const option = detail.installOptions.find((item) => item.id === detail.defaultOptionId)
          ?? detail.installOptions[0] ?? null;
        setOptionId(option?.id ?? "");
        setParamDraft(defaultMarketParams(option));
        const text = JSON.stringify(option?.spec ?? detail.spec ?? {}, null, 2);
        setMarketSpecText(text);
        setMarketBaseline(text);
      })
      .catch((error) => {
        if (!active) return;
        setMarketDetail(null);
        setMarketDetailError(String(error));
        setOptionId(""); setParamDraft({}); setMarketSpecText(""); setMarketBaseline("");
      })
      .finally(() => { if (active) setMarketDetailLoading(false); });
    return () => { active = false; };
  }, [tab, market, marketSelected, provider]);

  /** 生成真正要落盘的配置：用户改过 JSON 就以编辑器为准，否则带上参数让后端解析。 */
  const prepareInstall = async () => {
    if (!marketDetail || busy) return;
    let spec: Record<string, unknown> | null = null;
    if (marketSpecText.trim() !== marketBaseline.trim()) {
      const parsed = parseMcpSpec(marketSpecText);
      if ("error" in parsed) {
        setNotice({ error: true, text: parsed.error === "empty" ? t("mcp.emptySpec")
          : parsed.error === "object" ? t("mcp.invalidObject") : t("mcp.invalidJson", { message: parsed.error }) });
        return;
      }
      spec = parsed.spec;
    } else {
      try {
        spec = await mcpMarketResolve(provider, market, marketDetail.serverId, optionId, paramDraft);
      } catch (error) {
        setNotice({ error: true, text: t("mcp.marketResolveFailed", { message: String(error) }) });
        return;
      }
    }
    setNotice(null);
    setPendingInstall({ serverId: marketDetail.serverId, name: marketDetail.name, spec });
  };

  const installMarket = async (pending: { serverId: string; name: string; spec: Record<string, unknown> }) => {
    setPendingInstall(null);
    if (busy) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await saveMcp(provider, pending.serverId, pending.spec);
      setList(saved);
      const created = saved.servers.find((server) => server.id === pending.serverId) ?? saved.servers[0] ?? null;
      if (created) select(created);
      setTab("local");
      setNotice({ error: false, text: t("mcp.marketInstalled", { name: pending.name }) });
    } catch (error) {
      setNotice({ error: true, text: t("mcp.saveFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const query = search.trim().toLowerCase();
  const servers = (list?.servers ?? []).filter((server) => !query
    || server.id.toLowerCase().includes(query)
    || mcpSummary(server.spec).toLowerCase().includes(query));

  const selectedOption = marketDetail?.installOptions.find((item) => item.id === optionId)
    ?? marketDetail?.installOptions[0] ?? null;
  const marketSpecDirty = marketSpecText !== marketBaseline;
  const marketExists = !!marketDetail && !!list?.servers.some((server) => server.id === marketDetail.serverId);

  return (
    <div className="ai-manage-panel">
      <div className="ai-manage-toolbar">
        <Select value={provider} label={t("mcp.provider")} placeholder={t("mcp.provider")}
          options={(["claude", "codex"] as AiProvider[]).map((item) => ({ value: item, label: AI_NAMES[item] }))}
          onChange={(next) => guard(() => setProvider(next))} />
        <div className="ai-manage-tabs" role="group" aria-label={t("mcp.title")}>
          <button type="button" className="lsp-action" aria-pressed={tab === "local"}
            onClick={() => tab === "local" || guard(() => setTab("local"))}>{t("mcp.tabLocal")}</button>
          <button type="button" className="lsp-action" aria-pressed={tab === "market"}
            onClick={() => {
              if (tab === "market") return;
              guard(() => setTab("market"));
            }}>{t("mcp.tabMarket")}</button>
        </div>
        {tab === "local" ? (
          <input className="text-input" value={search} placeholder={t("mcp.search")}
            aria-label={t("mcp.search")} onChange={(event) => setSearch(event.target.value)} />
        ) : (
          <span className="ai-manage-market">
            <input className="text-input" value={marketQuery} placeholder={t("mcp.marketSearch")} aria-label={t("mcp.marketSearch")}
              spellCheck={false} maxLength={120}
              onChange={(event) => setMarketQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") guard(() => void runMarketSearch(marketQuery)); }} />
            <button type="button" className="lsp-action" disabled={!desktop || marketLoading}
              onClick={() => guard(() => void runMarketSearch(marketQuery))}>
              {marketLoading ? <Loader2 size={13} className="is-spinning" /> : <Search size={13} />}
              {t("mcp.marketGo")}
            </button>
          </span>
        )}
        <span className="ai-cli-hint ai-manage-path">{tab === "local" ? (list?.path ?? "") : t("mcp.marketSourceHint")}</span>
        <button type="button" className="lsp-action" disabled={!desktop || busy}
          title={t("mcp.refresh")} aria-label={t("mcp.refresh")}
          onClick={() => guard(() => tab === "local" ? setReloadToken((value) => value + 1) : void runMarketSearch(marketQuery))}>
          <RefreshCw size={13} />
        </button>
        {tab === "local" ? (
          <button type="button" className="lsp-action" disabled={!desktop || busy} onClick={() => guard(startNew)}>
            <Plus size={13} />{t("mcp.add")}
          </button>
        ) : null}
      </div>

      <div className="ai-manage-page">
        <aside className="ai-cli-list" aria-label={t(tab === "market" ? "mcp.tabMarket" : "mcp.title")}>
          <div className="ai-cli-list-head">
            <span>{t(tab === "market" ? "mcp.tabMarket" : "mcp.title")}</span>
            <span className="ai-cli-list-hint">{t(tab === "market" ? "mcp.marketHint" : "mcp.hint")}</span>
          </div>
          {tab === "market" && marketProviders.length ? (
            <div className="ai-market-source">
              <Select value={market} label={t("mcp.marketProvider")} placeholder={t("mcp.marketProvider")}
                options={marketProviders.map((item) => ({ value: item.id, label: item.name }))}
                onChange={(next) => guard(() => setMarket(next))} />
            </div>
          ) : null}
          <div className="ai-cli-list-body">
            {tab === "market" ? (marketResults ?? []).map((item) => (
              <button type="button" key={`${item.providerId}:${item.serverId}`}
                className={`ai-cli-row ai-market-row${marketSelected === item.serverId ? " is-active" : ""}`}
                onClick={() => guard(() => setMarketSelected(item.serverId))}>
                <span className="ai-market-icon" aria-hidden="true">
                  {item.iconUrl ? <img src={item.iconUrl} alt="" loading="lazy" /> : "MCP"}
                </span>
                <span className="ai-market-main">
                  <span className="ai-cli-row-name" title={item.description || t("mcp.marketNoDescription")}>{item.name}</span>
                  <span className="ai-market-server-id">{item.serverId}</span>
                  <span className="ai-market-badges">
                    {item.protocols.map((protocol) => <span className="ai-cli-badge is-idle" key={protocol}>{protocolLabel(protocol)}</span>)}
                    {item.latestVersion ? <span className="ai-cli-badge is-idle">v{item.latestVersion}</span> : null}
                    {item.verified ? <span className="ai-cli-badge is-pass">{t("mcp.marketVerified")}</span> : null}
                    {item.downloads !== null && item.downloads !== undefined
                      ? <span className="ai-cli-badge is-idle">{t("mcp.marketUses", { count: item.downloads })}</span> : null}
                  </span>
                </span>
              </button>
            )) : servers.map((server) => (
              <button type="button" key={server.id}
                className={`ai-cli-row${!isNew && selectedId === server.id ? " is-active" : ""}`}
                onClick={() => guard(() => select(server))}>
                <Server size={13} className="ai-cli-grip" aria-hidden="true" />
                <span className="ai-cli-row-name" title={mcpSummary(server.spec)}>{server.id}</span>
                <span className="ai-cli-badge is-idle">{String(server.spec.type ?? "stdio")}</span>
              </button>
            ))}
            {!servers.length && tab === "local" ? <p className="ai-cli-list-note">{desktop ? (busy ? t("ai.cfg.loading") : notice?.error ? notice.text : t("mcp.empty")) : t("ai.desktopOnly")}</p> : null}
            {tab === "market" ? <p className="ai-cli-list-note">{marketLoading ? t("mcp.marketLoading") : marketError ? t("mcp.marketError", { message: marketError }) : marketResults?.length ? "" : t("mcp.marketEmpty")}</p> : null}
          </div>
        </aside>

        <section className="ai-cli-detail" aria-label={t("mcp.detail")}>
          {tab === "market" ? (marketDetailLoading ? (
            <p className="ai-cli-empty">{t("mcp.marketLoadingDetail")}</p>
          ) : marketDetailError ? (
            <p className="ai-cli-empty" role="alert">{t("mcp.marketDetailFailed", { message: marketDetailError })}</p>
          ) : marketDetail ? (
            <>
              <header className="ai-cli-detail-head">
                <div className="ai-cli-detail-title">
                  <span className="ai-market-icon is-large" aria-hidden="true">
                    {marketDetail.iconUrl ? <img src={marketDetail.iconUrl} alt="" /> : "MCP"}
                  </span>
                  <div className="ai-market-title">
                    <h3>{marketDetail.name}</h3>
                    <span className="ai-market-server-id">{marketDetail.serverId}</span>
                  </div>
                </div>
              </header>
              <div className="ai-cli-detail-body">
                <div className="ai-market-badges">
                  {marketDetail.verified ? <span className="ai-cli-badge is-pass">{t("mcp.marketVerified")}</span> : null}
                  {marketDetail.remote ? <span className="ai-cli-badge is-idle">{t("mcp.marketRemote")}</span> : null}
                  {marketDetail.protocols.map((protocol) => <span className="ai-cli-badge is-idle" key={protocol}>{protocolLabel(protocol)}</span>)}
                  {marketDetail.latestVersion ? <span className="ai-cli-badge is-idle">v{marketDetail.latestVersion}</span> : null}
                  {marketDetail.downloads !== null && marketDetail.downloads !== undefined
                    ? <span className="ai-cli-badge is-idle">{t("mcp.marketUses", { count: marketDetail.downloads })}</span> : null}
                  {marketDetail.isDeployed !== null && marketDetail.isDeployed !== undefined
                    ? <span className={`ai-cli-badge ${marketDetail.isDeployed ? "is-pass" : "is-unchecked"}`}>{t(marketDetail.isDeployed ? "mcp.marketDeployed" : "mcp.marketNotDeployed")}</span> : null}
                </div>
                <p className="ai-muted">{marketDetail.description || t("mcp.marketNoDescription")}</p>
                {marketDetail.homepage ? (
                  <button type="button" className="ai-market-link" onClick={() => void openExternal(marketDetail.homepage!).catch(() => {})}>
                    {marketDetail.homepage}
                  </button>
                ) : null}
                {(marketDetail.owner || marketDetail.namespace) ? (
                  <div className="ai-market-meta">
                    {marketDetail.owner ? <span>{t("mcp.marketOwner", { owner: marketDetail.owner })}</span> : null}
                    {marketDetail.namespace ? <span>{t("mcp.marketNamespace", { namespace: marketDetail.namespace })}</span> : null}
                  </div>
                ) : null}
                {marketDetail.installOptions.length ? (
                  <>
                    <label className="ai-cli-field">
                      <span>{t("mcp.marketProtocol")}</span>
                      <Select value={selectedOption?.id ?? ""} label={t("mcp.marketProtocol")} placeholder={t("mcp.marketProtocol")}
                        options={marketDetail.installOptions.map((option) => ({
                          value: option.id,
                          label: `${protocolLabel(option.protocol)} · ${option.label}`,
                        }))}
                        onChange={(next) => {
                          if (marketSpecDirty) { guard(() => applyOption(marketDetail.installOptions.find((option) => option.id === next) ?? null)); return; }
                          applyOption(marketDetail.installOptions.find((option) => option.id === next) ?? null);
                        }} />
                    </label>
                    {selectedOption?.parameters.length ? (
                      <div className="ai-cli-subgroup">
                        <div className="ai-cli-subgroup-head">
                          <strong>{t("mcp.marketParameters")}</strong>
                          <em className="ai-cli-hint">{t("mcp.marketParametersHint")}</em>
                        </div>
                        {selectedOption.parameters.map((field) => (
                          <MarketParameterField key={field.key} field={field} value={paramDraft[field.key] ?? ""}
                            onChange={(value) => setParamDraft((current) => ({ ...current, [field.key]: value }))} />
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="ai-cli-warning" role="alert">{t("mcp.marketNoOptions")}</p>
                )}
                <label className="ai-cli-field">
                  <span>{t("mcp.marketSpec")}</span>
                  <textarea className="ai-cli-env ai-mcp-text" spellCheck={false} value={marketSpecText}
                    onChange={(event) => setMarketSpecText(event.target.value)} />
                  <em className="ai-cli-hint">{t("mcp.marketSpecHint")}</em>
                  {marketSpecDirty ? <em className="ai-cli-warning">{t("mcp.marketSpecDirty")}</em> : null}
                  {marketExists ? <em className="ai-cli-warning" role="alert">{t("mcp.marketAlreadyExists")}</em> : null}
                </label>
              </div>
              <div className="ai-manage-foot">
                {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
                <div className="ai-cli-actions">
                  <button type="button" className="lsp-action" disabled={!desktop || busy || !marketDetail.installOptions.length}
                    onClick={() => void prepareInstall()}>
                    <Download size={13} />{t("mcp.marketInstall")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="ai-cli-empty">{marketLoading ? t("mcp.marketLoading") : marketError ? t("mcp.marketError", { message: marketError }) : t("mcp.marketSelect")}</p>
          )) : editing ? <>
            <header className="ai-cli-detail-head">
              <div className="ai-cli-detail-title">
                <Server size={18} aria-hidden="true" />
                <h3>{isNew ? t("mcp.new") : id}</h3>
                <span className="ai-cli-badge is-idle">{AI_NAMES[provider]}</span>
                {localDirty ? <span className="ai-cli-badge is-checking">{t("mcp.unsaved")}</span> : null}
              </div>
            </header>
            <div className="ai-cli-detail-body">
              <div className="ai-cli-grid">
                <label className="ai-cli-field">
                  <span>{t("mcp.id")}</span>
                  <input className="text-input" spellCheck={false} value={id} disabled={!isNew} maxLength={128}
                    placeholder="filesystem" onChange={(event) => setId(event.target.value)} />
                  <em className="ai-cli-hint">{t("mcp.idHint")}</em>
                </label>
                <div className="ai-cli-field">
                  <span>{t("mcp.path")}</span>
                  <code className="ai-manage-code">{list?.path ?? "—"}</code>
                </div>
              </div>
              <label className="ai-cli-field">
                <span>{t("mcp.spec")}</span>
                <textarea className="ai-cli-env ai-mcp-text" spellCheck={false} value={specText}
                  onChange={(event) => setSpecText(event.target.value)} />
                <em className="ai-cli-hint">{t("mcp.specHint")}</em>
                {remoteEnvWarning ? <em className="ai-cli-warning" role="alert">{t("mcp.envOnRemote")}</em> : null}
              </label>
            </div>
            <div className="ai-manage-foot">
              {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
              <div className="ai-cli-actions">
                {!isNew ? <button type="button" className="lsp-action" disabled={!desktop || busy} onClick={() => void copyToOther()}>
                  <Copy size={13} />{t("mcp.copy", { name: AI_NAMES[other(provider)] })}
                </button> : null}
                {!isNew ? <button type="button" className="lsp-action" disabled={!desktop || busy}
                  onClick={() => { const item = list?.servers.find((server) => server.id === selectedId); if (item) setPendingDelete(item); }}>
                  <Trash2 size={13} />{t("mcp.delete")}
                </button> : null}
                <button type="button" className="lsp-action" disabled={!desktop || busy || !id.trim()} onClick={() => void save()}>
                  {busy ? <Loader2 size={13} className="is-spinning" /> : <Save size={13} />}
                  {busy ? t("ai.saving") : t("mcp.save")}
                </button>
              </div>
            </div>
          </> : <p className="ai-cli-empty">{desktop ? (notice?.error ? notice.text : t("mcp.selectHint")) : t("ai.desktopOnly")}</p>}
        </section>
      </div>

      {pendingDelete ? <AiActionDialog title={t("mcp.delete")} confirm={t("mcp.delete")} danger
        onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete)}>
        <p className="dialog-body">{t("mcp.deleteConfirm", { id: pendingDelete.id })}</p>
      </AiActionDialog> : null}

      {pendingLeave ? <AiActionDialog title={t("mcp.discardTitle")} confirm={t("mcp.discard")} danger
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => { const run = pendingLeave; setPendingLeave(null); run(); }}>
        <p className="dialog-body">{t("mcp.discardHint")}</p>
      </AiActionDialog> : null}

      {pendingInstall ? <AiActionDialog title={t("mcp.marketConfirmTitle")} confirm={t("mcp.marketInstall")}
        onCancel={() => setPendingInstall(null)} onConfirm={() => void installMarket(pendingInstall)}>
        <p className="dialog-body">{t("mcp.marketConfirmHint", { name: AI_NAMES[provider] })}</p>
        <p className="dialog-note"><code>{JSON.stringify(pendingInstall.spec)}</code></p>
      </AiActionDialog> : null}

      {pendingCopy ? <AiActionDialog title={t("mcp.copyOverwriteTitle")} confirm={t("mcp.copyOverwrite")} danger
        onCancel={() => setPendingCopy(null)}
        onConfirm={() => { const copy = pendingCopy; setPendingCopy(null); void performCopy(copy.id, copy.spec); }}>
        <p className="dialog-body">{t("mcp.copyOverwriteConfirm", { name: AI_NAMES[other(provider)], id: pendingCopy.id })}</p>
      </AiActionDialog> : null}
    </div>
  );
}

function MarketParameterField({ field, value, onChange }: {
  field: McpMarketParameter;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const label = `${field.label}${field.required ? ` · ${t("mcp.marketEnvRequired")}` : ""}`;
  const hint = parameterText(field);
  const control = field.kind === "boolean" ? (
    <Select value={value} label={label} placeholder={t("mcp.marketBoolean")}
      options={[{ value: "true", label: "true" }, { value: "false", label: "false" }]}
      onChange={onChange} />
  ) : field.enumValues.length ? (
    <Select value={value} label={label} placeholder={t("mcp.marketSelectValue")}
      options={field.enumValues.map((item) => ({ value: item, label: item }))}
      onChange={onChange} />
  ) : field.kind === "json" ? (
    <textarea className="ai-cli-env" rows={2} spellCheck={false} value={value}
      placeholder={field.placeholder ?? ""} onChange={(event) => onChange(event.target.value)} />
  ) : (
    <input className="text-input" spellCheck={false}
      type={field.secret ? "password" : field.kind === "number" || field.kind === "integer" ? "number" : "text"}
      value={value} placeholder={field.placeholder ?? ""} onChange={(event) => onChange(event.target.value)} />
  );
  return <label className="ai-cli-field">
    <span>{label}</span>
    {control}
    {hint ? <em className="ai-cli-hint">{hint}</em> : null}
  </label>;
}
