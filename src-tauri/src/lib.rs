mod ai_cli;
mod ai_runtime;
mod ai_commit;
mod error;
mod http_exchange;
mod fs;
mod git;
mod history;
mod lsp;
mod maven;
mod lsp_config;
mod lsp_detect;
mod lsp_probe;
mod local_history;
mod offload;
mod proc;
mod run;
mod settings;
mod shell_open;
#[cfg(windows)]
mod shell_sparse;
mod single_instance;
mod sys;
mod term;
mod term_layout;
mod term_long_input;
mod tray;
mod update;
mod watch;

use tauri::Manager;

pub fn run() {
    #[cfg(windows)]
    init_app_user_model_id();

    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    // 卸载器在删文件之前调一次：把双击默认、ProgId、右键动词一并交还，
    // 否则卸载后双击 .txt 还会去找已经不存在的 forge.exe。
    if raw_args.iter().any(|arg| arg == "--uninstall-clean") {
        if let Err(error) = shell_open::clean_for_uninstall() {
            eprintln!("[forge] 卸载清理未完成：{error}");
        }
        return;
    }

    // 单实例检查：若已有主实例在运行，将启动参数转交给主实例并在已有窗口中打开，随后本从实例立即退出。
    // 这彻底避免了重复创建多余窗口，并防止从实例因独立初始化无法连接前端服务而弹报错页面。
    if single_instance::try_forward(&raw_args) {
        return;
    }

    // build + run 拆开是为了在事件循环上挂 RunEvent::Exit 的退出清理（见下面的 app.run）。
    let args_for_setup = raw_args.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 更新检查/下载在设置页手动触发；relaunch 供装完新包后重启应用。
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 窗口几何（位置/大小/最大化）自动落盘并在下次启动还原；首次启动无存档时
        // 才走 tauri.conf.json 里的 center 默认值。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(watch::WatchSlot::default())
        .manage(shell_open::Pending::default())
        .setup(move |app| {
            ai_cli::settings::init(app.handle());
            tray::build(&app.handle().clone())?;
            disable_default_context_menu(app.handle());
            ai_runtime::start_queue_monitor(app.handle().clone())?;
            single_instance::start_server(app.handle().clone());
            // 首次启动若带有路径参数，由主实例窗口打开
            shell_open::deliver(app.handle(), &args_for_setup);
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
            fs::stat_entries,
            fs::find_files,
            fs::search_text,
            local_history::local_history_record,
            local_history::local_history_list,
            local_history::local_history_get,
            local_history::local_history_restore,
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
            term::term_write_bytes,
            term::term_set_paused,
            term::term_resize,
            term::term_close,
            term::term_reap,
            term::term_windows_build,
            term_layout::term_layout_load,
            term_layout::term_layout_save,
            proc::proc_start,
            proc::proc_kill,
            run::dep_sync::dep_sync_probe,
            run::detect::run_detect,
            run::detect::run_tools,
            run::store::run_state_load,
            run::store::run_state_save,
            maven::maven_scan,
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
            shell_open::shell_builtin_extensions,
            shell_open::shell_integration_apply,
            shell_open::shell_open_take,
            tray::tray_labels,
            tray::app_exit,
            tray::app_cancel_exit,
            sys::sys_memory,
            update::update_pending_load,
            update::update_pending_save,
            update::update_pending_clear,
            update::update_check,
            update::update_download_cached,
            update::update_install_cached,
            update::update_cache_state,
            update::update_cache_remove,
            ai_cli::ai_cli_probe,
            ai_cli::ai_cli_updates,
            ai_cli::ai_cli_manage,
            ai_cli::settings::ai_cli_settings_load,
            ai_cli::settings::ai_cli_settings_save,
            ai_cli::settings::ai_cli_config_read,
            ai_cli::settings::ai_cli_config_write,
            ai_cli::settings::ai_cli_claude_settings_read,
            ai_cli::settings::ai_cli_claude_settings_save,
            ai_cli::settings::ai_cli_claude_hooks_read,
            ai_cli::settings::ai_cli_claude_hooks_save,
            ai_cli::settings::ai_cli_codex_settings_read,
            ai_cli::settings::ai_cli_codex_settings_save,
            ai_cli::settings::ai_cli_diagnostics,
            ai_cli::codex_catalog::ai_cli_codex_catalog_read,
            ai_cli::codex_catalog::ai_cli_codex_catalog_save,
            ai_cli::codex_catalog::ai_cli_codex_catalog_text,
            ai_cli::codex_catalog::ai_cli_codex_catalog_home,
            ai_cli::providers::ai_providers_load,
            ai_cli::providers::ai_providers_save,
            ai_cli::providers::ai_providers_apply,
            ai_cli::skills::ai_skills_list,
            ai_cli::skills::ai_skill_read,
            ai_cli::skills::ai_skill_save,
            ai_cli::skills::ai_skill_delete,
            ai_cli::mcp::ai_mcp_list,
            ai_cli::mcp::ai_mcp_market_providers,
            ai_cli::mcp::ai_mcp_market_search,
            ai_cli::mcp::ai_mcp_market_detail,
            ai_cli::mcp::ai_mcp_market_resolve,
            ai_cli::mcp::ai_mcp_save,
            ai_cli::mcp::ai_mcp_delete,
            ai_runtime::ai_runtime_send,
            ai_runtime::ai_runtime_plan_defer,
            ai_runtime::ai_runtime_directory_for_path,
            ai_runtime::ai_runtime_save_pasted_image,
            ai_runtime::ai_runtime_save_image_file,
            ai_runtime::ai_runtime_save_text_attachment,
            ai_runtime::ai_runtime_file_line_count,
            ai_runtime::ai_runtime_delete_image,
            ai_runtime::ai_runtime_image_limits,
            ai_runtime::ai_runtime_create,
            ai_runtime::ai_runtime_models,
            ai_runtime::ai_runtime_project_trusted,
            ai_runtime::ai_runtime_project_config,
            ai_runtime::ai_runtime_update_project_config,
            ai_runtime::ai_runtime_activity,
            ai_runtime::ai_runtime_refresh_models,
            ai_runtime::ai_runtime_save_model,
            ai_runtime::ai_runtime_custom_models,
            ai_runtime::ai_runtime_remove_model,
            ai_runtime::ai_runtime_load,
            ai_runtime::ai_runtime_outline,
            ai_runtime::ai_runtime_stop,
            ai_runtime::ai_runtime_queue_update,
            ai_runtime::ai_runtime_queue_move,
            ai_runtime::ai_runtime_queue_run_now,
            ai_runtime::ai_runtime_queue_clear,
            ai_runtime::ai_runtime_stop_all,
            ai_runtime::ai_runtime_respond,
            ai_runtime::ai_runtime_set_goal_status,
            ai_runtime::ai_runtime_delete,
            ai_runtime::ai_runtime_delete_archived,
            ai_runtime::ai_runtime_list,
            ai_runtime::ai_runtime_rename,
            ai_runtime::ai_runtime_archive,
            ai_runtime::ai_runtime_set_pinned,
            ai_runtime::ai_runtime_search,
            ai_runtime::ai_runtime_stop_project,
            ai_runtime::ai_session_checkpoint_save,
            ai_runtime::ai_session_checkpoint_restore,
            ai_runtime::ai_runtime_agent_forward,
            ai_runtime::ai_runtime_agent_stop,
            ai_commit::ai_commit_config_load,
            ai_commit::ai_commit_config_save,
            ai_commit::ai_commit_generate,
            ai_commit::ai_commit_cancel,
            ai_commit::ai_commit_list_models,
            http_exchange::http_exchange,
            http_exchange::http_env,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
    // 退出清理选 RunEvent::Exit：它在事件循环真正退出前发出，任何退出路径
    // （关窗、托盘退出、app.exit）都必经且不可拦截；ExitRequested 会被
    // api.prevent_exit() 拦下，在那儿清理会错杀本该活着的会话。
    // 这几张表里的子进程（AI CLI、构建命令、语言服务、终端 shell）裸持着 Child，
    // 不在这儿杀掉，应用一退它们就全成孤儿。
    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            single_instance::stop_server();
            ai_runtime::reap_all_for_exit();
            lsp::reap_all_for_exit();
            proc::reap_all_for_exit();
            term::reap_all_for_exit();
        }
    });
}

/// 关掉 WebView2 自带的浏览器界面：右键菜单，以及 Ctrl+F 那条页面查找。
///
/// 前端在 `App.tsx` 里也拦了 `contextmenu`，但那道拦在页面 JS 里：页面一旦挂了
/// （白屏），监听器随之消失，原生菜单就冒出来了——而这恰恰是最不该看见它的时候。
/// Ctrl+F 同理：浏览器查找在快捷键到达页面前就画出来，`preventDefault` 拦不住。
/// `AreBrowserAcceleratorKeysEnabled` 是 WebView2 给这类快捷键的总开关，关掉之后
/// Ctrl+F / F3、刷新、打印、缩放不再由浏览器吃掉，按键交给页面自己的查找。
/// 设置挂在 `ICoreWebView2Settings` 上，要在 webview 线程里拿 controller 改。
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
            let mut browser_pid = 0u32;
            if core.BrowserProcessId(&mut browser_pid).is_ok() && browser_pid != 0 {
                sys::set_webview_browser_pid(browser_pid);
            }
            let Ok(settings) = core.Settings() else {
                return;
            };
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings3.SetAreDefaultContextMenusEnabled(false);
                // 浏览器查找、刷新、打印、缩放。复制粘贴这类编辑键不在这张表里。
                let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

/// 非 Windows 平台没有 WebView2，这条设置不存在，空实现。
#[cfg(not(windows))]
fn disable_default_context_menu(_app: &tauri::AppHandle) {}

/// 显式设置进程的 Application User Model ID。
///
/// Windows 任务栏根据 AppUserModelID 对窗口进行分组和绑定快捷方式图标。
/// 安装包给开始菜单和桌面快捷方式写入了 `app.forge.desktop`，这里在主窗口创建前
/// 显式设置相同 ID，确保无论是从快捷方式、右键菜单、文件关联还是命令行启动，
/// 任务栏始终展示相同的彩色图标，并正确归组到固定快捷方式中。
#[cfg(windows)]
fn init_app_user_model_id() {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from("app.forge.desktop"));
    }
}
