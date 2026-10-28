import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Camera, Check, ChevronDown, Code2, Copy, Globe, History, House, LoaderCircle, LockKeyhole, Minus, MonitorSmartphone, MousePointer2, Plus, RefreshCw, RotateCw, Search, Settings2, ShieldCheck, ShieldOff, Signal, Square, TerminalSquare, Trash2, WifiOff, X } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import { browserAddress, browserElementMessage, browserNetworkId, browserPageOwner, browserStorageKey, copyBrowserScreenshot, DEFAULT_BROWSER_EMULATION, isRectOverlapping, loadBrowserLibrary, rememberBrowserLocation, saveBrowserLibrary } from "../lib/browser";
import type { BrowserElementSelection, BrowserEmulation, BrowserEmulationPatch, BrowserLocation, BrowserPicker } from "../lib/browser";
import BrowserEmulationSettings from "./BrowserEmulationSettings";
import type { AiInputPayload } from "../lib/aiInputBridge";
import { sameAiWorkspace } from "../lib/aiSessions";
import { openExternal } from "../lib/fs";
import "../styles/browser.css";

interface BrowserTab { id: string; sessionId: string; url: string; title: string; grant: "none" | "read" | "control"; loading: boolean; loadError: string | null; zoom: number; epoch: number; managed: boolean; emulation: BrowserEmulation; previewScale: number }
interface BrowserState { available: boolean; unavailable: string | null; tabs: BrowserTab[]; runs: { sessionId: string; runId: string; readOnly: boolean }[] }
interface ConsoleEntry { type: string | null; text: string; epoch: number }
interface NetworkEntry { id: string; method: string; url: string | null; type: string; status?: number; failed?: boolean; error?: string }
interface Details { canGoBack: boolean; canGoForward: boolean; console: ConsoleEntry[]; network: NetworkEntry[]; dialog: { type: string; message: string | null } | null; picker: BrowserPicker }
interface AnnotationSubmission { workspace: string; selection: BrowserElementSelection; problem: string }
interface Props { workspace: string; sessions: { id: string; title: string }[]; defaultSessionId: string | null; targetTabId: string | null; onTargetHandled: () => void; onAddToChat: (payload: AiInputPayload) => Promise<void>; chatTargetLabel: string }
const hiddenBounds = { x: 0, y: 0, width: 1, height: 1 };
const emptyDetails: Details = { canGoBack: false, canGoForward: false, console: [], network: [], dialog: null, picker: { active: false, selection: null, error: null } };
// 原生呈现队列跨卸载和工作区切换共享，过期回调不能重新显示旧页面。
let presentation = Promise.resolve();
/**
 * 检测视口上是否有遮挡浮层（对话框、菜单、模态层等）。
 * 只有当浮层与当前原生视口区域在几何空间上发生重叠相交时才判定为遮挡，
 * 避免会话气泡等其它区域弹出右键菜单时导致右侧浏览器无故白屏。
 */
function hasOverlay(viewportNode: HTMLElement | null) {
  if (!viewportNode) return false;
  const viewportRect = viewportNode.getBoundingClientRect();
  if (viewportRect.width <= 0 || viewportRect.height <= 0) return false;
  return Array.from(
    document.querySelectorAll(
      '[role="dialog"], [role="menu"], [aria-modal="true"], .context-menu, .popover, .prompt-overlay, .browser-suggestions'
    )
  ).some((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // 判断矩形是否相交重叠
    return isRectOverlapping(rect, viewportRect);
  });
}
function hostLabel(url: string) { try { return new URL(url).host; } catch { return url; } }
function IconButton({ label, children, onClick, disabled, active }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return <button type="button" className={`browser-icon${active ? " is-active" : ""}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

export default function BrowserPanel({ workspace, sessions, defaultSessionId, targetTabId, onTargetHandled, onAddToChat }: Props) {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const selectionKey = `${browserStorageKey(workspace)}:selected`;
  const [state, setState] = useState<BrowserState | null>(null);
  const [selected, setSelected] = useState<string | null>(() => { try { return targetTabId ?? sessionStorage.getItem(selectionKey); } catch { return targetTabId; } });
  const draft = useRef(selected === "new");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Details>(emptyDetails);
  const [overlay, setOverlay] = useState<"permissions" | "history" | "emulation" | null>(null);
  // 只切换工具栏显示，不重置页面已经应用的设备或网络模拟配置。
  const [deviceToolbarVisible, setDeviceToolbarVisible] = useState(false);
  const [diagnostics, setDiagnostics] = useState<"console" | "network" | null>(null);
  const [filter, setFilter] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [found, setFound] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [screenshotStatus, setScreenshotStatus] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [library, setLibrary] = useState(() => loadBrowserLibrary(workspace));
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  const request = useRef(0);
  const current = state?.tabs.find((tab) => tab.id === selected);
  const enabled = settings.browser.enabled;
  const canBrowse = enabled && state?.available === true;
  // 手动新页面归属浏览器要投递进去的那个会话；草稿或无关会话都不授予。
  const sessionId = browserPageOwner(sessions, defaultSessionId);
  const owner = sessions.find((item) => item.id === (current?.sessionId ?? sessionId));
  const running = state?.runs.some((run) => run.sessionId === current?.sessionId);
  const blocked = !enabled || !!overlay || !!current?.loadError || !!details.dialog;
  const tabs = state?.tabs ?? [];
  const emulation = current?.emulation ?? DEFAULT_BROWSER_EMULATION;
  const emulationSignature = JSON.stringify(emulation);
  const networkId = browserNetworkId(emulation);
  const deliverAnnotation = useRef<(payload: AnnotationSubmission) => Promise<void>>(async () => {});
  useEffect(() => {
    // 本地原生浮层负责输入，宿主继续复用当前会话附件入口和交付偏好。
    const stop = listen<AnnotationSubmission>("forge-browser-annotation-submit", ({ payload }) => {
      void deliverAnnotation.current(payload);
    });
    return () => { void stop.then((unlisten) => unlisten()); };
  }, [workspace]);
  useEffect(() => {
    const id = current?.id;
    // 切页或卸载只结束鼠标捕获；后端保留已选标记，重新打开仍能继续备注。
    return () => { if (id) void invoke("browser_panel_command", { tabId: id, command: { action: "inspect", enabled: false } }).catch(() => {}); };
  }, [current?.id]);

  // 只消费新的 AI 开页事件；侧栏重开时恢复用户选择，而非重复抢回旧目标。
  useEffect(() => { if (targetTabId) { draft.current = false; setSelected(targetTabId); setOverlay(null); onTargetHandled(); } }, [targetTabId, onTargetHandled]);
  useEffect(() => { try { sessionStorage.setItem(selectionKey, draft.current ? "new" : selected ?? "new"); } catch { /* 浏览器存储不可用不阻塞打开页面。 */ } }, [selected, selectionKey]);
  useEffect(() => { saveBrowserLibrary(workspace, library); }, [workspace, library]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  const reload = useCallback(async () => {
    const id = ++request.current;
    const value = await invoke<BrowserState>("browser_panel_state", { workspace });
    if (id !== request.current) return;
    setState(value);
    setSelected((tabId) => draft.current ? null : value.tabs.some((tab) => tab.id === tabId) ? tabId : value.tabs[0]?.id ?? null);
  }, [workspace]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer && active) timer = setTimeout(() => { timer = undefined; if (active) void reload().catch((cause) => setError(String(cause))); }, 120); };
    const stop = listen("forge-browser-changed", refresh);
    void reload().catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; ++request.current; clearTimeout(timer); void stop.then((unlisten) => unlisten()); };
  }, [reload]);
  useEffect(() => {
    setDetails(emptyDetails); setFound(null); setError(null); setPrompt(""); setScreenshotStatus(null);
    if (current) setAddress(current.url === "about:blank" ? "" : current.url);
    else setAddress("");
  }, [selected]);
  useEffect(() => { if (current && !editing.current) setAddress(current.url === "about:blank" ? "" : current.url); }, [current?.url]);
  useEffect(() => {
    if (!current || !canBrowse) return;
    let active = true;
    const timer = setTimeout(() => {
      void invoke<Details>("browser_panel_details", { tabId: current.id }).then((value) => { if (active) setDetails(value); }).catch(() => { /* 页面关闭或导航中的旧诊断不覆盖新标签状态。 */ });
    }, 100);
    return () => { active = false; clearTimeout(timer); };
  }, [state, selected, canBrowse]);
  useEffect(() => {
    if (!current || current.loading || current.loadError || !/^https?:/.test(current.url)) return;
    setLibrary((previous) => rememberBrowserLocation(previous, { url: current.url, title: current.title || hostLabel(current.url), visitedAt: Date.now() }));
  }, [current?.id, current?.url, current?.title, current?.loading, current?.loadError]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    let frame = 0, disposed = false, last = "";
    const send = (tabId: string | null, bounds: typeof hiddenBounds) => {
      const key = JSON.stringify([tabId, bounds]);
      if (last === key) return;
      last = key;
      presentation = presentation.then(async () => { if (!disposed) await invoke("browser_panel_show", { tabId, bounds }); }).catch((cause) => { if (!disposed) setError(String(cause)); });
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const visible = current && canBrowse && !blocked && !document.hidden && !hasOverlay(node) && rect.width >= 1 && rect.height >= 1;
        send(visible ? current.id : null, visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : hiddenBounds);
      });
    };
    const resize = new ResizeObserver(sync); resize.observe(node);
    const mutation = new MutationObserver(sync); mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "aria-hidden"] });
    window.addEventListener("resize", sync); document.addEventListener("visibilitychange", sync); document.addEventListener("scroll", sync, true);
    sync();
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", sync); document.removeEventListener("visibilitychange", sync); document.removeEventListener("scroll", sync, true);
      presentation = presentation.then(async () => { await invoke("browser_panel_show", { tabId: null, bounds: hiddenBounds }); }).catch(() => {});
    };
  }, [current?.id, canBrowse, blocked, emulationSignature]);

  const perform = async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { const result = await operation(); await reload(); return result; }
    catch (cause) { setError(String(cause)); return undefined; }
    finally { setBusy(false); }
  };
  const command = (value: Record<string, unknown>) => current ? perform(() => invoke<{ found?: boolean }>("browser_panel_command", { tabId: current.id, command: value })) : Promise.resolve(undefined);
  const emulate = (options: BrowserEmulationPatch) => command({ action: "emulate", options });
  const navigate = async (input = address) => {
    let url: string;
    try { url = browserAddress(input); } catch { setError(t("browser.invalidAddress")); return; }
    editing.current = false; setSuggestionsOpen(false); setOverlay(null); setAddress(url);
    await perform(async () => {
      if (current) await invoke("browser_panel_navigate", { tabId: current.id, url });
      else {
        const id = await invoke<string>("browser_panel_open", { workspace, sessionId, url });
        draft.current = false; setSelected(id);
      }
    });
  };
  const newTab = () => { draft.current = true; setSelected(null); setOverlay(null); setDetails(emptyDetails); setAddress(""); setError(null); requestAnimationFrame(() => addressInput.current?.focus()); };
  const closeTab = (tabId: string) => void perform(async () => {
    await invoke("browser_panel_close", { tabId });
    if (selected === tabId) { const index = tabs.findIndex((tab) => tab.id === tabId); setSelected(tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null); }
  });
  const chooseTab = (tabId: string) => { draft.current = false; setSelected(tabId); setOverlay(null); setSuggestionsOpen(false); };
  const find = async (backward = false) => { if (findText.trim()) { const result = await command({ action: "find", text: findText, backward }); setFound(result?.found ?? null); } };
  const capture = () => void perform(async () => {
    if (!current) return;
    setScreenshotStatus(null);
    const name = `forge-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const screenshot = invoke<{ dataUrl: string }>("browser_panel_command", { tabId: current.id, command: { action: "screenshot" } }).then(({ dataUrl }) => dataUrl);
    // 两条交付互不阻塞：剪贴板失败也保留会话附件，附件满时仍可复制图片。
    const [chat, clipboard] = await Promise.allSettled([
      screenshot.then((dataUrl) => onAddToChat({ kind: "image", dataUrl, name })),
      copyBrowserScreenshot(screenshot),
    ]);
    await screenshot;
    setScreenshotStatus(t(chat.status === "fulfilled" ? clipboard.status === "fulfilled" ? "browser.screenshotDone" : "browser.screenshotChatOnly" : clipboard.status === "fulfilled" ? "browser.screenshotClipboardOnly" : "browser.screenshotFailed"));
    const failures = [chat.status === "rejected" ? `${t("browser.addToChat")}: ${String(chat.reason)}` : "", clipboard.status === "rejected" ? `${t("browser.clipboard")}: ${String(clipboard.reason)}` : ""].filter(Boolean);
    if (failures.length) throw new Error(failures.join("; "));
  });
  deliverAnnotation.current = async ({ workspace: sourceWorkspace, selection, problem }) => {
    // 工作区切换与异步事件清理之间也不能把旧评论投递到新工作区。
    if (!sameAiWorkspace(sourceWorkspace, workspace)) {
      await invoke("browser_panel_command", { tabId: selection.tabId, command: { action: "annotationResult", selectionId: selection.selectionId, error: t("browser.selectionChanged") } }).catch(() => {});
      return;
    }
    setBusy(true); setError(null);
    let delivered = false;
    try {
      const fresh = await invoke<Details>("browser_panel_details", { tabId: selection.tabId });
      if (fresh.picker.selection?.selectionId !== selection.selectionId || fresh.picker.selection.epoch !== selection.epoch) throw new Error(t("browser.selectionChanged"));
      const mode = settings.browser.elementContent;
      const text = browserElementMessage(fresh.picker.selection, problem, mode !== "screenshot");
      if (mode === "code") await onAddToChat({ kind: "text", text });
      else {
        const { dataUrl } = await invoke<{ dataUrl: string }>("browser_panel_command", { tabId: selection.tabId, command: { action: "elementScreenshot", selectionId: selection.selectionId } });
        await onAddToChat({ kind: "image", dataUrl, name: `forge-element-${Date.now()}.png`, text });
      }
      delivered = true;
      await invoke("browser_panel_command", { tabId: selection.tabId, command: { action: "annotationResult", selectionId: selection.selectionId, error: null } });
      await reload();
    } catch (cause) {
      setError(String(cause));
      // 附件已经交付时不允许重发；交付失败才恢复面板的发送按钮。
      if (!delivered) await invoke("browser_panel_command", { tabId: selection.tabId, command: { action: "annotationResult", selectionId: selection.selectionId, error: String(cause) } }).catch(() => {});
    } finally { setBusy(false); }
  };
  const copyAddress = () => void perform(async () => { await navigator.clipboard.writeText(current?.url ?? address); setCopied(true); });
  const toggleOverlay = (value: typeof overlay) => setOverlay((previous) => previous === value ? null : value);
  const toggleDeviceToolbar = () => {
    setDeviceToolbarVisible((visible) => !visible);
    if (deviceToolbarVisible) setOverlay((previous) => previous === "emulation" ? null : previous);
  };
  const onKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && details.picker.active) {
      event.preventDefault(); void command({ action: "inspect", enabled: false }); return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (!["l", "t", "w", "f", "r"].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === "l") { addressInput.current?.focus(); addressInput.current?.select(); }
    if (key === "t") newTab();
    if (key === "w" && current && !busy) closeTab(current.id);
    if (key === "f") setFindOpen((open) => !open);
    if (key === "r" && !busy) void command({ action: "reload" });
  };
  const permissionKey = current?.grant === "control" ? "browser.controlShort" : current?.grant === "read" ? "browser.read" : "browser.private";
  const statusLabel = screenshotStatus ?? (state === null ? t("browser.connecting") : !state.available ? t("browser.unavailable") : current?.loading ? t("browser.loading") : running ? t("browser.running") : t("browser.ready"));
  const sessionLabel = (id: string) => `${t("browser.session")}: ${sessions.find((item) => item.id === id)?.title || t("browser.personal")}`;
  const locations = library.recent;
  const suggestions = library.recent.filter((item) => !address || address === current?.url || `${item.title} ${item.url}`.toLowerCase().includes(address.toLowerCase())).slice(0, 5);
  const locationList = (items: BrowserLocation[]) => items.map((item) => <div key={item.url} className="browser-location-row"><button type="button" className="browser-location" onClick={() => void navigate(item.url)} disabled={!canBrowse || busy}><span className="browser-site-icon"><Globe size={15} /></span><span><strong>{item.title || hostLabel(item.url)}</strong><small>{item.url}</small></span><ArrowUpRight size={14} /></button></div>);

  return <section className="browser-panel" aria-label={t("browser.title")} onKeyDown={onKeys}>
    <div className="browser-tabstrip">
      <div className="browser-tabs" role="tablist" aria-label={t("browser.pages")}>
        {tabs.map((tab) => <div key={tab.id} className={`browser-tab-wrap${selected === tab.id ? " is-selected" : ""}`}>
          <button type="button" className="browser-tab" role="tab" aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1} title={`${tab.title || t("browser.blank")}\n${tab.url}\n${sessionLabel(tab.sessionId)}`} onClick={() => chooseTab(tab.id)} onAuxClick={(event) => { if (event.button === 1 && !busy) closeTab(tab.id); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const index = tabs.findIndex((item) => item.id === tab.id); chooseTab(tabs[(index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length].id); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.browser-tab[aria-selected="true"]')?.focus()); } }}>
            {tab.loading ? <LoaderCircle size={13} className="is-spinning" /> : <Globe size={13} />}<span>{tab.title || (tab.url === "about:blank" ? t("browser.blank") : hostLabel(tab.url))}</span>{tab.grant !== "none" ? <span className="browser-tab-shared" title={t("browser.shared")} /> : null}
          </button>
          <button type="button" className="browser-tab-close" aria-label={`${t("browser.close")} ${tab.title || hostLabel(tab.url)}`} title={t("browser.close")} disabled={busy} onClick={() => closeTab(tab.id)}><X size={12} /></button>
        </div>)}
        {!current ? <button className="browser-tab is-draft" role="tab" aria-selected="true" type="button" title={sessionLabel(sessionId)}><Globe size={13} /><span>{t("browser.newTab")}</span></button> : null}
      </div>
      <IconButton label={t("browser.new")} onClick={newTab} disabled={busy || tabs.length >= 16}><Plus size={16} /></IconButton>
    </div>

    <div className="browser-navigation">
      <IconButton label={t("browser.back")} disabled={busy || !canBrowse || !details.canGoBack} onClick={() => void command({ action: "back" })}><ArrowLeft size={16} /></IconButton>
      <IconButton label={t("browser.forward")} disabled={busy || !canBrowse || !details.canGoForward} onClick={() => void command({ action: "forward" })}><ArrowRight size={16} /></IconButton>
      <IconButton label={t(current?.loading ? "browser.stop" : "browser.reload")} disabled={busy || !canBrowse || !current} onClick={() => void command({ action: current?.loading ? "stop" : "reload" })}>{current?.loading ? <Square size={13} /> : <RefreshCw size={15} />}</IconButton>
      <IconButton label={t("browser.home")} onClick={newTab}><House size={15} /></IconButton>
      <form className="browser-address" onSubmit={(event) => { event.preventDefault(); if (canBrowse && !busy) void navigate(); }}>
        <span className="browser-address-icon" title={current?.url.startsWith("https:") ? t("browser.secure") : t("browser.address")} aria-hidden="true">{current?.url.startsWith("https:") ? <LockKeyhole size={12} /> : <Search size={13} />}</span>
        <input ref={addressInput} aria-label={t("browser.address")} autoComplete="off" spellCheck={false} value={address} onFocus={(event) => { editing.current = true; setSuggestionsOpen(true); event.currentTarget.select(); }} onBlur={() => { editing.current = false; setSuggestionsOpen(false); }} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setAddress(current?.url ?? ""); setSuggestionsOpen(false); event.currentTarget.blur(); } }} placeholder={t("browser.addressPlaceholder")} />
        <button className="browser-address-go" type="submit" disabled={busy || !canBrowse || !address.trim()} title={t("browser.go")} aria-label={t("browser.go")}><ArrowRight size={13} /></button>
        {suggestionsOpen && suggestions.length > 0 ? <div className="browser-suggestions" onMouseDown={(event) => event.preventDefault()}>{locationList(suggestions)}</div> : null}
      </form>
      <IconButton label={t(details.picker.active ? "browser.cancelPick" : "browser.pickElement")} active={details.picker.active} disabled={!current || !canBrowse || busy || current.loading || blocked} onClick={() => void command({ action: "inspect", enabled: !details.picker.active })}><MousePointer2 size={15} /></IconButton>
      <IconButton label={t("browser.screenshot")} disabled={!current || !canBrowse || busy || current.loading || blocked} onClick={capture}><Camera size={15} /></IconButton>
    </div>
    <div className="browser-progress" aria-hidden="true">{current?.loading ? <span /> : null}</div>
    {deviceToolbarVisible ? <div className="browser-device-toolbar" aria-label={t("browser.emulation.title")}>
      <button type="button" aria-pressed={overlay === "emulation"} disabled={!current || !canBrowse || busy} onClick={() => toggleOverlay("emulation")}><MonitorSmartphone size={14} /><span>{t("browser.emulation.device")}</span><code>{emulation.width ? `${emulation.width} × ${emulation.height}` : t("browser.emulation.responsive")}</code><ChevronDown size={11} /></button>
      <IconButton label={t("browser.emulation.rotate")} disabled={!current || !canBrowse || busy || emulation.width === null} onClick={() => void emulate({ width: emulation.height, height: emulation.width! })}><RotateCw size={13} /></IconButton>
      {emulation.width ? <small title={t("browser.emulation.fit")}>{Math.round((current?.previewScale ?? 1) * 100)}%</small> : null}<span className="browser-flex" />
      <button type="button" disabled={!current || !canBrowse || busy} title={t("browser.emulation.network")} onClick={() => toggleOverlay("emulation")}>{emulation.offline ? <WifiOff size={13} /> : <Signal size={13} />}<span>{t(`browser.emulation.${networkId}`)}</span></button>
    </div> : null}
    {details.picker.active ? <div className="browser-inspect-bar is-active" role="status"><MousePointer2 size={14} /><span>{t("browser.pickActiveHint")}</span></div> : null}
    {findOpen ? <form className="browser-find" role="search" onSubmit={(event) => { event.preventDefault(); void find(); }}><Search size={14} /><input autoFocus aria-label={t("browser.find")} placeholder={t("browser.findPlaceholder")} maxLength={256} value={findText} onChange={(event) => { setFindText(event.target.value); setFound(null); }} onKeyDown={(event) => { if (event.key === "Escape") setFindOpen(false); if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); void find(true); } }} />{found === false ? <span>{t("browser.noMatches")}</span> : null}<IconButton label={t("browser.findPrevious")} onClick={() => void find(true)} disabled={!current || busy || !findText}><ArrowUp size={14} /></IconButton><IconButton label={t("browser.findNext")} onClick={() => void find()} disabled={!current || busy || !findText}><ArrowDown size={14} /></IconButton><IconButton label={t("browser.dismiss")} onClick={() => setFindOpen(false)}><X size={14} /></IconButton></form> : null}
    {error ? <div className="browser-error" role="alert"><WifiOff size={15} /><span>{error}</span><IconButton label={t("browser.dismiss")} onClick={() => setError(null)}><X size={14} /></IconButton></div> : null}

    <div className="browser-content">
      <div className="browser-viewport" ref={viewport} aria-label={t("browser.pageContent")} />
      {!state ? <div className="browser-center"><LoaderCircle size={23} className="is-spinning" /><p>{t("browser.connecting")}</p></div>
        : !state.available ? <div className="browser-center"><Globe size={32} /><h2>{t("browser.unavailable")}</h2><p>{state.unavailable ? t("browser.hostUnavailable") : t("browser.unsupported")}</p></div>
        : overlay ? <div className="browser-sheet"><header><span>{t(overlay === "permissions" ? "browser.permissions" : overlay === "emulation" ? "browser.emulation.title" : "browser.history")}</span><IconButton label={t("browser.dismiss")} onClick={() => setOverlay(null)}><X size={15} /></IconButton></header>
          {overlay === "permissions" ? <>
            <p className="browser-sheet-intro">{t("browser.permissionsHint")}</p>
            <button type="button" className="browser-secondary" disabled={!current || !canBrowse} onClick={() => setOverlay("emulation")}><MonitorSmartphone size={14} />{t("browser.emulation.title")}</button>
            <label className="browser-setting"><span><strong>{t("browser.enabled")}</strong><small>{t("browser.defaultHint")}</small></span><input type="checkbox" role="switch" checked={enabled} onChange={(event) => void patch({ browser: { enabled: event.target.checked } })} /></label>
            <label className="browser-setting browser-content-setting"><span><strong>{t("browser.elementContent")}</strong><small>{t("browser.elementContentHint")}</small></span><select value={settings.browser.elementContent} disabled={!enabled} onChange={(event) => void patch({ browser: { elementContent: event.target.value as typeof settings.browser.elementContent } })}>{(["code", "screenshot", "both"] as const).map((mode) => <option key={mode} value={mode}>{t(`browser.elementContent.${mode}`)}</option>)}</select></label>
            {current ? <div className="browser-access-card"><span className="browser-section-label">{t("browser.pageAccess")}</span><strong>{current.title || hostLabel(current.url)}</strong><small>{t("browser.session")}: {owner?.title || t("browser.personal")}</small><div className="browser-access-options">{(["none", "read", "control"] as const).map((grant) => <button type="button" key={grant} className={current.grant === grant ? "is-selected" : ""} disabled={busy || (!owner && grant !== "none") || !enabled} onClick={() => void perform(() => invoke("browser_panel_grant", { tabId: current.id, grant }))}>{grant === "none" ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}{t(grant === "none" ? "browser.private" : grant === "read" ? "browser.read" : "browser.controlShort")}</button>)}</div><p>{t("browser.shareHint")}</p></div> : null}
            <span className="browser-section-label">{t("browser.extraPermissions")}</span>
            {([{ key: "renderedPixels", title: "browser.pixels", hint: "browser.pixelsHint" }, { key: "fileUpload", title: "browser.upload", hint: "browser.uploadHint" }, { key: "unsafeEvaluate", title: "browser.evaluate", hint: "browser.evaluateHint" }] as const).map((item) => <label className="browser-setting" key={item.key}><span><strong>{t(item.title)}</strong><small>{t(item.hint)}</small></span><input type="checkbox" role="switch" checked={settings.browser[item.key]} disabled={!enabled} onChange={(event) => void patch({ browser: { [item.key]: event.target.checked } })} /></label>)}
          </> : overlay === "emulation" ? <BrowserEmulationSettings key={current?.id} value={emulation} busy={busy} disabled={!current || !canBrowse} onApply={emulate} /> : <><p className="browser-sheet-intro">{t("browser.historyHint")}</p>{locations.length ? locationList(locations) : <div className="browser-center is-inline"><History size={26} /><p>{t("browser.noHistory")}</p></div>}{locations.length ? <button type="button" className="browser-text-button" onClick={() => setLibrary((previous) => ({ ...previous, recent: [] }))}><Trash2 size={13} />{t("browser.clearHistory")}</button> : null}</>}
        </div>
        : !enabled ? <div className="browser-center"><ShieldOff size={32} /><h2>{t("browser.disabledTitle")}</h2><p>{t("browser.disabledHint")}</p><button className="browser-primary" type="button" onClick={() => void patch({ browser: { enabled: true } })}>{t("browser.enableAction")}</button></div>
        : details.dialog ? <div className="browser-dialog" role="dialog" aria-label={t("browser.pageDialog")}><Globe size={26} /><h2>{t("browser.pageDialog")}</h2><p>{details.dialog.message || t("browser.dialogFrameHint")}</p>{details.dialog.type === "prompt" ? <input aria-label={t("browser.dialogInput")} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} /> : null}<div><button type="button" className="browser-secondary" disabled={busy} onClick={() => void command({ action: "dialog", accept: false, text: "" })}>{t("browser.cancel")}</button><button type="button" className="browser-primary" disabled={busy} onClick={() => void command({ action: "dialog", accept: true, text: prompt })}>{t("browser.confirm")}</button></div></div>
        : current?.loadError ? <div className="browser-center"><WifiOff size={32} /><h2>{t("browser.loadFailed")}</h2><p>{hostLabel(current.url)}</p><code>{current.loadError}</code><button className="browser-primary" type="button" disabled={busy} onClick={() => void command({ action: "reload" })}><RefreshCw size={14} />{t("browser.tryAgain")}</button></div>
        : !current ? <div className="browser-start">
          {/* 通过地址栏打开实际页面，首页不预设项目使用的本地端口。 */}
          <div className="browser-start-mark"><Globe size={29} strokeWidth={1.5} /><span /></div><span className="browser-eyebrow">FORGE BROWSER</span><h1>{t("browser.startTitle")}</h1><p>{t("browser.startHint")}</p>
          {library.recent.length ? <><div className="browser-section-heading"><span>{t("browser.recent")}</span><button type="button" onClick={() => setOverlay("history")}>{t("browser.viewAll")}</button></div>{locationList(library.recent.slice(0, 4))}</> : null}
          <div className="browser-start-note"><ShieldCheck size={14} /><span>{t("browser.privateHint")}</span></div>
        </div> : null}
    </div>

    {details.picker.error ? <div className="browser-error" role="alert"><MousePointer2 size={14} /><span>{details.picker.error}</span><IconButton label={t("browser.dismiss")} onClick={() => void command({ action: "inspect", enabled: false })}><X size={14} /></IconButton></div> : null}
    {diagnostics ? <div className="browser-diagnostics"><div className="browser-diagnostics-head"><div role="tablist" aria-label={t("browser.diagnostics")}>{(["console", "network"] as const).map((item) => <button type="button" key={item} role="tab" aria-selected={diagnostics === item} className={diagnostics === item ? "is-selected" : ""} onClick={() => { setDiagnostics(item); setFilter(""); }}>{t(item === "console" ? "browser.console" : "browser.network")}<span>{details[item].length}</span></button>)}</div><span className="browser-flex" /><IconButton label={t("browser.clear")} disabled={!current || busy} onClick={() => void command({ action: diagnostics === "console" ? "clearConsole" : "clearNetwork" })}><Trash2 size={13} /></IconButton><IconButton label={t("browser.dismiss")} onClick={() => setDiagnostics(null)}><X size={14} /></IconButton></div><input className="browser-log-filter" aria-label={t("browser.filter")} placeholder={t("browser.filter")} value={filter} onChange={(event) => setFilter(event.target.value)} /><div className="browser-log-list" role="log" aria-live="off">{diagnostics === "console" ? details.console.filter((item) => item.text.toLowerCase().includes(filter.toLowerCase())).map((item, index) => <div className={`browser-console-line is-${item.type ?? "error"}`} key={`${item.epoch}:${index}`}><span>{item.type ?? "error"}</span><code>{item.text}</code></div>) : details.network.filter((item) => `${item.method} ${item.url} ${item.status ?? ""}`.toLowerCase().includes(filter.toLowerCase())).map((item, index) => <div className={`browser-network-line${item.failed || (item.status ?? 0) >= 400 ? " is-error" : ""}`} key={`${item.id}:${index}`} title={item.error || item.url || ""}><span>{item.method}</span><code>{item.url}</code><span>{item.failed ? t("browser.failed") : item.status ?? "…"}</span></div>)}{details[diagnostics].length === 0 ? <p className="browser-log-empty">{t(diagnostics === "console" ? "browser.consoleEmpty" : "browser.networkEmpty")}</p> : null}</div></div> : null}

    <footer className="browser-footer">
      <button type="button" className={`browser-access-badge is-${current?.grant ?? "none"}`} title={`${t(permissionKey)} · ${t("browser.permissions")}`} aria-label={`${t(permissionKey)} · ${t("browser.permissions")}`} onClick={() => toggleOverlay("permissions")}>{current?.grant === "none" || !current ? <ShieldOff size={12} /> : <ShieldCheck size={12} />}<span>{t(permissionKey)}</span>{running ? <span className="browser-running-dot" title={t("browser.running")} /> : null}</button>
      {/* 状态使用剩余宽度，所有操作始终在同一行，设置固定在最右侧。 */}
      <span className="browser-footer-status" role="status" title={statusLabel}>{statusLabel}</span>
      <IconButton label={t("browser.history")} active={overlay === "history"} onClick={() => toggleOverlay("history")}><History size={14} /></IconButton>
      <IconButton label={t("browser.find")} active={findOpen} onClick={() => setFindOpen((value) => !value)} disabled={!current}><Search size={14} /></IconButton>
      <IconButton label={t("browser.diagnostics")} active={!!diagnostics} onClick={() => setDiagnostics((value) => value ? null : "console")}><TerminalSquare size={14} /></IconButton>
      <IconButton label={t("browser.devtools")} disabled={!current || !canBrowse || busy} onClick={() => void command({ action: "devtools" })}><Code2 size={14} /></IconButton>
      <IconButton label={t(copied ? "browser.copied" : "browser.copyAddress")} disabled={!current || busy} onClick={copyAddress}>{copied ? <Check size={14} /> : <Copy size={13} />}</IconButton>
      <IconButton label={t("browser.openExternal")} disabled={!current || !/^https?:/.test(current.url)} onClick={() => void perform(() => openExternal(current!.url))}><ArrowUpRight size={15} /></IconButton>
      <IconButton label={t(deviceToolbarVisible ? "browser.emulation.hideToolbar" : "browser.emulation.showToolbar")} active={deviceToolbarVisible} onClick={toggleDeviceToolbar}><MonitorSmartphone size={13} /></IconButton>
      <IconButton label={t("browser.zoomOut")} disabled={!current || busy || !canBrowse || (current.zoom ?? 1) <= 0.5} onClick={() => void command({ action: "zoom", factor: Math.max(0.5, Math.round(((current?.zoom ?? 1) - 0.1) * 10) / 10) })}><Minus size={12} /></IconButton>
      <button className="browser-zoom" type="button" disabled={!current || busy || !canBrowse} title={t("browser.resetZoom")} onClick={() => void command({ action: "zoom", factor: 1 })}>{Math.round((current?.zoom ?? 1) * 100)}%</button>
      <IconButton label={t("browser.zoomIn")} disabled={!current || busy || !canBrowse || (current.zoom ?? 1) >= 2} onClick={() => void command({ action: "zoom", factor: Math.min(2, Math.round(((current?.zoom ?? 1) + 0.1) * 10) / 10) })}><Plus size={12} /></IconButton>
      <IconButton label={t("browser.permissions")} active={overlay === "permissions"} onClick={() => toggleOverlay("permissions")}><Settings2 size={14} /></IconButton>
    </footer>
  </section>;
}
