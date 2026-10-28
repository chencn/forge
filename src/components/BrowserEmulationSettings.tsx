import { useEffect, useState } from "react";
import { Monitor, RotateCw, Smartphone, Tablet, Wifi } from "lucide-react";
import { useI18n } from "../i18n";
import { BROWSER_DEVICES, BROWSER_NETWORKS, browserDeviceId, browserDeviceOptions, browserNetworkId } from "../lib/browser";
import type { BrowserEmulation, BrowserEmulationPatch } from "../lib/browser";

interface Props { value: BrowserEmulation; busy: boolean; disabled: boolean; onApply: (options: BrowserEmulationPatch) => Promise<unknown> }

/** 表单草稿与已应用状态分开；AI 更改模拟设置时，同一面板显示引擎的最新状态。 */
export default function BrowserEmulationSettings({ value, busy, disabled, onApply }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const signature = JSON.stringify(value);
  useEffect(() => setDraft(value), [signature]);
  const locked = busy || disabled;
  const preset = browserDeviceId(value);
  const network = browserNetworkId(value);
  const field = (key: "width" | "height" | "deviceScaleFactor" | "latencyMs" | "downloadMbps" | "uploadMbps", min: number, max: number, step = 1) => <label className="browser-emulation-field"><span>{t(`browser.emulation.${key}`)}</span><input type="number" required min={min} max={max} step={step} disabled={locked} value={draft[key] === null ? 1280 : Number.isFinite(draft[key]) ? draft[key] : ""} onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value === "" ? Number.NaN : Number(event.target.value) }))} /></label>;
  return <div className="browser-emulation-settings">
    <p className="browser-sheet-intro">{t("browser.emulation.hint")}</p>
    <label className="browser-emulation-field"><span>{t("browser.emulation.device")}</span><select disabled={locked} value={preset} onChange={(event) => void onApply(browserDeviceOptions(event.target.value))}>
      <option value="responsive">{t("browser.emulation.responsive")}</option>
      <option value="custom" disabled>{t("browser.emulation.custom")}</option>
      {(["desktop", "tablet", "phone"] as const).map((group) => <optgroup key={group} label={t(`browser.emulation.${group}`)}>{BROWSER_DEVICES.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.name}{group !== "desktop" ? ` · ${item.width} × ${item.height}` : ""}</option>)}</optgroup>)}
    </select></label>
    <div className="browser-device-shortcuts">{([{ id: "pc-1366", title: "desktop", icon: Monitor }, { id: "ipad-air", title: "tablet", icon: Tablet }, { id: "iphone-13", title: "phone", icon: Smartphone }] as const).map(({ id, title, icon: Icon }) => <button type="button" key={id} disabled={locked} onClick={() => void onApply(browserDeviceOptions(id))}><Icon size={16} />{t(`browser.emulation.${title}`)}</button>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); void onApply({ width: draft.width ?? 1280, height: draft.height, deviceScaleFactor: draft.deviceScaleFactor, mobile: draft.mobile, touch: draft.touch, userAgent: draft.userAgent }); }}>
      <div className="browser-emulation-grid">{field("width", 240, 3840)}{field("height", 240, 3840)}{field("deviceScaleFactor", 0.5, 4, 0.125)}<button type="button" className="browser-secondary" disabled={locked || value.width === null} onClick={() => void onApply({ width: value.height, height: value.width! })}><RotateCw size={14} />{t("browser.emulation.rotate")}</button></div>
      <div className="browser-emulation-checks">{(["mobile", "touch"] as const).map((key) => <label key={key}><input type="checkbox" disabled={locked} checked={draft[key]} onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.checked }))} />{t(`browser.emulation.${key}`)}</label>)}</div>
      <label className="browser-emulation-field"><span>User-Agent</span><input type="text" disabled={locked} maxLength={512} placeholder={t("browser.emulation.nativeAgent")} value={draft.userAgent} onChange={(event) => setDraft((previous) => ({ ...previous, userAgent: event.target.value }))} /></label>
      <button type="submit" className="browser-secondary" disabled={locked}>{t("browser.emulation.applyDevice")}</button>
    </form>
    <div className="browser-section-heading"><span><Wifi size={13} /> {t("browser.emulation.network")}</span></div>
    <label className="browser-emulation-field"><span>{t("browser.emulation.signal")}</span><select disabled={locked} value={network} onChange={(event) => { const profile = BROWSER_NETWORKS.find((item) => item.id === event.target.value); if (profile) { const { id: _id, ...options } = profile; void onApply(options); } }}>
      {BROWSER_NETWORKS.map((item) => <option key={item.id} value={item.id}>{t(`browser.emulation.${item.id}`)}</option>)}<option value="custom" disabled>{t("browser.emulation.custom")}</option>
    </select></label>
    <form onSubmit={(event) => { event.preventDefault(); void onApply({ offline: draft.offline, latencyMs: draft.latencyMs, downloadMbps: draft.downloadMbps, uploadMbps: draft.uploadMbps }); }}>
      <div className="browser-emulation-grid">{field("downloadMbps", 0, 10000, 0.01)}{field("uploadMbps", 0, 10000, 0.01)}{field("latencyMs", 0, 10000)}<label className="browser-emulation-offline"><input type="checkbox" checked={draft.offline} disabled={locked} onChange={(event) => setDraft((previous) => ({ ...previous, offline: event.target.checked }))} />{t("browser.emulation.offline")}</label></div>
      <small className="browser-emulation-note">{t("browser.emulation.bandwidthHint")}</small><button type="submit" className="browser-secondary" disabled={locked}>{t("browser.emulation.applyNetwork")}</button>
    </form>
    <label className="browser-emulation-field"><span>{t("browser.emulation.colorScheme")}</span><select value={value.colorScheme} disabled={locked} onChange={(event) => void onApply({ colorScheme: event.target.value as BrowserEmulation["colorScheme"] })}>{(["auto", "light", "dark"] as const).map((color) => <option key={color} value={color}>{t(`browser.emulation.${color}`)}</option>)}</select></label>
    <button type="button" className="browser-secondary" disabled={locked} onClick={() => void onApply({ reset: true })}>{t("browser.emulation.reset")}</button>
    <p className="browser-emulation-note">{t("browser.emulation.reloadHint")}</p>
  </div>;
}
