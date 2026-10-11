mod error;
mod fs;
mod git;
mod history;
mod lsp;
mod lsp_config;
mod lsp_detect;
mod lsp_probe;
mod offload;
mod proc;
mod run;
mod settings;
mod sys;
mod term;
mod tray;
mod watch;

use tauri::Manager;

pub fn run() {
    // build + run 拆开是为了在事件循环上挂 RunEvent::Exit 的退出清理（见下面的 app.run）。
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchSlot::default())
        .setup(|app| {
            tray::build(&app.handle().clone())?;
            disable_default_context_menu(app.handle());
            Ok(())
        })
        // 关闭按钮归关闭按钮管，托盘还是退出，看设置里那一项怎么选。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                tray::handle_close(window.app_handle(), window, api);
            }
        })
        .invoke_handler(tauri::generate_handler![
            fs::list_directory,
            fs::read_file,
            fs::write_file,
            fs::create_folder,
            fs::create_file,
            fs::rename_entry,
            fs::copy_entry,
            fs::move_entry,
            fs::delete_entry,
            fs::reveal_entry,
            fs::file_stamp,
            fs::find_files,
            fs::search_text,
            fs::fs_allow_asset,
            fs::open_external,
            watch::fs_watch_start,
            watch::fs_watch_stop,
            git::git_probe,
            git::git_init,
            git::git_status,
            git::git_show,
            git::git_index_show,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branches,
            git::git_tags,
            git::git_remotes,
            git::git_ignored,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_create_tag,
            git::git_log,
            git::git_authors,
            git::git_commit_detail,
            git::git_commit_file,
            git::git_checkout,
            git::git_create_branch,
            git::git_merge,
            git::git_rebase,
            git::git_rename_branch,
            git::git_delete_branch,
            git::git_delete_tag,
            git::git_push_ref,
            git::git_delete_remote_branch,
            git::git_worktree_add,
            git::git_ignore_rule,
            git::git_restore_file,
            git::git_diff_text,
            git::git_diff_names,
            git::git_rebase_continue,
            git::git_rebase_abort,
            git::git_merge_continue,
            git::git_merge_abort,
            git::git_cherry_pick,
            git::git_cherry_pick_continue,
            git::git_cherry_pick_abort,
            git::git_revert,
            git::git_revert_continue,
            git::git_revert_abort,
            git::git_reset,
            git::git_push_up_to,
            git::git_resolve_conflict,
            git::git_amend_targets,
            term::term_open,
            term::shell_probe,
            term::term_write,
            term::term_resize,
            term::term_close,
            term::term_reap,
            proc::proc_start,
            proc::proc_kill,
            run::detect::run_detect,
            run::detect::run_tools,
            run::store::run_state_load,
            run::store::run_state_save,
            lsp::lsp_start,
            lsp::lsp_write,
            lsp::lsp_stop,
            lsp::lsp_reap,
            lsp::lsp_session_statuses,
            lsp::lsp_failed,
            lsp::lsp_retry,
            lsp_config::lsp_config_load,
            lsp_config::lsp_config_save,
            lsp_detect::lsp_resolve_root,
            lsp_probe::lsp_probe,
            lsp_probe::lsp_install,
            history::history_load,
            history::history_save,
            settings::settings_load,
            settings::settings_save,
            tray::tray_labels,
            tray::app_exit,
            sys::sys_memory,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
    // 退出清理选 RunEvent::Exit：它在事件循环真正退出前发出，任何退出路径
    // （关窗、托盘退出、app.exit）都必经且不可拦截；ExitRequested 会被
    // api.prevent_exit() 拦下，在那儿清理会错杀本该活着的会话。
    // 这三张表里的子进程（构建命令、语言服务、终端 shell）裸持着 Child，
    // 不在这儿杀掉，应用一退它们就全成孤儿。
    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            lsp::reap_all_for_exit();
            proc::reap_all_for_exit();
            term::reap_all_for_exit();
        }
    });
}

/// 关掉 WebView2 自带的右键菜单（返回 / 刷新 / 另存为 / 打印 / 检查）。
///
/// 前端在 `App.tsx` 里也拦了 `contextmenu`，但那道拦在页面 JS 里：页面一旦挂了
/// （白屏），监听器随之消失，原生菜单就冒出来了——而这恰恰是最不该看见它的时候。
/// 所以从 WebView2 设置上关掉，不依赖页面存活。设置挂在 `ICoreWebView2Settings` 上，
/// 要在 webview 线程里拿 controller 改。
///
/// 失败不当回事：拿不到 controller 只说明这条优化没生效，界面照常可用。
#[cfg(windows)]
fn disable_default_context_menu(app: &tauri::AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        // SAFETY：controller 由 WebView2 线程持有，这里就在那条线程上调用；
        // 取不到 Settings 接口就什么都不做，不 panic。
        unsafe {
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings3.SetAreDefaultContextMenusEnabled(false);
            }
        }
    });
}

/// 非 Windows 平台没有 WebView2，这条设置不存在，空实现。
#[cfg(not(windows))]
fn disable_default_context_menu(_app: &tauri::AppHandle) {}
