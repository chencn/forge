//! 系统托盘与「点关闭做什么」。
//!
//! 托盘菜单只有两项：叫回窗口、退出。窗口收进托盘后进程还在跑，文件监听和终端
//! 都不受影响，所以右下角那颗图标是「还能回来」的唯一线索。
//!
//! 菜单文字由前端推进来（`tray_labels`）。Rust 里写死中文的话，切到英文界面后
//! 托盘菜单还是中文，和刚清理过的错误文案是同一回事。

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, CloseRequestApi, Emitter, Manager, Window, Wry};

use crate::settings;

/// 退出前正等前端把没保存的东西写盘。
///
/// 关掉窗口要先存盘，就得先拦住这次关闭、等前端回话；可前端要是回不来
/// （页面挂了），应用就永远关不掉了，所以配一条看门狗兜底。
static FLUSHING: AtomicBool = AtomicBool::new(false);

/// 等前端存盘的上限。一次写盘是毫秒级的事，留 5 秒是给大文件和不快的磁盘余量。
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// 托盘上那两条菜单项，换语言时改文字用。
pub struct TrayMenu {
    show: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// 建托盘。图标用打包进去的那份，不额外带图片解码依赖。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Forge", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("forge-tray")
        .menu(&menu)
        // 左键叫回窗口，菜单留给右键；不然一点图标弹的是菜单，托盘应用都这么干。
        .show_menu_on_left_click(false)
        .tooltip("Forge")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal(app),
            "quit" => quit_now(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayMenu { show, quit });
    Ok(())
}

/// 托盘菜单的文字，跟着界面语言走。
#[tauri::command]
pub fn tray_labels(menu: tauri::State<'_, TrayMenu>, show: String, quit: String) -> Result<(), String> {
    menu.show
        .set_text(show)
        .map_err(|error| error.to_string())?;
    menu.quit
        .set_text(quit)
        .map_err(|error| error.to_string())
}

/// 点关闭：按设置收进托盘，或者先让前端存盘再退。
pub fn handle_close(app: &AppHandle, window: &Window, api: &CloseRequestApi) {
    let current = settings::read(app);
    if current.close_behavior == "tray" {
        api.prevent_close();
        let _ = window.hide();
        return;
    }
    if wants_flush(&current) {
        api.prevent_close();
        request_flush(app);
    }
}

/// 托盘上的「退出」，和点关闭走同一条路：该存的先存。
fn quit_now(app: &AppHandle) {
    if wants_flush(&settings::read(app)) {
        request_flush(app);
    } else {
        app.exit(0);
    }
}

fn wants_flush(current: &settings::Settings) -> bool {
    current.editor.save_on_exit
}

/// 叫前端存盘。它存完会调 `app_exit`；那时限内没回音就自己走，别把应用关不掉。
fn request_flush(app: &AppHandle) {
    if FLUSHING.swap(true, Ordering::SeqCst) {
        // 上一轮还没回来，说明事件已经发出去了，别重复发。
        return;
    }
    let _ = app.emit("app://flush", ());
    let watchdog = app.clone();
    thread::spawn(move || {
        thread::sleep(FLUSH_TIMEOUT);
        if FLUSHING.load(Ordering::SeqCst) {
            watchdog.exit(0);
        }
    });
}

/// 前端存完盘（或不打算存）之后的真正退出。
#[tauri::command]
pub fn app_exit(app: AppHandle) {
    FLUSHING.store(false, Ordering::SeqCst);
    app.exit(0);
}

fn reveal(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}
