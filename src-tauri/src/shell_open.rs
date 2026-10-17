//! 资源管理器里的「通过 Forge 打开」。
//!
//! 文件夹进项目，文件只暂时打开。文件必须落在下面这份文本白名单里。
//! 右键动词在 Windows 10 直接出现，在 Windows 11 的新菜单里走「打开方式」，
//! 完整菜单仍在「显示更多选项」。默认打开另外记一份，关掉时交还给原来的程序。

use crate::error::err;
use crate::offload::block;
use base64::Engine;
use crate::tray;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// 右键菜单在注册表里的键名。跟别的程序的 `Forge` 错开。
const VERB: &str = "ForgeOpen";

/// 编辑器认得出、并且本体是文本的扩展名。小写，不含点。
///
/// 以编辑器语言表为准，再补上纯文本常见后缀。压缩过的 `svgz` 不在里面：
/// 它不是文本。无扩展名的 `Dockerfile`、`Makefile` 资源管理器无法按后缀挂菜单，
/// 所以也不在这里。
const TEXT_EXTENSIONS: &[&str] = &[
    "adoc", "asciidoc", "axaml", "bash", "bat", "bicep", "c", "cc", "cfg", "cjs", "clj", "cljc",
    "cljs", "cmd", "coffee", "conf", "config", "cpp", "cs", "cshtml", "csproj", "css", "csv", "cts",
    "cyp", "cypher", "dart", "dax", "dockerfile", "edn", "env", "ex", "exs", "fs", "fsi", "fsproj",
    "fsscript", "fsx", "ftl", "ftlh", "ftlx", "gemspec", "go", "graphql", "h", "handlebars", "hbs",
    "hcl", "hpp", "htm", "html", "iecst", "ini", "jade", "java", "jl", "js", "json", "json5", "jsonc",
    "jsx", "kt", "kts", "less", "liquid", "log", "lua", "m", "manifest", "markdown", "md", "mdown",
    "mdx", "mjs", "mkd", "msdax", "mts", "org", "p", "pas", "php", "pl", "pm", "pp", "pq", "pqm",
    "properties", "props", "proto", "ps1", "psd1", "psm1", "pug", "py", "r", "rb", "rbx", "rjs",
    "rkt", "rq", "rs", "rst", "sass", "sbt", "sc", "scala", "sch", "scm", "scss", "sh", "sol", "sql",
    "ss", "st", "sv", "svelte", "svg", "svh", "swift", "targets", "tcl", "text", "tf", "tfvars",
    "toml", "ts", "tsp", "tsx", "tsv", "twig", "txt", "vbproj", "vcxproj", "vue", "wgsl", "wxi",
    "wxl", "wxs", "xaml", "xml", "xsd", "xsl", "xslt", "yaml", "yml", "zsh",
];

/// 启动参数里挑出来、交给编辑器的路径。
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellPlan {
    pub folders: Vec<String>,
    pub files: Vec<String>,
}

/// 前端还没挂上监听时先存在这里；监听好了再取走。
#[derive(Default)]
pub struct Pending(Mutex<ShellPlan>);

pub fn is_text_extension(ext: &str) -> bool {
    TEXT_EXTENSIONS
        .iter()
        .any(|item| item.eq_ignore_ascii_case(ext))
}

/// 把用户输入收成一条扩展名：去掉空白和前导点，小写。不合规则返回空。
pub fn canonical_extension(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("*.")
        .or_else(|| trimmed.strip_prefix('.'))
        .unwrap_or(trimmed);
    let text = stripped.trim().to_ascii_lowercase();
    if text.is_empty() || text.len() > 32 {
        return None;
    }
    let mut chars = text.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric() {
        return None;
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '-')) {
        return None;
    }
    Some(text)
}

/// 用户追加的扩展名。内置名单里已有的丢掉，重复的只留第一次。
pub fn normalize_extra_extensions(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw {
        let Some(ext) = canonical_extension(item) else {
            continue;
        };
        if is_text_extension(&ext) {
            continue;
        }
        if out.iter().any(|held: &String| held.eq_ignore_ascii_case(&ext)) {
            continue;
        }
        out.push(ext);
    }
    out
}

fn file_allowed(path: &Path, extras: &[String]) -> bool {
    let Some(ext) = path.extension().and_then(|item| item.to_str()) else {
        return false;
    };
    is_text_extension(ext) || extras.iter().any(|item| item.eq_ignore_ascii_case(ext))
}

/// 把一次启动的参数拆成文件夹和文本文件。旗标、不存在的路径、白名单外的文件都丢掉。
pub fn plan_shell_args(args: &[String], extras: &[String]) -> ShellPlan {
    let extras = normalize_extra_extensions(extras);
    let mut plan = ShellPlan::default();
    for arg in args {
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }
        let path = Path::new(arg);
        if path.is_dir() {
            plan.folders.push(arg.clone());
        } else if path.is_file() && file_allowed(path, &extras) {
            plan.files.push(arg.clone());
        }
    }
    plan
}

/// 记下这次要打开的路径，把窗口叫到前台，并通知前端来取。
pub fn deliver(app: &AppHandle, args: &[String]) {
    let extras = crate::settings::read(app).shell.extra_extensions;
    let plan = plan_shell_args(args, &extras);
    if plan.folders.is_empty() && plan.files.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<Pending>() {
        let mut guard = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.folders.extend(plan.folders);
        guard.files.extend(plan.files);
    }
    tray::show_main(app);
    let _ = app.emit("shell-open", true);
}

#[tauri::command]
pub fn shell_open_take(state: State<'_, Pending>) -> ShellPlan {
    let mut guard = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
    std::mem::take(&mut *guard)
}

/// 内置文本扩展名。设置页用来识别「已经存在、不能改」的那些。
#[tauri::command]
pub fn shell_builtin_extensions() -> Vec<String> {
    TEXT_EXTENSIONS.iter().map(|ext| (*ext).to_string()).collect()
}

/// 按开关把资源管理器菜单和默认打开写成当前状态。关掉就删掉我们写过的键。
#[tauri::command]
pub async fn shell_integration_apply(
    open_folder: bool,
    open_file: bool,
    default_file: bool,
    label: String,
    extra_extensions: Vec<String>,
) -> Result<(), String> {
    block(move || apply_integration(open_folder, open_file, default_file, &label, &extra_extensions)).await
}

fn apply_integration(
    open_folder: bool,
    open_file: bool,
    default_file: bool,
    label: &str,
    extra_extensions: &[String],
) -> Result<(), String> {
    let extras = normalize_extra_extensions(extra_extensions);
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|error| err("SHELL_REG", error))?;
        let exe = exe.display().to_string();
        registry::sync(
            open_folder,
            open_file,
            default_file,
            &exe,
            &clean_label(label),
            &extras,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (open_folder, open_file, default_file, label, extras);
        Ok(())
    }
}

fn clean_label(label: &str) -> String {
    let text: String = label.chars().filter(|ch| !ch.is_control()).take(64).collect();
    let text = text.trim();
    if text.is_empty() {
        "Open with Forge".to_string()
    } else {
        text.to_string()
    }
}

pub fn command_value(exe: &str, placeholder: &str) -> String {
    format!("\"{exe}\" \"{placeholder}\"")
}

/// Windows 用来校验「用户选择的默认程序」的固定句子。整段参与哈希前会再转成小写。
const USER_CHOICE_EXPERIENCE: &str =
    "User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}";

/// 经典 UserChoice 哈希。`filetime_high/low` 是把秒和毫秒抹掉之后的 FILETIME。
pub fn user_choice_hash(ext: &str, sid: &str, prog_id: &str, filetime_high: u32, filetime_low: u32) -> String {
    let raw = format!(
        "{ext}{sid}{prog_id}{filetime_high:08x}{filetime_low:08x}{USER_CHOICE_EXPERIENCE}"
    );
    let lower = raw.to_ascii_lowercase();
    let mut units: Vec<u16> = lower.encode_utf16().collect();
    units.push(0);
    let bytes: Vec<u8> = units.iter().flat_map(|unit| unit.to_le_bytes()).collect();
    hash_user_choice_bytes(&bytes)
}

fn hash_user_choice_bytes(input: &[u8]) -> String {
    let block_count = input.len() / 8;
    let digest = md5(input);
    let md5_0 = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let md5_1 = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]);
    let c0s = [
        [md5_0 | 1, 0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83],
        [md5_1 | 1, 0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69],
    ];
    let c1s = [
        [md5_0 | 1, 0xEF0569FB, 0x689B6B9F, 0x79F8A395, 0xC3EFEA97],
        [md5_1 | 1, 0xC31713DB, 0xDDCD1F0F, 0x59C3AF2D, 0x35BD1EC9],
    ];
    let mut h0 = 0u32;
    let mut h1 = 0u32;
    let mut h0_acc = 0u32;
    let mut h1_acc = 0u32;
    for i in 0..block_count {
        for j in 0..2 {
            let offset = (i * 2 + j) * 4;
            let word = u32::from_le_bytes(input[offset..offset + 4].try_into().unwrap_or([0; 4]));
            let c0 = &c0s[j];
            let c1 = &c1s[j];
            h0 = h0.wrapping_add(word);
            h0 = h0.wrapping_mul(c0[0]);
            h0 = word_swap(h0).wrapping_mul(c0[1]);
            h0 = word_swap(h0).wrapping_mul(c0[2]);
            h0 = word_swap(h0).wrapping_mul(c0[3]);
            h0 = word_swap(h0).wrapping_mul(c0[4]);
            h0_acc = h0_acc.wrapping_add(h0);

            h1 = h1.wrapping_add(word);
            h1 = word_swap(h1).wrapping_mul(c1[1]).wrapping_add(h1.wrapping_mul(c1[0]));
            h1 = (h1 >> 16).wrapping_mul(c1[2]).wrapping_add(h1.wrapping_mul(c1[3]));
            h1 = word_swap(h1).wrapping_mul(c1[4]).wrapping_add(h1);
            h1_acc = h1_acc.wrapping_add(h1);
        }
    }
    let mixed = [(h0 ^ h1).to_le_bytes(), (h0_acc ^ h1_acc).to_le_bytes()];
    let bytes = [mixed[0], mixed[1]].concat();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn word_swap(value: u32) -> u32 {
    (value >> 16) | (value << 16)
}

fn md5(message: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
        20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
        10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
        0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
        0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
        0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    let bit_len = (message.len() as u64).wrapping_mul(8);
    let mut data = message.to_vec();
    data.push(0x80);
    while (data.len() % 64) != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_le_bytes());
    let mut state = [0x67452301u32, 0xefcdab89, 0x98badcfe, 0x10325476];
    for chunk in data.chunks_exact(64) {
        let mut words = [0u32; 16];
        for (index, item) in words.iter_mut().enumerate() {
            let start = index * 4;
            *item = u32::from_le_bytes(chunk[start..start + 4].try_into().unwrap_or([0; 4]));
        }
        let (mut a, mut b, mut c, mut d) = (state[0], state[1], state[2], state[3]);
        for index in 0..64 {
            let (f, g) = match index {
                0..=15 => ((b & c) | (!b & d), index),
                16..=31 => ((d & b) | (!d & c), (5 * index + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * index + 5) % 16),
                _ => (c ^ (b | !d), (7 * index) % 16),
            };
            let next = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[index])
                    .wrapping_add(words[g])
                    .rotate_left(S[index]),
            );
            a = d;
            d = c;
            c = b;
            b = next;
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
    }
    let mut out = [0u8; 16];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    out
}

#[cfg(windows)]
mod registry {
    use super::{command_value, user_choice_hash, TEXT_EXTENSIONS, VERB};
    use std::collections::BTreeMap;

    /// 上次写进注册表的用户扩展名，去掉某条时靠它把对应菜单删掉。
    const EXTRA_RECORD: &str = r"Software\Forge\OpenWith";
    use crate::error::err;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteTreeW, RegDeleteValueW, RegQueryInfoKeyW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_DWORD, REG_SZ,
    };

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = RegCloseKey(self.0);
                }
            }
        }
    }

    /// 打开方式对话框和「默认应用」设置页里显示的程序名。
    const PROGID: &str = "Forge.Text";
    const APP_NAME: &str = "Forge";
    const CAPABILITIES: &str = r"Software\Forge\Capabilities";
    const REGISTERED: &str = r"Software\RegisteredApplications";
    const TOASTS: &str = r"Software\Microsoft\Windows\CurrentVersion\ApplicationAssociationToasts";

    pub fn sync(
        open_folder: bool,
        open_file: bool,
        default_file: bool,
        exe: &str,
        label: &str,
        extras: &[String],
    ) -> Result<(), String> {
        for key in folder_keys() {
            if open_folder {
                let placeholder = if key.contains("Background") { "%V" } else { "%1" };
                write_verb(&key, label, exe, &command_value(exe, placeholder))?;
            } else {
                delete_tree(&key)?;
            }
        }
        let previous = read_recorded_extras();
        let wanted: &[String] = if open_file { extras } else { &[] };
        for ext in &previous {
            if !wanted.iter().any(|item| item == ext) {
                delete_tree(&file_verb(ext))?;
            }
        }
        for ext in TEXT_EXTENSIONS {
            let key = file_verb(ext);
            if open_file {
                write_verb(&key, label, exe, &command_value(exe, "%1"))?;
            } else {
                delete_tree(&key)?;
            }
        }
        if open_file {
            for ext in extras {
                write_verb(&file_verb(ext), label, exe, &command_value(exe, "%1"))?;
            }
        }

        // 右键动词和「打开方式」可以分开：只想改双击默认时，也要把 Forge 登记成可选程序。
        let listed = open_file || default_file;
        let exe_name = std::path::Path::new(exe)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("forge.exe");
        let exts = managed_extensions(if listed { extras } else { &[] });
        if listed {
            write_progid(exe)?;
            write_application(exe, exe_name, &exts)?;
            write_capabilities(exe, &exts)?;
            for ext in &exts {
                add_open_with(ext, exe_name)?;
            }
            for ext in &previous {
                if !extras.iter().any(|item| item == ext) {
                    remove_open_with(ext, exe_name)?;
                }
            }
            write_recorded(extras)?;
        } else {
            for ext in TEXT_EXTENSIONS {
                remove_open_with(ext, exe_name)?;
            }
            for ext in &previous {
                remove_open_with(ext, exe_name)?;
            }
            remove_registration(exe_name)?;
        }

        if default_file {
            let sid = current_sid()?;
            claim_defaults(&exts, &sid)?;
        } else {
            release_defaults()?;
        }
        if !listed && !default_file {
            delete_tree(EXTRA_RECORD)?;
        }
        notify_associations();
        Ok(())
    }

    fn managed_extensions(extras: &[String]) -> Vec<String> {
        let mut out: Vec<String> = TEXT_EXTENSIONS.iter().map(|ext| (*ext).to_string()).collect();
        out.extend(extras.iter().cloned());
        out
    }

    fn write_progid(exe: &str) -> Result<(), String> {
        let root = format!(r"Software\Classes\{PROGID}");
        let key = create_key(&root)?;
        set_default(&key, APP_NAME)?;
        let icon = create_key(&format!(r"{root}\DefaultIcon"))?;
        set_default(&icon, &format!("\"{exe}\",0"))?;
        let command = create_key(&format!(r"{root}\shell\open\command"))?;
        set_default(&command, &command_value(exe, "%1"))?;
        Ok(())
    }

    fn write_application(exe: &str, exe_name: &str, exts: &[String]) -> Result<(), String> {
        let root = format!(r"Software\Classes\Applications\{exe_name}");
        let app = create_key(&root)?;
        set_named(&app, "FriendlyAppName", APP_NAME)?;
        let command = create_key(&format!(r"{root}\shell\open\command"))?;
        set_default(&command, &command_value(exe, "%1"))?;
        delete_tree(&format!(r"{root}\SupportedTypes"))?;
        let types = create_key(&format!(r"{root}\SupportedTypes"))?;
        for ext in exts {
            set_named(&types, &format!(".{ext}"), "")?;
        }
        Ok(())
    }

    fn write_capabilities(exe: &str, exts: &[String]) -> Result<(), String> {
        let cap = create_key(CAPABILITIES)?;
        set_named(&cap, "ApplicationName", APP_NAME)?;
        set_named(&cap, "ApplicationDescription", APP_NAME)?;
        set_named(&cap, "ApplicationIcon", &format!("\"{exe}\",0"))?;
        delete_tree(&format!(r"{CAPABILITIES}\FileAssociations"))?;
        let files = create_key(&format!(r"{CAPABILITIES}\FileAssociations"))?;
        for ext in exts {
            set_named(&files, &format!(".{ext}"), PROGID)?;
        }
        let registered = create_key(REGISTERED)?;
        set_named(&registered, APP_NAME, CAPABILITIES)?;
        Ok(())
    }

    fn remove_registration(exe_name: &str) -> Result<(), String> {
        delete_tree(&format!(r"Software\Classes\{PROGID}"))?;
        delete_tree(&format!(r"Software\Classes\Applications\{exe_name}"))?;
        delete_tree(CAPABILITIES)?;
        delete_value(REGISTERED, APP_NAME)?;
        Ok(())
    }

    fn add_open_with(ext: &str, exe_name: &str) -> Result<(), String> {
        for path in open_with_keys(ext) {
            let key = create_key(&path)?;
            set_named(&key, PROGID, "")?;
        }
        add_mru(ext, exe_name)
    }

    fn remove_open_with(ext: &str, exe_name: &str) -> Result<(), String> {
        for path in open_with_keys(ext) {
            delete_value(&path, PROGID)?;
        }
        remove_mru(ext, exe_name)
    }

    fn open_with_keys(ext: &str) -> [String; 2] {
        [
            format!(r"Software\Classes\.{ext}\OpenWithProgids"),
            format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\OpenWithProgids"),
        ]
    }

    fn add_mru(ext: &str, exe_name: &str) -> Result<(), String> {
        let path = mru_key(ext);
        let key = create_key(&path)?;
        let mut used = Vec::new();
        for letter in 'a'..='z' {
            let name = letter.to_string();
            if let Some(value) = read_named(&key, &name) {
                if value.eq_ignore_ascii_case(exe_name) {
                    return Ok(());
                }
                used.push(letter);
            }
        }
        let Some(letter) = ('a'..='z').find(|item| !used.contains(item)) else {
            return Ok(());
        };
        set_named(&key, &letter.to_string(), exe_name)?;
        let mut mru = read_named(&key, "MRUList").unwrap_or_default();
        if !mru.contains(letter) {
            mru.push(letter);
            set_named(&key, "MRUList", &mru)?;
        }
        Ok(())
    }

    fn remove_mru(ext: &str, exe_name: &str) -> Result<(), String> {
        let path = mru_key(ext);
        let Ok(key) = open_key(&path) else {
            return Ok(());
        };
        let mut drop_letter = None;
        for letter in 'a'..='z' {
            if read_named(&key, &letter.to_string())
                .is_some_and(|value| value.eq_ignore_ascii_case(exe_name))
            {
                drop_letter = Some(letter);
                break;
            }
        }
        let Some(letter) = drop_letter else {
            return Ok(());
        };
        delete_value(&path, &letter.to_string())?;
        if let Some(mru) = read_named(&key, "MRUList") {
            let next: String = mru.chars().filter(|item| *item != letter).collect();
            if next.is_empty() {
                delete_value(&path, "MRUList")?;
            } else {
                set_named(&key, "MRUList", &next)?;
            }
        }
        Ok(())
    }

    fn mru_key(ext: &str) -> String {
        format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\OpenWithList")
    }

    fn claim_defaults(exts: &[String], sid: &str) -> Result<(), String> {
        let mut saved = read_prev();
        let mut still = BTreeMap::new();
        for ext in exts {
            let current = read_user_choice(ext);
            let previous = saved.remove(ext);
            let remembered = previous.clone().or_else(|| {
                if current.as_deref() == Some(PROGID) {
                    None
                } else {
                    Some(current.unwrap_or_default())
                }
            });
            match write_user_choice(ext, PROGID, sid) {
                Ok(()) => {
                    if let Some(prev) = remembered {
                        still.insert(ext.clone(), prev);
                    }
                    write_toast(ext)?;
                }
                // 系统保护的后缀（例如 html）拒绝写入时保持原样，不要记成已经接管。
                Err(error) if access_denied(&error) => {
                    if let Some(prev) = previous {
                        still.insert(ext.clone(), prev);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        for (ext, prev) in saved {
            restore_one(&ext, &prev, sid)?;
        }
        write_prev(&still)
    }

    fn release_defaults() -> Result<(), String> {
        let saved = read_prev();
        if saved.is_empty() {
            return Ok(());
        }
        let sid = current_sid()?;
        for (ext, prev) in &saved {
            restore_one(ext, prev, &sid)?;
        }
        write_prev(&BTreeMap::new())
    }

    fn restore_one(ext: &str, prev: &str, sid: &str) -> Result<(), String> {
        if read_user_choice(ext).as_deref() != Some(PROGID) {
            delete_toast(ext)?;
            return Ok(());
        }
        if prev.is_empty() {
            delete_tree(&user_choice_key(ext))?;
        } else {
            write_user_choice(ext, prev, sid)?;
        }
        delete_toast(ext)
    }

    fn write_user_choice(ext: &str, prog_id: &str, sid: &str) -> Result<(), String> {
        let path = user_choice_key(ext);
        for _ in 0..3 {
            wait_for_minute();
            let stamp = hash_stamp()?;
            delete_tree(&path)?;
            let key = create_key(&path)?;
            set_named(&key, "ProgId", prog_id)?;
            let hash = user_choice_hash(&format!(".{ext}"), sid, prog_id, stamp.0, stamp.1);
            set_named(&key, "Hash", &hash)?;
            if key_stamp(&key) == Some(stamp) {
                return Ok(());
            }
        }
        Err(err("SHELL_REG", "hash"))
    }

    fn user_choice_key(ext: &str) -> String {
        format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice")
    }

    fn read_user_choice(ext: &str) -> Option<String> {
        let key = query_key(&user_choice_key(ext)).ok()?;
        read_named(&key, "ProgId")
    }

    fn write_toast(ext: &str) -> Result<(), String> {
        let key = create_key(TOASTS)?;
        set_dword(&key, &format!("{PROGID}_.{ext}"), 0)
    }

    fn delete_toast(ext: &str) -> Result<(), String> {
        delete_value(TOASTS, &format!("{PROGID}_.{ext}"))
    }

    fn read_prev() -> BTreeMap<String, String> {
        let Ok(key) = query_key(EXTRA_RECORD) else {
            return BTreeMap::new();
        };
        let Some(text) = read_named(&key, "prev") else {
            return BTreeMap::new();
        };
        let mut out = BTreeMap::new();
        for line in text.split('\n') {
            let Some((ext, prog)) = line.split_once('=') else {
                continue;
            };
            if !ext.is_empty() {
                out.insert(ext.to_string(), prog.to_string());
            }
        }
        out
    }

    fn write_prev(saved: &BTreeMap<String, String>) -> Result<(), String> {
        if saved.is_empty() {
            return delete_value(EXTRA_RECORD, "prev");
        }
        let mut text = String::new();
        for (ext, prog) in saved {
            text.push_str(ext);
            text.push('=');
            text.push_str(prog);
            text.push('\n');
        }
        let key = create_key(EXTRA_RECORD)?;
        set_named(&key, "prev", &text)
    }

    fn wait_for_minute() {
        let now = unsafe { windows::Win32::System::SystemInformation::GetSystemTime() };
        if now.wSecond >= 58 {
            let remain = (60 - u64::from(now.wSecond)) * 1000 + 50;
            std::thread::sleep(std::time::Duration::from_millis(remain));
        }
    }

    fn hash_stamp() -> Result<(u32, u32), String> {
        let mut now = unsafe { windows::Win32::System::SystemInformation::GetSystemTime() };
        now.wSecond = 0;
        now.wMilliseconds = 0;
        filetime_of(now)
    }

    fn key_stamp(key: &Key) -> Option<(u32, u32)> {
        let mut written = windows::Win32::Foundation::FILETIME::default();
        let status = unsafe {
            RegQueryInfoKeyW(
                key.0,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(&mut written),
            )
        };
        if status.0 != 0 {
            return None;
        }
        let mut clock = windows::Win32::Foundation::SYSTEMTIME::default();
        unsafe { windows::Win32::System::Time::FileTimeToSystemTime(&written, &mut clock) }.ok()?;
        clock.wSecond = 0;
        clock.wMilliseconds = 0;
        filetime_of(clock).ok()
    }

    fn filetime_of(clock: windows::Win32::Foundation::SYSTEMTIME) -> Result<(u32, u32), String> {
        let mut ft = windows::Win32::Foundation::FILETIME::default();
        unsafe { windows::Win32::System::Time::SystemTimeToFileTime(&clock, &mut ft) }
            .map_err(|error| err("SHELL_REG", error))?;
        Ok((ft.dwHighDateTime, ft.dwLowDateTime))
    }

    fn current_sid() -> Result<String, String> {
        use windows::Win32::Foundation::{CloseHandle, HLOCAL, LocalFree};
        use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
        use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_USER};
        use windows::Win32::Security::TOKEN_QUERY;
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        use windows::core::PWSTR;

        unsafe {
            let mut token = windows::Win32::Foundation::HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(|error| err("SHELL_REG", error))?;
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            let mut words = vec![0u64; (needed as usize).div_ceil(8).max(1)];
            GetTokenInformation(
                token,
                TokenUser,
                Some(words.as_mut_ptr() as *mut _),
                (words.len() * 8) as u32,
                &mut needed,
            )
            .map_err(|error| err("SHELL_REG", error))?;
            let user = &*(words.as_ptr() as *const TOKEN_USER);
            let mut text = PWSTR::null();
            let converted = ConvertSidToStringSidW(user.User.Sid, &mut text);
            let _ = CloseHandle(token);
            converted.map_err(|error| err("SHELL_REG", error))?;
            let sid = text.to_string().unwrap_or_default();
            if !text.is_null() {
                let _ = LocalFree(Some(HLOCAL(text.as_ptr() as *mut _)));
            }
            if sid.is_empty() {
                return Err(err("SHELL_REG", "sid"));
            }
            Ok(sid)
        }
    }

    fn access_denied(error: &str) -> bool {
        error.rsplit(crate::error::SEP).next() == Some("5")
    }

    fn notify_associations() {
        use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    fn file_verb(ext: &str) -> String {
        format!(r"Software\Classes\SystemFileAssociations\.{ext}\shell\{VERB}")
    }

    fn read_recorded_extras() -> Vec<String> {
        let Ok(key) = create_key(EXTRA_RECORD) else {
            return Vec::new();
        };
        let Some(text) = read_named(&key, "extras") else {
            return Vec::new();
        };
        text.split(';')
            .filter(|item| !item.is_empty())
            .map(|item| item.to_string())
            .collect()
    }

    fn write_recorded(extras: &[String]) -> Result<(), String> {
        let key = create_key(EXTRA_RECORD)?;
        set_named(&key, "extras", &extras.join(";"))
    }

    fn read_named(key: &Key, name: &str) -> Option<String> {
        let wide_name = HSTRING::from(name);
        let mut size = 0u32;
        let status = unsafe {
            RegQueryValueExW(key.0, &wide_name, None, None, None, Some(&mut size))
        };
        if status.0 != 0 || size < 2 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let mut got = size;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                &wide_name,
                None,
                None,
                Some(buf.as_mut_ptr()),
                Some(&mut got),
            )
        };
        if status.0 != 0 {
            return None;
        }
        let units: Vec<u16> = buf
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        String::from_utf16(&units).ok()
    }

    fn folder_keys() -> [&'static str; 2] {
        [
            const_format_dir(),
            const_format_background(),
        ]
    }

    fn const_format_dir() -> &'static str {
        r"Software\Classes\Directory\shell\ForgeOpen"
    }

    fn const_format_background() -> &'static str {
        r"Software\Classes\Directory\Background\shell\ForgeOpen"
    }

    fn write_verb(key: &str, label: &str, icon: &str, command: &str) -> Result<(), String> {
        let parent = create_key(key)?;
        set_default(&parent, label)?;
        set_named(&parent, "Icon", icon)?;
        let child = create_key(&format!(r"{key}\command"))?;
        set_default(&child, command)?;
        Ok(())
    }

    fn create_key(subkey: &str) -> Result<Key, String> {
        let name = HSTRING::from(subkey);
        let mut key = HKEY::default();
        let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, &name, &mut key) };
        check(status)?;
        Ok(Key(key))
    }

    fn open_key(subkey: &str) -> Result<Key, String> {
        use windows::Win32::System::Registry::{RegOpenKeyExW, KEY_QUERY_VALUE, KEY_SET_VALUE};
        let name = HSTRING::from(subkey);
        let mut key = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                &name,
                None,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                &mut key,
            )
        };
        check(status)?;
        Ok(Key(key))
    }

    /// 已有的 UserChoice 常常拒绝写入，但还是可以读出原来的 ProgId。
    fn query_key(subkey: &str) -> Result<Key, String> {
        use windows::Win32::System::Registry::{RegOpenKeyExW, KEY_QUERY_VALUE};
        let name = HSTRING::from(subkey);
        let mut key = HKEY::default();
        let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &name, None, KEY_QUERY_VALUE, &mut key) };
        check(status)?;
        Ok(Key(key))
    }

    fn set_default(key: &Key, value: &str) -> Result<(), String> {
        let data = utf16_z(value);
        let status = unsafe { RegSetValueExW(key.0, PCWSTR::null(), None, REG_SZ, Some(data.as_slice())) };
        check(status)
    }

    fn set_named(key: &Key, name: &str, value: &str) -> Result<(), String> {
        let wide_name = HSTRING::from(name);
        let data = utf16_z(value);
        let status =
            unsafe { RegSetValueExW(key.0, &wide_name, None, REG_SZ, Some(data.as_slice())) };
        check(status)
    }

    fn set_dword(key: &Key, name: &str, value: u32) -> Result<(), String> {
        let wide_name = HSTRING::from(name);
        let data = value.to_le_bytes();
        let status = unsafe { RegSetValueExW(key.0, &wide_name, None, REG_DWORD, Some(&data)) };
        check(status)
    }

    fn delete_value(subkey: &str, name: &str) -> Result<(), String> {
        let Ok(key) = open_key(subkey) else {
            return Ok(());
        };
        let wide_name = HSTRING::from(name);
        let status = unsafe { RegDeleteValueW(key.0, &wide_name) };
        if status.0 == 0 || status.0 == 2 {
            Ok(())
        } else {
            Err(err("SHELL_REG", status.0.to_string()))
        }
    }

    fn delete_tree(subkey: &str) -> Result<(), String> {
        let name = HSTRING::from(subkey);
        let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &name) };
        // 2 = 找不到键，3 = 找不到路径。本来就没有，删掉这一步算成功。
        if status.0 == 0 || status.0 == 2 || status.0 == 3 {
            Ok(())
        } else {
            Err(err("SHELL_REG", status.0.to_string()))
        }
    }

    fn check(status: WIN32_ERROR) -> Result<(), String> {
        if status.0 == 0 {
            Ok(())
        } else {
            Err(err("SHELL_REG", status.0.to_string()))
        }
    }

    fn utf16_z(value: &str) -> Vec<u8> {
        let mut units: Vec<u16> = value.encode_utf16().collect();
        units.push(0);
        units.iter().flat_map(|unit| unit.to_le_bytes()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;

    #[test]
    fn text_extensions_are_unique_lowercase_and_reject_binaries() {
        let mut seen = BTreeSet::new();
        for ext in TEXT_EXTENSIONS {
            assert!(seen.insert(*ext), "扩展名重复：{ext}");
            assert_eq!(*ext, ext.to_ascii_lowercase(), "扩展名要小写：{ext}");
            assert!(!ext.starts_with('.'), "扩展名不要带点：{ext}");
        }
        for banned in ["png", "jpg", "jpeg", "gif", "webp", "exe", "dll", "zip", "pdf", "docx", "svgz", "mp4", "wasm"] {
            assert!(!is_text_extension(banned), "{banned} 不该在白名单里");
        }
        assert!(is_text_extension("TXT"));
        assert!(is_text_extension("rs"));
        assert!(is_text_extension("svg"));
    }

    #[test]
    fn plan_keeps_folders_and_whitelisted_files_only() {
        let dir = std::env::temp_dir().join(format!("forge-shell-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("proj")).unwrap();
        fs::write(dir.join("note.txt"), b"hi").unwrap();
        fs::write(dir.join("pic.png"), b"no").unwrap();

        let plan = plan_shell_args(
            &[
                dir.join("proj").display().to_string(),
                dir.join("note.txt").display().to_string(),
                dir.join("pic.png").display().to_string(),
                "--flag".to_string(),
                dir.join("missing.txt").display().to_string(),
            ],
            &[],
        );
        assert_eq!(plan.folders, vec![dir.join("proj").display().to_string()]);
        assert_eq!(plan.files, vec![dir.join("note.txt").display().to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extra_extensions_drop_builtin_and_duplicates() {
        let extras = normalize_extra_extensions(&[
            "TXT".into(),
            ".prisma".into(),
            "prisma".into(),
            "*.PRISMA".into(),
            "bad/ext".into(),
            "  http  ".into(),
        ]);
        assert_eq!(extras, vec!["prisma".to_string(), "http".to_string()]);
    }

    #[test]
    fn plan_accepts_user_extensions_only_once_normalized() {
        let dir = std::env::temp_dir().join(format!("forge-shell-extra-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("schema.prisma"), b"model").unwrap();
        fs::write(dir.join("pic.png"), b"no").unwrap();

        let plan = plan_shell_args(
            &[
                dir.join("schema.prisma").display().to_string(),
                dir.join("pic.png").display().to_string(),
            ],
            &[".prisma".into(), "png".into()],
        );
        assert_eq!(plan.files, vec![dir.join("schema.prisma").display().to_string(), dir.join("pic.png").display().to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_choice_hash_matches_known_vector() {
        let hash = user_choice_hash(
            ".3g2",
            "S-1-5-21-819709642-920330688-1657285119-500",
            "WMP11.AssocFile.3G2",
            0x01d4d982,
            0x67246000,
        );
        assert_eq!(hash, "PCCqEmkvW2Y=");
    }

    #[test]
    fn command_quotes_exe_and_placeholder() {
        assert_eq!(
            command_value(r"C:\Program Files\Forge\forge.exe", "%1"),
            r#""C:\Program Files\Forge\forge.exe" "%1""#
        );
    }
}
