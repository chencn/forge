//! UI 与 MCP 共享真实引擎状态；预览缩放只影响呈现，不改变设备的 CSS 尺寸。
use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Emulation {
    pub width: Option<u32>,
    pub height: u32,
    pub device_scale_factor: f64,
    pub mobile: bool,
    pub touch: bool,
    pub user_agent: String,
    pub offline: bool,
    pub latency_ms: u32,
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub color_scheme: String,
}
impl Default for Emulation {
    fn default() -> Self {
        Self { width: None, height: 800, device_scale_factor: 1.0, mobile: false, touch: false,
            user_agent: String::new(), offline: false, latency_ms: 0, download_mbps: 0.0,
            upload_mbps: 0.0, color_scheme: "auto".into() }
    }
}
impl Emulation {
    pub fn patched(&self, patch: &Value) -> Result<Self, String> {
        forge_browser::validate("browser_emulate", patch).map_err(|e|format!("INVALID_ARGUMENT: {e}"))?;
        if patch["reset"] == true { return Ok(Self::default()); }
        let mut value = serde_json::to_value(self).map_err(|e|e.to_string())?;
        if patch["resetDevice"] == true {
            let defaults = serde_json::to_value(Self::default()).map_err(|e|e.to_string())?;
            for key in ["width", "height", "deviceScaleFactor", "mobile", "touch", "userAgent"] { value[key] = defaults[key].clone(); }
        }
        for (key, entry) in patch.as_object().ok_or("INVALID_ARGUMENT: object required")? {
            if key != "reset" && key != "resetDevice" { value[key] = entry.clone(); }
        }
        let next: Self = serde_json::from_value(value).map_err(|e|format!("INVALID_ARGUMENT: {e}"))?;
        if next.width.is_some_and(|n| !(240..=3840).contains(&n)) || !(240..=3840).contains(&next.height)
            || !(0.5..=4.0).contains(&next.device_scale_factor)
            || !(0.0..=10000.0).contains(&next.download_mbps) || !(0.0..=10000.0).contains(&next.upload_mbps)
            || !next.device_scale_factor.is_finite() || !next.download_mbps.is_finite() || !next.upload_mbps.is_finite()
            || next.user_agent.len() > 512 || next.user_agent.chars().any(char::is_control)
        { return Err("INVALID_ARGUMENT: invalid device metrics, bandwidth or user-agent".into()); }
        if next.width.is_none() && (next.mobile || next.touch || next.device_scale_factor != 1.0) {
            return Err("INVALID_ARGUMENT: choose a viewport width before overriding mobile, touch or pixel ratio".into());
        }
        Ok(next)
    }

    pub fn scale(&self, bounds: &Bounds) -> f64 {
        self.width.map_or(1.0, |width| (bounds.width / width as f64).min(bounds.height / self.height as f64).min(1.0))
    }
    pub fn bounds(&self, bounds: &Bounds) -> Bounds {
        let Some(width) = self.width else { return *bounds; };
        let scale = self.scale(bounds);
        let width = (width as f64 * scale).min(bounds.width);
        let height = (self.height as f64 * scale).min(bounds.height);
        Bounds { x: bounds.x + (bounds.width - width) / 2.0, y: bounds.y + (bounds.height - height) / 2.0, width, height }
    }
    pub fn metrics(&self, bounds: &Bounds) -> (&'static str, Value) {
        match self.width {
            None => ("Emulation.clearDeviceMetricsOverride", json!({})),
            Some(width) => ("Emulation.setDeviceMetricsOverride", json!({"width":width,"height":self.height,
                "deviceScaleFactor":self.device_scale_factor,"mobile":self.mobile,"scale":self.scale(bounds),
                "screenWidth":width,"screenHeight":self.height,
                "screenOrientation":{"type":if width>self.height {"landscapePrimary"}else{"portraitPrimary"},"angle":if width>self.height {90}else{0}}})),
        }
    }
    /// 截图专用设备参数：临时将 scale 置为 1.0，避免侧栏缩小适配导致截图中内容缩在局部、周围产生大片留白。
    pub fn capture_metrics(&self) -> Option<(&'static str, Value)> {
        self.width.map(|width| {
            ("Emulation.setDeviceMetricsOverride", json!({
                "width": width, "height": self.height,
                "deviceScaleFactor": self.device_scale_factor, "mobile": self.mobile, "scale": 1.0,
                "screenWidth": width, "screenHeight": self.height,
                "screenOrientation": {
                    "type": if width > self.height { "landscapePrimary" } else { "portraitPrimary" },
                    "angle": if width > self.height { 90 } else { 0 }
                }
            }))
        })
    }
    fn operations(&self, bounds: &Bounds) -> Vec<(&'static str, Value)> {
        // Mbps 是十进制比特率，CDP 要求字节/秒；0 表示不限速，不能误发成断流。
        let throughput = |mbps:f64| if mbps == 0.0 { -1.0 } else { mbps * 125000.0 };
        vec![self.metrics(bounds),
            ("Emulation.setTouchEmulationEnabled",json!({"enabled":self.touch,"maxTouchPoints":if self.touch {5}else{1}})),
            ("Emulation.setUserAgentOverride",json!({"userAgent":self.user_agent})),
            ("Network.emulateNetworkConditions",json!({"offline":self.offline,"latency":self.latency_ms,
                "downloadThroughput":throughput(self.download_mbps),"uploadThroughput":throughput(self.upload_mbps)})),
            ("Emulation.setEmulatedMedia",json!({"features":if self.color_scheme == "auto" {json!([])}else{json!([{"name":"prefers-color-scheme","value":self.color_scheme}])}}))]
    }
}

async fn dispatch(app: &AppHandle, id: &str, method: &str, params: Value, ticket: Option<&Ticket>) -> Result<(), String> {
    // 用户在设置面板关闭总开关后，正在应用的配置也必须停止派发。
    panel_tab(app, id)?;
    if let Some(ticket) = ticket { ticket.check(app, false)?; }
    surface::cdp(app, id, method, params, ticket.cloned(), false).await?;
    if let Some(ticket) = ticket { ticket.check(app, false)?; }
    Ok(())
}

/// 调用方持有页面队列；只有全部引擎调用完成才发布状态，失败时恢复旧设置。
pub async fn apply(app: &AppHandle, id: &str, patch: Value, ticket: Option<&Ticket>) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    let next = tab.emulation.patched(&patch)?;
    let mut failure = None;
    for (method, params) in next.operations(&tab.preview_bounds) {
        if let Err(error) = dispatch(app, id, method, params, ticket).await { failure = Some(error); break; }
    }
    if failure.is_none() {
        if let Err(error) = surface::reframe(app, id, next.bounds(&tab.preview_bounds)).await { failure = Some(error); }
    }
    if let Some(error) = failure {
        // 撤权后不再调用引擎；保留明确的部分派发错误，不自动重试用户动作。
        if ticket.is_none_or(|ticket|ticket.check(app, false).is_ok()) {
            for (method, params) in tab.emulation.operations(&tab.preview_bounds) {
                if let Err(rollback) = dispatch(app, id, method, params, ticket).await {
                    return Err(format!("EMULATION_FAILED: {error}; restore failed: {rollback}"));
                }
            }
            surface::reframe(app, id, tab.emulation.bounds(&tab.preview_bounds)).await
                .map_err(|restore|format!("EMULATION_FAILED: {error}; restore bounds failed: {restore}"))?;
        }
        return Err(format!("EMULATION_FAILED: {error}"));
    }
    {
        let mut state = host(app).lock();
        let tab = state.tabs.get_mut(id).ok_or("page closed")?;
        tab.preview_scale = next.scale(&tab.preview_bounds);
        tab.emulation = next.clone();
        tab.refs.clear();
    }
    // 模拟设备只改变布局，所选 DOM 元素仍有效；重新定位高亮而不清除标记。
    picker::restore_highlight(app, id).await?;
    changed(app);
    Ok(json!({"dispatch":"dispatched","emulation":next,"reloadRecommended":patch.get("userAgent").is_some()}))
}

/// 设备截图的 CSS 裁剪框。
/// 可视区域比设备更大时，多出来的是侧栏或窗口，不能整屏截进去。
/// 布局视口已是设备尺寸时从布局原点取；两边都是整屏时取居中的设备框。
/// 可视区域更小时是触摸缩放，只保留当前看见的那一块。
pub fn screenshot_region(visual: CssBox, layout: CssBox, device: Option<(f64, f64)>) -> CssBox {
    let Some((width, height)) = device else { return visual };
    if visual.width + 1.0 < width || visual.height + 1.0 < height {
        return CssBox {
            x: visual.x,
            y: visual.y,
            width: visual.width.min(width),
            height: visual.height.min(height),
        };
    }
    if visual.width <= width + 1.0 && visual.height <= height + 1.0 {
        return CssBox { x: visual.x, y: visual.y, width: visual.width.min(width), height: visual.height.min(height) };
    }
    if layout.width <= width + 1.0 && layout.height <= height + 1.0 {
        return CssBox { x: layout.x, y: layout.y, width, height };
    }
    CssBox {
        x: visual.x + ((visual.width - width) / 2.0).max(0.0),
        y: visual.y + ((visual.height - height) / 2.0).max(0.0),
        width,
        height,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CssBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 改侧栏尺寸时先取消旧 AI 请求，再串行更新设备缩放，保证呈现不越过侧栏边界。
pub async fn present(app: &AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    let tab = panel_tab(app, &id)?;
    // 截图会临时改设备缩放。这时如果跟着侧栏尺寸把预览缩放写回去，裁出来的仍是整屏。
    if tab.capturing.load(std::sync::atomic::Ordering::Acquire) {
        let queue = tab.queue.clone();
        let _hold = queue.lock().await;
    }
    let tab = panel_tab(app, &id)?;
    let resized = tab.preview_bounds.width != bounds.width || tab.preview_bounds.height != bounds.height;
    if !resized || tab.emulation.width.is_none() {
        // 普通移动和隐藏不能排在 AI 等待之后，否则宿主弹层会被原生子窗口盖住。
        if let Some(current) = host(app).lock().tabs.get_mut(&id) { current.preview_bounds = bounds; }
        surface::show(app, Some(id.clone()), tab.emulation.bounds(&bounds)).await?;
        return picker::restore_highlight(app, &id).await;
    }
    if resized {
        let mut state = host(app).lock();
        let tab = state.tabs.get_mut(&id).ok_or("page closed")?;
        tab.revision += 1;
        tab.refs.clear();
    }
    let _queue = tab.queue.lock().await;
    let tab = panel_tab(app, &id)?;
    if resized && tab.emulation.width.is_some() {
        let (method, params) = tab.emulation.metrics(&bounds);
        surface::cdp(app, &id, method, params, None, false).await?;
    }
    let actual = tab.emulation.bounds(&bounds);
    {
        let mut state = host(app).lock();
        let tab = state.tabs.get_mut(&id).ok_or("page closed")?;
        tab.preview_bounds = bounds;
        tab.preview_scale = tab.emulation.scale(&bounds);
    }
    surface::show(app, Some(id.clone()), actual).await?;
    picker::restore_highlight(app, &id).await?;
    if resized { changed(app); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_emulation_capture_metrics_resets_preview_scale() {
        let mut emu = Emulation::default();
        assert!(emu.capture_metrics().is_none());

        emu.width = Some(390);
        emu.height = 844;
        emu.device_scale_factor = 3.0;
        emu.mobile = true;

        // 模拟窄侧栏环境：容器宽高只有 300x600，预览 scale 必然小于 1.0 (约 0.71)
        let bounds = Bounds { x: 0.0, y: 0.0, width: 300.0, height: 600.0 };
        let preview_scale = emu.scale(&bounds);
        assert!(preview_scale < 1.0, "preview scale must adapt down in narrow sidebar");

        let (_, preview_metrics) = emu.metrics(&bounds);
        assert_eq!(preview_metrics["scale"], json!(preview_scale));

        // 截图 metrics 必须强制 scale = 1.0，保证 100% 满幅无多余空白
        let (method, capture_metrics) = emu.capture_metrics().expect("must produce capture metrics");
        assert_eq!(method, "Emulation.setDeviceMetricsOverride");
        assert_eq!(capture_metrics["scale"], json!(1.0));
        assert_eq!(capture_metrics["width"], json!(390));
        assert_eq!(capture_metrics["height"], json!(844));
        assert_eq!(capture_metrics["deviceScaleFactor"], json!(3.0));

        let phone = CssBox { x: 0.0, y: 40.0, width: 390.0, height: 844.0 };
        let layout = CssBox { x: 3.0, y: 40.0, width: 390.0, height: 844.0 };
        assert_eq!(screenshot_region(phone, layout, Some((390.0, 844.0))), phone);
        // 可视区域是整屏、布局已是设备时，从布局原点取设备视口。
        let screen = CssBox { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(screenshot_region(screen, layout, Some((390.0, 844.0))), CssBox { x: 3.0, y: 40.0, width: 390.0, height: 844.0 });
        // 布局测量也是整屏时，页面在侧栏里居中，只取正中的设备框。
        assert_eq!(
            screenshot_region(screen, screen, Some((390.0, 844.0))),
            CssBox { x: 765.0, y: 118.0, width: 390.0, height: 844.0 }
        );
        let pinched = CssBox { x: 12.0, y: 20.0, width: 260.0, height: 500.0 };
        assert_eq!(screenshot_region(pinched, layout, Some((390.0, 844.0))), pinched);
        assert_eq!(screenshot_region(screen, layout, None), screen);
    }
}

