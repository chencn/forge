//! Windows 11 新右键菜单里的「通过 Forge 打开」。
//!
//! Explorer 通过稀疏包加载本 DLL，调用 `IExplorerCommand`。
//! 经典菜单仍由主程序写的 `shell\ForgeOpen` 动词负责。

#![cfg(windows)]
#![allow(non_snake_case)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use windows::core::*;
use windows::Win32::Foundation::{
    CloseHandle, CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOTIMPL, S_FALSE,
    S_OK,
};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl, CoTaskMemFree};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
};
use windows::Win32::System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW};
use windows::Win32::System::SystemServices::SFGAO_FOLDER;
use windows::Win32::UI::Shell::{
    IExplorerCommand, IExplorerCommand_Impl, IShellItem, IShellItemArray, SHStrDupW, ECF_DEFAULT,
    ECS_ENABLED, ECS_HIDDEN, SIGDN_FILESYSPATH,
};

/// 菜单标题与两个开关由主程序写在这里，DLL 只读。
/// 和主程序记录「上一轮写过的后缀 / 原来的默认程序」的键分开，免得互相覆盖。
const MENU_KEY: &str = r"Software\Forge\ShellMenu";

/// 文件、文件夹、空白处都挂在这一个 CLSID 上，和已经装上的稀疏包一致。
pub const CLSID_FORGE_FILE: GUID = GUID::from_u128(0xB8E4_F1A2_9C3D_4E5F_A1B2_C3D4_E5F6_0718);
/// 旧清单曾经把文件夹指到这里。再显示一次就会和 0718 叠成两条，所以一律隐藏。
pub const CLSID_FORGE_FOLDER: GUID = GUID::from_u128(0xB8E4_F1A2_9C3D_4E5F_A1B2_C3D4_E5F6_0719);

const KIND_FILE: u8 = 0;
const KIND_FOLDER: u8 = 1;

/// 活着的 COM 对象数。`DllCanUnloadNow` 靠它判断能不能卸。
static OBJECTS: AtomicU32 = AtomicU32::new(0);
/// 本模块句柄。`DllMain` 里写，`GetModuleFileNameW` 里读；用原子量避免 `static mut`。
static MODULE: AtomicIsize = AtomicIsize::new(0);

#[no_mangle]
pub extern "system" fn DllMain(
    module: windows::Win32::Foundation::HMODULE,
    reason: u32,
    _reserved: *mut core::ffi::c_void,
) -> BOOL {
    // 1 = DLL_PROCESS_ATTACH
    if reason == 1 {
        MODULE.store(module.0 as isize, Ordering::SeqCst);
    }
    BOOL(1)
}

/// COM 卸载协商。
///
/// # Safety
/// 由 COM 运行时按导出表调用，无参数。
#[no_mangle]
pub unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECTS.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

/// COM 类工厂入口。
///
/// # Safety
/// 三个参数都由 COM 运行时给出：`rclsid`/`riid` 必须是有效 GUID 指针，
/// `ppv` 必须是可写的接口指针槽。本函数不接管它们的生命周期。
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut core::ffi::c_void,
) -> HRESULT {
    if ppv.is_null() {
        return E_INVALIDARG;
    }
    *ppv = std::ptr::null_mut();
    if rclsid.is_null() {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let kind = if *rclsid == CLSID_FORGE_FILE {
        KIND_FILE
    } else if *rclsid == CLSID_FORGE_FOLDER {
        KIND_FOLDER
    } else {
        return CLASS_E_CLASSNOTAVAILABLE;
    };
    let factory: IClassFactory = ForgeClassFactory { kind }.into();
    factory.query(riid, ppv)
}

#[implement(IClassFactory)]
struct ForgeClassFactory {
    kind: u8,
}

impl IClassFactory_Impl for ForgeClassFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Ref<'_, IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        if !punkouter.is_null() {
            return Err(Error::from_hresult(CLASS_E_NOAGGREGATION));
        }
        unsafe {
            if ppvobject.is_null() {
                return Err(Error::from_hresult(E_INVALIDARG));
            }
            *ppvobject = std::ptr::null_mut();
            let command: IExplorerCommand = ForgeOpenCommand { kind: self.kind }.into();
            let result = command.query(riid, ppvobject);
            if result.is_ok() {
                // 交出去的对象活多久，DLL 就不能卸。命令对象 Drop 时减回来。
                OBJECTS.fetch_add(1, Ordering::SeqCst);
            }
            result.ok()
        }
    }

    fn LockServer(&self, flock: BOOL) -> Result<()> {
        if flock.as_bool() {
            OBJECTS.fetch_add(1, Ordering::SeqCst);
        } else {
            release_object();
        }
        Ok(())
    }
}

#[implement(IExplorerCommand)]
struct ForgeOpenCommand {
    kind: u8,
}

impl Drop for ForgeOpenCommand {
    fn drop(&mut self) {
        release_object();
    }
}

/// 活对象数减一。配不上对的 `UnlockServer` 不能把计数减成天文数字，
/// 那样 `DllCanUnloadNow` 永远返回 `S_FALSE`，DLL 再也卸不掉。
fn release_object() {
    let _ = OBJECTS.try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
        Some(held.saturating_sub(1))
    });
}

impl IExplorerCommand_Impl for ForgeOpenCommand_Impl {
    fn GetTitle(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        dup_str(&menu_title())
    }

    fn GetIcon(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        let exe = forge_exe();
        dup_str(&exe.to_string_lossy())
    }

    fn GetToolTip(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        Err(Error::from_hresult(E_NOTIMPL))
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(if self.kind == KIND_FOLDER {
            CLSID_FORGE_FOLDER
        } else {
            CLSID_FORGE_FILE
        })
    }

    fn GetState(&self, items: Ref<'_, IShellItemArray>, _ok_to_be_slow: BOOL) -> Result<u32> {
        let picked = selections(items);
        Ok(if command_matches(self.kind, &picked) {
            ECS_ENABLED.0 as u32
        } else {
            ECS_HIDDEN.0 as u32
        })
    }

    fn Invoke(
        &self,
        items: Ref<'_, IShellItemArray>,
        _bind: Ref<'_, windows::Win32::System::Com::IBindCtx>,
    ) -> Result<()> {
        let exe = forge_exe();
        if !exe.is_file() {
            return Ok(());
        }
        let picked = selections(items);
        let args: Vec<PathBuf> = picked
            .items
            .iter()
            .filter(|item| command_matches(self.kind, &Picked {
                items: vec![Selection {
                    path: item.path.clone(),
                    folder: item.folder,
                }],
                count: 1,
            }))
            .map(|item| item.path.clone())
            .collect();
        if args.is_empty() {
            return Ok(());
        }
        launch(&exe, &args);
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<windows::Win32::UI::Shell::IEnumExplorerCommand> {
        Err(Error::from_hresult(E_NOTIMPL))
    }
}

fn dup_str(text: &str) -> Result<PWSTR> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SHStrDupW(PCWSTR(wide.as_ptr())) }
}

fn menu_title() -> String {
    if let Some(text) = read_reg_sz(MENU_KEY, "menuLabel") {
        if !text.trim().is_empty() {
            return text;
        }
    }
    let lang = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    let primary = lang & 0xFF;
    if primary == 0x04 {
        "通过 Forge 打开".to_string()
    } else {
        "Open with Forge".to_string()
    }
}

fn forge_exe() -> PathBuf {
    let handle = windows::Win32::Foundation::HMODULE(MODULE.load(Ordering::SeqCst) as *mut _);
    let mut buf = [0u16; 520];
    let len = unsafe { GetModuleFileNameW(Some(handle), &mut buf) } as usize;
    let dll = PathBuf::from(String::from_utf16_lossy(&buf[..len.min(buf.len())]));
    let same_dir = dll.with_file_name("forge.exe");
    if same_dir.is_file() {
        return same_dir;
    }
    // 安装包里 DLL 可能在 resources/ 或 resources/windows/shell/，往上找 forge.exe。
    let mut cursor = dll.parent().map(Path::to_path_buf);
    for _ in 0..4 {
        let Some(dir) = cursor else {
            break;
        };
        let candidate = dir.join("forge.exe");
        if candidate.is_file() {
            return candidate;
        }
        cursor = dir.parent().map(Path::to_path_buf);
    }
    same_dir
}

fn item_path(item: &IShellItem) -> Result<PathBuf> {
    let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }?;
    let text = unsafe { name.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(name.0 as _)) };
    Ok(PathBuf::from(text))
}

struct Selection {
    path: PathBuf,
    folder: bool,
}

/// 一次右键选中的东西。`count` 是 `IShellItemArray` 报的总数，
/// 和 `items` 的长度不一定相等：回收站、此电脑这类虚拟项取不到文件系统路径。
struct Picked {
    items: Vec<Selection>,
    count: u32,
}

fn selections(items: Ref<'_, IShellItemArray>) -> Picked {
    let Some(items) = items.as_ref() else {
        return Picked {
            items: Vec::new(),
            count: 0,
        };
    };
    let count = unsafe { items.GetCount() }.unwrap_or(0);
    let mut picked = Vec::new();
    for index in 0..count {
        let Ok(item) = (unsafe { items.GetItemAt(index) }) else {
            continue;
        };
        let Ok(path) = item_path(&item) else {
            continue;
        };
        // 别用 path.is_dir()：那是磁盘 IO，跑在 Explorer 的 UI 线程上，
        // UNC 慢路径会把右键菜单卡住。属性位本来就在内存里。
        let folder = unsafe { item.GetAttributes(SFGAO_FOLDER) }
            .map(|attr| attr.contains(SFGAO_FOLDER))
            .unwrap_or(false);
        picked.push(Selection { folder, path });
    }
    Picked {
        items: picked,
        count,
    }
}

/// 0718 按路径决定显示：文件夹看 openFolder，文件再看后缀白名单。
/// 0719 不再登记；旧包如果还指着它，藏掉，避免和 0718 各出一条。
fn command_matches(kind: u8, picked: &Picked) -> bool {
    if kind == KIND_FOLDER {
        return false;
    }
    let open_folder = flag_on("openFolder", true);
    let open_file = flag_on("openFile", true);
    // 空白处：没有选中项。文件夹背景菜单靠这一条出现。
    if picked.count == 0 {
        return open_folder;
    }
    // 选了东西但一条路径都拿不到（回收站、网络位置、搜索结果里的虚拟项）：
    // 显示出来点了也没反应，直接藏掉。
    if picked.items.is_empty() {
        return false;
    }
    picked.items.iter().all(|item| {
        if item.folder {
            open_folder
        } else {
            open_file && file_allowed(&item.path)
        }
    })
}

fn file_allowed(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    if forge_shell_ext::is_text_extension(ext) {
        return true;
    }
    read_reg_sz(MENU_KEY, "extras")
        .unwrap_or_default()
        .split(';')
        .any(|item| item.eq_ignore_ascii_case(ext))
}

fn flag_on(name: &str, default: bool) -> bool {
    match read_reg_sz(MENU_KEY, name).unwrap_or_default().trim() {
        "" => default,
        "0" | "false" | "False" | "FALSE" => false,
        _ => true,
    }
}

fn launch(exe: &Path, paths: &[PathBuf]) {
    let mut args: Vec<String> = Vec::with_capacity(paths.len() + 1);
    args.push(exe.display().to_string());
    args.extend(paths.iter().map(|path| path.display().to_string()));
    let mut cmd_wide = command_line(&args);
    let si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut pi = PROCESS_INFORMATION::default();
    let ok = unsafe {
        CreateProcessW(
            None,
            Some(PWSTR(cmd_wide.as_mut_ptr())),
            None,
            None,
            false,
            Default::default(),
            None,
            None,
            &si,
            &mut pi,
        )
    };
    if ok.is_ok() {
        unsafe {
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
        }
    }
}

/// 按 `CommandLineToArgvW` 的反解析规则拼命令行，结尾是 NUL。
///
/// 只用 `"{arg}"` 包一层是不够的：`C:\` 这种以反斜杠结尾的路径会拼成 `"C:\"`，
/// 引号被当成转义，参数变成 `C:"`。反斜杠要按引号前规则翻倍。
fn command_line(args: &[String]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if index > 0 {
            out.push(' ' as u16);
        }
        // 含引号的参数即使没有空格也必须包起来：裸写时引号会被当成语法。
        // 以反斜杠结尾的参数同样要包：裸写时 `C:\` 后面跟一个空格，接收方拿到的是
        // `C:\`（这个没问题），但和下一段拼起来就分不清边界，包起来最稳。
        let needs_quote = arg.is_empty()
            || arg.ends_with('\\')
            || arg
                .chars()
                .any(|ch| ch == ' ' || ch == '\t' || ch == '"');
        if !needs_quote {
            out.extend(arg.encode_utf16());
            continue;
        }
        out.push('"' as u16);
        let mut pending = 0usize;
        for ch in arg.chars() {
            match ch {
                '\\' => pending += 1,
                '"' => {
                    // 引号前的反斜杠翻倍，再补一个转义引号。
                    for _ in 0..(pending * 2 + 1) {
                        out.push('\\' as u16);
                    }
                    out.push('"' as u16);
                    pending = 0;
                }
                _ => {
                    for _ in 0..pending {
                        out.push('\\' as u16);
                    }
                    pending = 0;
                    let mut buf = [0u16; 2];
                    out.extend(ch.encode_utf16(&mut buf).iter().copied());
                }
            }
        }
        // 收尾的引号同样要求前面的反斜杠翻倍。
        for _ in 0..(pending * 2) {
            out.push('\\' as u16);
        }
        out.push('"' as u16);
    }
    out.push(0);
    out
}

fn read_reg_sz(subkey: &str, name: &str) -> Option<String> {
    unsafe {
        let sub = HSTRING::from(subkey);
        let mut key = windows::Win32::System::Registry::HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, &sub, None, KEY_QUERY_VALUE, &mut key).0 != 0 {
            return None;
        }
        let wide_name = HSTRING::from(name);
        let mut size = 0u32;
        let status = RegQueryValueExW(key, &wide_name, None, None, None, Some(&mut size));
        if status.0 != 0 || size < 2 {
            let _ = RegCloseKey(key);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let mut got = size;
        let status = RegQueryValueExW(
            key,
            &wide_name,
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut got),
        );
        let _ = RegCloseKey(key);
        if status.0 != 0 {
            return None;
        }
        // MSRV 是 1.80；clippy 建议的 `as_chunks` 要 1.88，这里明确保留 chunks_exact。
        #[allow(clippy::chunks_exact_to_as_chunks)]
        let units: Vec<u16> = buf
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        String::from_utf16(&units).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼出来的宽字符转回可读文本，方便断言。
    fn line(args: &[&str]) -> String {
        let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        let wide = command_line(&owned);
        // 去掉结尾的 NUL 再转。
        String::from_utf16_lossy(&wide[..wide.len() - 1])
    }

    #[test]
    fn plain_arguments_are_not_quoted() {
        assert_eq!(line(&["forge.exe", "%1"]), "forge.exe %1");
    }

    #[test]
    fn spaces_get_quoted() {
        assert_eq!(
            line(&[r"C:\Program Files\Forge\forge.exe", r"D:\my notes\a.txt"]),
            r#""C:\Program Files\Forge\forge.exe" "D:\my notes\a.txt""#
        );
    }

    /// 盘符根目录以反斜杠结尾：只用一层引号会拼成 `"C:\"`，引号被当成转义。
    #[test]
    fn trailing_backslash_is_doubled_before_closing_quote() {
        assert_eq!(line(&[r"C:\"]), r#""C:\\""#);
        assert_eq!(line(&[r"C:\some dir\"]), r#""C:\some dir\\""#);
    }

    #[test]
    fn embedded_quote_is_escaped() {
        assert_eq!(line(&[r#"a"b"#]), r#""a\"b""#);
    }

    #[test]
    fn empty_argument_keeps_its_quotes() {
        assert_eq!(line(&["", "x"]), r#""""#.to_string() + " x");
    }

    #[test]
    fn line_is_nul_terminated() {
        let wide = command_line(&["forge.exe".to_string()]);
        assert_eq!(wide.last(), Some(&0));
    }
}
