//! Win11 新右键菜单用的稀疏包（IExplorerCommand + package identity）。
//!
//! 经典 `shell\ForgeOpen` 动词进不了新菜单。这里在开启「通过 Forge 打开」时
//! 签名并注册稀疏包；关掉时卸掉。
//!
//! 签名用一张自签证书。私钥只在 `CurrentUser\My` 里，不导出成文件。
//! Win11 的 AppX 部署服务按**本机**信任链校验，只放进当前用户的
//! `TrustedPeople` 会得到 `0x800B0109`（根证书不受信任），稀疏包装不上，
//! 新菜单就不会出现。公钥必须进 `LocalMachine\Root`；这一步要提权一次。

#![cfg(windows)]

use crate::error::err;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PACKAGE_NAME: &str = "Forge.ShellOpen";
/// 用户在证书说明框里点了取消。不当成注册失败，也不要继续弹 UAC。
const CERT_INSTALL_DECLINED: &str = "CERT_INSTALL_DECLINED";
/// 文件、文件夹、空白处共用这一个命令。再挂第二个 CLSID 时，
/// DLL 无法知道当前是哪一条 Verb，两条会同时变成「通过 Forge 打开」。
const CLSID_FILE: &str = "B8E4F1A2-9C3D-4E5F-A1B2-C3D4E5F60718";
const CERT_SUBJECT: &str = "CN=Forge Shell Open";
/// 菜单标题与开关由主程序写在这里，DLL 只读。和记录「上一轮后缀 / 原默认程序」
/// 的 `Software\Forge\OpenWith` 分开，免得两拨数据互相覆盖。
pub const MENU_KEY: &str = r"Software\Forge\ShellMenu";

/// `sync` 的结果。装不上新菜单不算致命：调用方退回经典动词，把 `warning` 报给用户。
pub struct SyncOutcome {
    /// 新菜单是否已经接管。为真时调用方不要再写经典 `shell\ForgeOpen`。
    pub packaged: bool,
    /// 没接管时的原因。`packaged` 为真时为 `None`。
    pub warning: Option<String>,
}

/// 按开关登记或卸掉稀疏包。
pub fn sync(
    open_folder: bool,
    open_file: bool,
    install_dir: &Path,
    label: &str,
    extras: &[String],
) -> Result<SyncOutcome, String> {
    // 设置页一加载就会调一次。两次叠在一起会同时拉起好几串 PowerShell。
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    write_dll_settings(open_folder, open_file, label, extras)?;
    if !(open_folder || open_file) {
        remove_if_registered()?;
        return Ok(SyncOutcome {
            packaged: false,
            warning: None,
        });
    }
    // 新菜单是 Win11 才有的扩展。Win10 上装了包也不会出现那条命令，
    // 这时必须退回经典动词，否则菜单会整条消失。
    if !is_windows_11() {
        return Ok(SyncOutcome {
            packaged: false,
            warning: None,
        });
    }
    match ensure_package(install_dir) {
        Ok(()) => Ok(SyncOutcome {
            packaged: true,
            warning: None,
        }),
        Err(error) => {
            // 用户在说明框里点了取消：不要接着弹 UAC，也不要把这次选择报成失败。
            if error == CERT_INSTALL_DECLINED {
                return Ok(SyncOutcome {
                    packaged: false,
                    warning: None,
                });
            }
            // 包其实还在（例如只是查版本那步失败）：新菜单照样能出现，
            // 这时再写经典动词会让「显示更多选项」里叠成两条。按已接管处理。
            if matches!(installed_package_version(), Some(Some(_))) {
                return Ok(SyncOutcome {
                    packaged: true,
                    warning: None,
                });
            }
            Ok(SyncOutcome {
                packaged: false,
                warning: Some(error),
            })
        }
    }
}

/// build 号 22000 起算 Windows 11。`GetVersionExW` 会被兼容性垫片骗，
/// 注册表里的 `CurrentBuildNumber` 是系统自己写的，不受影响。
fn is_windows_11() -> bool {
    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    read_machine_sz(KEY, "CurrentBuildNumber")
        .and_then(|text| text.trim().parse::<u32>().ok())
        .is_some_and(|build| build >= 22000)
}

fn read_machine_sz(subkey: &str, name: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE,
    };
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(subkey),
            None,
            KEY_QUERY_VALUE,
            &mut key,
        )
        .0 != 0
        {
            return None;
        }
        let wide_name = HSTRING::from(name);
        let mut size = 0u32;
        let mut text = None;
        if RegQueryValueExW(key, &wide_name, None, None, None, Some(&mut size)).0 == 0 && size >= 2 {
            let mut buf = vec![0u8; size as usize];
            let mut got = size;
            if RegQueryValueExW(
                key,
                &wide_name,
                None,
                None,
                Some(buf.as_mut_ptr()),
                Some(&mut got),
            )
            .0 == 0
            {
                // MSRV 是 1.80，`as_chunks` 要 1.88，这里用 chunks_exact。
                let units: Vec<u16> = buf
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .take_while(|unit| *unit != 0)
                    .collect();
                text = String::from_utf16(&units).ok();
            }
        }
        let _ = RegCloseKey(key);
        text
    }
}

fn write_dll_settings(
    open_folder: bool,
    open_file: bool,
    label: &str,
    extras: &[String],
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, HKEY, HKEY_CURRENT_USER,
    };
    unsafe {
        let mut key = HKEY::default();
        let name = HSTRING::from(MENU_KEY);
        // 1018：这个键刚被删掉、还标着待删除。资源管理器松手之前不能立刻建回来。
        let mut status = windows::Win32::Foundation::WIN32_ERROR(1);
        for attempt in 0u32..8 {
            status = RegCreateKeyW(HKEY_CURRENT_USER, &name, &mut key);
            if status.0 == 0 {
                break;
            }
            if !key.is_invalid() {
                let _ = RegCloseKey(key);
                key = HKEY::default();
            }
            if status.0 != 1018 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20 * u64::from(attempt + 1)));
        }
        if status.0 != 0 {
            return Err(err("SHELL_REG", status.0.to_string()));
        }
        set_sz(key, "menuLabel", label)?;
        set_sz(key, "extras", &extras.join(";"))?;
        set_sz(key, "openFolder", if open_folder { "1" } else { "0" })?;
        set_sz(key, "openFile", if open_file { "1" } else { "0" })?;
        let _ = RegCloseKey(key);
    }
    Ok(())
}

unsafe fn set_sz(
    key: windows::Win32::System::Registry::HKEY,
    name: &str,
    value: &str,
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegSetValueExW, REG_SZ};
    let wide_name = HSTRING::from(name);
    let mut units: Vec<u16> = value.encode_utf16().collect();
    units.push(0);
    let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
    let status = RegSetValueExW(key, &wide_name, None, REG_SZ, Some(bytes.as_slice()));
    if status.0 == 0 {
        Ok(())
    } else {
        Err(err("SHELL_REG", status.0.to_string()))
    }
}

fn ensure_package(install_dir: &Path) -> Result<(), String> {
    let dll = find_shell_dll(install_dir).ok_or_else(|| {
        err(
            "SHELL_REG",
            format!("missing forge_shell_cmd.dll under {}", install_dir.display()),
        )
    })?;
    let exe = install_dir.join("forge.exe");
    if !exe.is_file() {
        return Err(err("SHELL_REG", format!("missing {}", exe.display())));
    }

    let dll_rel = dll
        .strip_prefix(install_dir)
        .map(|p| p.to_string_lossy().replace('/', "\\"))
        .unwrap_or_else(|_| "forge_shell_cmd.dll".into());

    let work = package_work_dir()?;
    let marker = package_marker(install_dir, &dll_rel);
    let state_path = work.join("registered.txt");
    let state = fs::read_to_string(&state_path).unwrap_or_default();
    if state == marker {
        return Ok(());
    }
    // 包已经在用、版本也对，就不要重打。重打会先 Remove-AppxPackage，
    // 后面的 Add 一旦失败，新菜单就没了。DLL 在外部目录，换文件不用重注册。
    match installed_package_version() {
        Some(Some(installed)) if installed == package_version() => {
            stop_shell_host();
            let _ = fs::write(&state_path, &marker);
            return Ok(());
        }
        Some(_) => {}
        None => {
            return Err(err(
                "SHELL_REG",
                "could not query Forge.ShellOpen; left the existing package alone",
            ));
        }
    }
    let tools = appx_tools_dir(install_dir)?;
    ensure_certificate(&work)?;
    // 先问用户，再提权。放在打包前面：否则证书还没问，前面的步骤失败了，弹窗永远出不来。
    let cer = work.join("ForgeShell.cer");
    let thumb = cert_thumbprint()?;
    ensure_machine_trust(&cer, &thumb)?;
    let publisher = CERT_SUBJECT.to_string();
    let pkg_dir = work.join("pkg");
    fs::create_dir_all(&pkg_dir).map_err(|e| err("SHELL_REG", e))?;
    write_logo(&pkg_dir)?;
    write_manifest(&pkg_dir, &publisher, &dll_rel)?;

    // 签到旁边的文件。失败时原来的 ForgeShell.msix 还在，可以装回去。
    let msix = work.join("ForgeShell.next.msix");
    run_tool(
        &tools.join("makeappx.exe"),
        &tools,
        &[
            "pack".into(),
            "/d".into(),
            pkg_dir.display().to_string(),
            "/p".into(),
            msix.display().to_string(),
            "/o".into(),
            "/nv".into(),
        ],
    )?;

    run_tool(
        &tools.join("signtool.exe"),
        &tools,
        &[
            "sign".into(),
            "/fd".into(),
            "SHA256".into(),
            "/sha1".into(),
            thumb.clone(),
            msix.display().to_string(),
        ],
    )?;
    trust_certificate(&cer, &thumb)?;
    let backup = work.join("ForgeShell.msix");
    remove_package().ok();
    if let Err(error) = add_package(&msix, install_dir) {
        if backup.is_file() {
            let _ = add_package(&backup, install_dir);
        }
        return Err(error);
    }
    let _ = fs::copy(&msix, &backup);
    fs::write(&state_path, &marker).map_err(|e| err("SHELL_REG", e))?;
    Ok(())
}

/// 卸载时彻底移除稀疏包与临时构建目录、证书残留。
pub fn clean_work_dir() {
    let _ = remove_package();
    let script = format!(
        r#"
Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\TrustedPeople, Cert:\CurrentUser\TrustedPeople, Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }} |
    Remove-Item -Force -ErrorAction SilentlyContinue
"#
    );
    let _ = run_powershell(&script);
    if let Some(base) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let work = base.join("Forge").join("shell-package");
        let _ = fs::remove_dir_all(work);
    }
}

/// 关过一次就记下，下次启动不再为了「确认没装」去拉 PowerShell。
fn remove_if_registered() -> Result<(), String> {
    let Some(base) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return Ok(());
    };
    let work = base.join("Forge").join("shell-package");
    let marker = work.join("registered.txt");
    if fs::read_to_string(&marker).ok().as_deref() == Some("off\n") {
        return Ok(());
    }
    remove_package()?;
    fs::create_dir_all(&work).map_err(|e| err("SHELL_REG", e))?;
    fs::write(&marker, "off\n").map_err(|e| err("SHELL_REG", e))
}

/// 记下这个包里写死了什么。版本号进 marker：升级后包必须重注册，
/// 否则 manifest 里那条 `Version` 永远停在第一次装上的那个。
fn package_marker(install_dir: &Path, dll_rel: &str) -> String {
    let dll = install_dir.join(dll_rel);
    let meta = fs::metadata(&dll).ok();
    let len = meta.as_ref().map(|item| item.len()).unwrap_or(0);
    let secs = meta
        .and_then(|item| item.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_secs())
        .unwrap_or(0);
    format!(
        "on\n7\n{}\n{}\n{dll_rel}\n{len}\n{secs}\n",
        env!("CARGO_PKG_VERSION"),
        install_dir.display()
    )
}

/// 已安装的包版本。外层 `None` 表示没查成（这时不能当成「没安装」去卸包），
/// 内层 `None` 表示确实没装。
fn installed_package_version() -> Option<Option<String>> {
    let mut command = Command::new("powershell");
    crate::sys::hide_console(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p = Get-AppxPackage -Name 'Forge.ShellOpen' -ErrorAction SilentlyContinue; if ($p) { $p.Version.ToString() } else { 'none' }",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.trim();
    if line.is_empty() {
        None
    } else if line == "none" {
        Some(None)
    } else {
        Some(Some(line.to_string()))
    }
}

/// 让持有 DLL 的 `dllhost.exe` 退出，好让安装包覆盖文件。
///
/// `taskkill` 没有 `COMMANDLINE` 过滤器（会直接报 "The search filter cannot be
/// recognized"），只能按模块名筛：谁加载了 `forge_shell_cmd.dll` 就收谁。
fn stop_shell_host() {
    let mut command = Command::new("taskkill");
    crate::sys::hide_console(&mut command);
    let _ = command
        .args(["/F", "/FI", "MODULES eq forge_shell_cmd.dll"])
        .output();
}

fn remove_package() -> Result<(), String> {
    let script = format!(
        r#"
Get-AppxPackage -Name '{PACKAGE_NAME}' -ErrorAction SilentlyContinue | ForEach-Object {{
    Remove-AppxPackage -Package $_.PackageFullName -ErrorAction SilentlyContinue
}}
try {{
    Get-AppxPackage -Name '{PACKAGE_NAME}' -AllUsers -ErrorAction Stop | ForEach-Object {{
        $pkg = $_.PackageFullName
        if ($_.PackageUserInformation) {{
            foreach ($u in $_.PackageUserInformation) {{
                Remove-AppxPackage -Package $pkg -User $u.UserSecurityId.Value -ErrorAction SilentlyContinue
            }}
        }}
        Remove-AppxPackage -Package $pkg -AllUsers -ErrorAction SilentlyContinue
    }}
}} catch {{}}
"#
    );
    run_powershell(&script)
}

fn add_package(msix: &Path, external: &Path) -> Result<(), String> {
    let script = format!(
        "Add-AppxPackage -Path '{}' -ExternalLocation '{}'",
        escape_ps(msix),
        escape_ps(external)
    );
    run_powershell(&script)
}

/// 确保 `CurrentUser\My` 里有一张带私钥的签名证书，并把公钥放进
/// `CurrentUser\TrustedPeople`。本机根证书由 `ensure_machine_trust` 单独处理。
fn ensure_certificate(work: &Path) -> Result<(), String> {
    let cer = work.join("ForgeShell.cer");
    if cer.is_file() && cert_thumbprint().is_ok() && cert_trusted(&cer) {
        return Ok(());
    }
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$cer = '{}'
$existing = Get-ChildItem Cert:\CurrentUser\My | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' -and $_.HasPrivateKey }} | Select-Object -First 1
if (-not $existing) {{
  $existing = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={{text}}1.3.6.1.5.5.7.3.3', '2.5.29.19={{text}}') -Subject '{CERT_SUBJECT}' -FriendlyName 'Forge Shell Open' -NotAfter (Get-Date).AddYears(15)
}}
Export-Certificate -Cert $existing -FilePath $cer -Force | Out-Null
$trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object {{ $_.Thumbprint -eq $existing.Thumbprint }}
if (-not $trusted) {{
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null
}}
"#,
        escape_ps(&cer)
    );
    run_powershell(&script)
}

/// 证书是不是已经在本用户的受信任发布者里。
fn cert_trusted(cer: &Path) -> bool {
    let script = format!(
        r#"
$thumb = (Get-ChildItem Cert:\CurrentUser\My | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' -and $_.HasPrivateKey }} | Select-Object -First 1).Thumbprint
if (-not $thumb) {{ Write-Output 'no'; exit }}
$c = Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object {{ $_.Thumbprint -eq $thumb }}
if ($c) {{ Write-Output 'yes' }} else {{ Write-Output 'no' }}
"#
    );
    let _ = cer;
    run_powershell_output(&script)
        .map(|text| text.trim().contains("yes"))
        .unwrap_or(false)
}

/// 签名证书的指纹。私钥只在 `CurrentUser\My` 里，`signtool` 按指纹取。
fn cert_thumbprint() -> Result<String, String> {
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$c = Get-ChildItem Cert:\CurrentUser\My | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' -and $_.HasPrivateKey }} | Select-Object -First 1
if (-not $c) {{ throw 'cert missing' }}
Write-Output $c.Thumbprint
"#
    );
    let out = run_powershell_output(&script)?;
    let thumb = out.trim().to_string();
    if thumb.len() < 8 {
        return Err(err("SHELL_REG", "cert thumbprint"));
    }
    Ok(thumb)
}

/// 把公钥证书放进受信任发布者（当前用户存储）。
fn trust_certificate(cer: &Path, thumb: &str) -> Result<(), String> {
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$cer = '{cer}'
$thumb = '{thumb}'
$trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object {{ $_.Thumbprint -eq $thumb }}
if (-not $trusted) {{
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null
}}
"#,
        cer = escape_ps(cer),
        thumb = thumb
    );
    run_powershell(&script)
}

/// 签名证书是不是已经在本机的受信任根里。
///
/// AppX 部署服务不看当前用户的证书库。只查 `LocalMachine\Root`。
fn machine_root_has(thumb: &str) -> bool {
    let script = format!(
        r#"
$thumb = '{thumb}'
$c = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object {{ $_.Thumbprint -eq $thumb }}
if ($c) {{ 'yes' }} else {{ 'no' }}
"#
    );
    run_powershell_output(&script)
        .map(|text| text.trim().contains("yes"))
        .unwrap_or(false)
}

/// 把公钥证书放进本机受信任根和受信任人。已在根里就什么都不做。
///
/// 先用说明框告诉用户为什么要装证书。点确定之后才提权；点取消就停，
/// 不弹系统权限框。当前进程通常没有写 `LocalMachine` 的权限。
fn ensure_machine_trust(cer: &Path, thumb: &str) -> Result<(), String> {
    if machine_root_has(thumb) {
        return Ok(());
    }
    if !confirm_certificate_install() {
        return Err(CERT_INSTALL_DECLINED.to_string());
    }
    let script_path = cer.with_file_name("trust-machine.ps1");
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 '{}'
foreach ($name in @('Root','TrustedPeople')) {{
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, 'LocalMachine')
  $store.Open('ReadWrite')
  $store.Add($cert)
  $store.Close()
}}
"#,
        escape_ps(cer)
    );
    fs::write(&script_path, script).map_err(|e| err("SHELL_REG", e))?;
    let result = if is_elevated() {
        run_powershell(&format!("& '{}'", escape_ps(&script_path)))
    } else {
        run_elevated_file(&script_path)
    };
    let _ = fs::remove_file(&script_path);
    result?;
    if machine_root_has(thumb) {
        Ok(())
    } else {
        Err(err(
            "SHELL_REG",
            "signing certificate is not in LocalMachine\\Root",
        ))
    }
}

/// 安装证书前的说明。系统权限框本身不写原因，直接弹的话用户只会拒绝。
fn confirm_certificate_install() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, MessageBoxW, IDCANCEL, MB_ICONINFORMATION, MB_OKCANCEL,
        MB_SETFOREGROUND, MB_TOPMOST,
    };
    let (title, body) = cert_prompt_text();
    let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let body_wide: Vec<u16> = body.encode_utf16().chain(std::iter::once(0)).collect();
    let owner = unsafe { GetForegroundWindow() };
    let answer = unsafe {
        let flags = MB_OKCANCEL | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST;
        if owner.0.is_null() {
            MessageBoxW(None, PCWSTR(body_wide.as_ptr()), PCWSTR(title_wide.as_ptr()), flags)
        } else {
            MessageBoxW(
                Some(owner),
                PCWSTR(body_wide.as_ptr()),
                PCWSTR(title_wide.as_ptr()),
                flags,
            )
        }
    };
    answer != IDCANCEL
}

fn cert_prompt_text() -> (&'static str, &'static str) {
    let lang = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    let primary = lang & 0x3FF;
    let sub = (lang >> 10) & 0x3F;
    if primary == 0x04 && (sub == 0x01 || sub == 0x03) {
        return (
            "安裝簽名憑證",
            "Windows 11 的新右鍵選單需要信任安裝包的簽章根憑證。\n\n未安裝時，系統會報「應用程式套件或套件組合中的簽章根憑證必須是受信任的憑證」，新選單不會出現。舊版右鍵選單不受影響。\n\n點「確定」後會安裝這台電腦上產生的 Forge 程式碼簽章憑證，接著彈出系統權限確認，請在那個視窗選擇「是」。\n點「取消」則不安裝，只保留舊版右鍵選單。",
        );
    }
    if primary == 0x04 {
        return (
            "安装签名证书",
            "Windows 11 的新右键菜单需要信任安装包的签名根证书。\n\n未安装时，系统会报「应用包或捆绑包中的签名的根证书必须是受信任的证书」，新菜单不会出现。旧版右键菜单不受影响。\n\n点「确定」后会安装这台电脑上生成的 Forge 代码签名证书，接着弹出系统权限确认，请在那个窗口选择「是」。\n点「取消」则不安装，只保留旧版右键菜单。",
        );
    }
    (
        "Install signing certificate",
        "The Windows 11 context menu needs the package signing root certificate to be trusted.\n\nWithout it, Windows reports that the root certificate of the signature must be trusted, and the new menu item does not appear. The classic menu is unchanged.\n\nChoose OK to install the Forge code-signing certificate created on this PC. Windows will then ask for administrator approval — choose Yes.\nChoose Cancel to skip installation and keep only the classic menu.",
    )
}

fn is_elevated() -> bool {
    use windows::Win32::UI::Shell::IsUserAnAdmin;
    unsafe { IsUserAnAdmin().as_bool() }
}

/// 用 `runas` 跑一份脚本，等它结束。UAC 取消时返回错误，不卸已经装上的包。
///
/// 直接提权 `powershell.exe` 会闪出一个控制台。`conhost --headless` 是无窗口的宿主，
/// 脚本在它里面跑，用户只看到系统权限确认。
fn run_elevated_file(script: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};

    let root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    let powershell = root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let conhost = root.join("System32").join("conhost.exe");
    let file: Vec<u16> = conhost
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params = format!(
        "--headless \"{}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"",
        powershell.display(),
        script.display()
    );
    let params_wide: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params_wide.as_ptr()),
        nShow: 0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut sei).map_err(|error| err("SHELL_REG", error))?;
        if sei.hProcess.is_invalid() {
            return Err(err("SHELL_REG", "elevated trust process did not start"));
        }
        let wait = WaitForSingleObject(sei.hProcess, 120_000);
        let mut code = 1u32;
        if wait == WAIT_OBJECT_0 {
            let _ = GetExitCodeProcess(sei.hProcess, &mut code);
        }
        let _ = CloseHandle(sei.hProcess);
        if wait != WAIT_OBJECT_0 {
            return Err(err("SHELL_REG", "elevated trust timed out"));
        }
        if code == 0 {
            Ok(())
        } else {
            Err(err("SHELL_REG", format!("elevated trust exit {code}")))
        }
    }
}

fn find_shell_dll(install_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        install_dir.join("forge_shell_cmd.dll"),
        install_dir.join("resources").join("forge_shell_cmd.dll"),
        install_dir
            .join("resources")
            .join("windows")
            .join("shell")
            .join("forge_shell_cmd.dll"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn write_manifest(pkg_dir: &Path, publisher: &str, dll_rel: &str) -> Result<(), String> {
    let version = package_version();
    let xml = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:desktop5="http://schemas.microsoft.com/appx/manifest/desktop/windows10/5"
  xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"
  IgnorableNamespaces="uap uap10 rescap desktop4 desktop5 com">
  <Identity Name="{PACKAGE_NAME}" Publisher="{publisher}" Version="{version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Forge</DisplayName>
    <PublisherDisplayName>Forge</PublisherDisplayName>
    <Logo>StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.22000.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
  <Applications>
    <Application Id="Forge" Executable="forge.exe" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
      <uap:VisualElements DisplayName="Forge" Description="Forge" BackgroundColor="transparent"
        Square150x150Logo="Square150x150Logo.png" Square44x44Logo="Square44x44Logo.png" />
      <Extensions>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:SurrogateServer DisplayName="Forge Shell Open">
              <com:Class Id="{CLSID_FILE}" Path="{dll_rel}" ThreadingModel="STA" />
            </com:SurrogateServer>
          </com:ComServer>
        </com:Extension>
        <desktop4:Extension Category="windows.fileExplorerContextMenus">
          <desktop4:FileExplorerContextMenus>
            <desktop5:ItemType Type="*">
              <desktop5:Verb Id="ForgeOpen" Clsid="{CLSID_FILE}" />
            </desktop5:ItemType>
            <desktop5:ItemType Type="Directory">
              <desktop5:Verb Id="ForgeOpenDir" Clsid="{CLSID_FILE}" />
            </desktop5:ItemType>
            <desktop5:ItemType Type="Directory\Background">
              <desktop5:Verb Id="ForgeOpenBg" Clsid="{CLSID_FILE}" />
            </desktop5:ItemType>
          </desktop4:FileExplorerContextMenus>
        </desktop4:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
"#
    );
    fs::write(pkg_dir.join("AppxManifest.xml"), xml).map_err(|e| err("SHELL_REG", e))
}

/// 包版本固定取四段：`1.0.6` → `1.0.6.0`。
///
/// 包版本必须单调递增，否则 `Add-AppxPackage` 会拒绝覆盖。之前这里写死
/// `1.0.6.0`，发 1.0.7 时包永远停在旧版本，`package_marker` 又没记版本，
/// 结果升级后新菜单不刷新。
fn package_version() -> String {
    let mut parts: Vec<u32> = env!("CARGO_PKG_VERSION")
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    while parts.len() < 4 {
        parts.push(0);
    }
    parts
        .iter()
        .map(|part| part.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

/// 稀疏包规范尺寸的彩色图标。
///
/// 避免使用 1x1 占位图导致 Windows 任务栏、Alt+Tab 或应用列表显示为灰色方块。
const LOGO_44: &[u8] = include_bytes!("../icons/Square44x44Logo.png");
const LOGO_150: &[u8] = include_bytes!("../icons/Square150x150Logo.png");
const LOGO_STORE: &[u8] = include_bytes!("../icons/Square50x50Logo.png");

fn write_logo(dir: &Path) -> Result<(), String> {
    fs::write(dir.join("Square44x44Logo.png"), LOGO_44).map_err(|e| err("SHELL_REG", e))?;
    fs::write(dir.join("Square150x150Logo.png"), LOGO_150).map_err(|e| err("SHELL_REG", e))?;
    fs::write(dir.join("StoreLogo.png"), LOGO_STORE).map_err(|e| err("SHELL_REG", e))?;
    Ok(())
}

fn package_work_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| err("SHELL_REG", "LOCALAPPDATA"))?;
    let dir = base.join("Forge").join("shell-package");
    fs::create_dir_all(&dir).map_err(|e| err("SHELL_REG", e))?;
    Ok(dir)
}

fn appx_tools_dir(install_dir: &Path) -> Result<PathBuf, String> {
    let candidates = [
        install_dir.join("appx-tools"),
        install_dir.join("resources").join("appx-tools"),
        install_dir
            .join("resources")
            .join("windows")
            .join("appx-tools"),
    ];
    for candidate in candidates {
        if candidate.join("makeappx.exe").is_file() {
            return Ok(candidate);
        }
    }
    // Dev: src-tauri/windows/appx-tools relative to current_exe (.../target/debug/forge.exe)
    let mut cursor = install_dir.to_path_buf();
    for _ in 0..6 {
        let candidate = cursor.join("windows").join("appx-tools");
        if candidate.join("makeappx.exe").is_file() {
            return Ok(candidate);
        }
        let alt = cursor.join("src-tauri").join("windows").join("appx-tools");
        if alt.join("makeappx.exe").is_file() {
            return Ok(alt);
        }
        if !cursor.pop() {
            break;
        }
    }
    Err(err("SHELL_REG", "appx-tools missing"))
}

fn run_tool(exe: &Path, cwd: &Path, args: &[String]) -> Result<(), String> {
    if !exe.is_file() {
        return Err(err("SHELL_REG", format!("missing {}", exe.display())));
    }
    let mut command = Command::new(exe);
    crate::sys::hide_console(&mut command);
    let output = command
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| err("SHELL_REG", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(err(
            "SHELL_REG",
            format!("{} {} {}", exe.display(), stdout.trim(), stderr.trim()),
        ))
    }
}

fn run_powershell(script: &str) -> Result<(), String> {
    let mut command = Command::new("powershell");
    crate::sys::hide_console(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|e| err("SHELL_REG", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(err(
            "SHELL_REG",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

fn run_powershell_output(script: &str) -> Result<String, String> {
    let mut command = Command::new("powershell");
    crate::sys::hide_console(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|e| err("SHELL_REG", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(err(
            "SHELL_REG",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

fn escape_ps(path: &Path) -> String {
    path.display().to_string().replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 包版本必须是四段纯数字，否则 `Add-AppxPackage` 直接拒绝。
    #[test]
    fn package_version_has_four_numeric_parts() {
        let version = package_version();
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(parts.len(), 4, "版本应为四段：{version}");
        for part in parts {
            assert!(
                part.parse::<u32>().is_ok(),
                "每一段都要是数字：{version}"
            );
        }
    }

    /// 包版本要跟着 Cargo 版本走，不能再写死。
    #[test]
    fn package_version_starts_with_cargo_version() {
        let version = package_version();
        let cargo = env!("CARGO_PKG_VERSION");
        let prefix = format!("{}.", cargo);
        assert!(
            version == format!("{cargo}.0") || version.starts_with(&prefix),
            "包版本 {version} 与 Cargo 版本 {cargo} 不一致"
        );
    }
}
