//! Win11 新右键菜单用的稀疏包（IExplorerCommand + package identity）。
//!
//! 经典 `shell\ForgeOpen` 动词进不了新菜单。这里在开启「通过 Forge 打开」时
//! 签名并注册稀疏包；关掉时卸掉。
//!
//! 签名用一张自签证书，放进**当前用户**的 `TrustedPeople` 就够侧载校验，
//! 不需要提权，也不会把一张可伪造的根证书塞进这台机器的信任根。私钥只在
//! `CurrentUser\My` 里，不导出成文件。

#![cfg(windows)]

use crate::error::err;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PACKAGE_NAME: &str = "Forge.ShellOpen";
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
        let status = RegCreateKeyW(HKEY_CURRENT_USER, &name, &mut key);
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
            "/nv".into(),
        ],
    )?;

    let thumb = cert_thumbprint()?;
    run_tool(
        &tools.join("signtool.exe"),
        &tools,
        &[
            "sign".into(),
            "/fd".into(),
            "SHA256".into(),
            "/sha1".into(),
            thumb,
            msix.display().to_string(),
        ],
    )?;
    trust_certificate(&work.join("ForgeShell.cer"))?;
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

/// 卸载时彻底移除稀疏包的临时构建目录。
pub fn clean_work_dir() {
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
        "on\n5\n{}\n{}\n{dll_rel}\n{len}\n{secs}\n",
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
        "$p = Get-AppxPackage -Name '{PACKAGE_NAME}' -ErrorAction SilentlyContinue; if ($p) {{ Remove-AppxPackage -Package $p.PackageFullName }}"
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
/// `CurrentUser\TrustedPeople`。
///
/// 侧载/稀疏包校验认的是 `TrustedPeople`，这个位置不需要管理员权限。
/// 私钥不导出成文件：导出的 pfx 无论加什么口令，口令都得写在程序里，
/// 等于把签名能力交给本机任何进程。
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
  $existing = New-SelfSignedCertificate -Type CodeSigningCert -Subject '{CERT_SUBJECT}' -CertStoreLocation 'Cert:\CurrentUser\My' -KeySpec Signature -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(15)
}}
Export-Certificate -Cert $existing -FilePath $cer -Force | Out-Null
# TrustedPeople：当前用户的受信任发布者，侧载校验看这里，不需要提权。
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
$c = Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }}
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

/// 把公钥证书放进当前用户的受信任发布者。
///
/// 用 `CurrentUser\TrustedPeople` 而不是 `LocalMachine\Root`：侧载校验只要求前者，
/// 而后者会让整台机器信任一张自签根，任何拿到这把私钥的程序都能冒充可信发布者。
fn trust_certificate(cer: &Path) -> Result<(), String> {
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$cer = '{}'
$trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object {{ $_.Subject -eq '{CERT_SUBJECT}' }}
if (-not $trusted) {{
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null
}}
"#,
        escape_ps(cer)
    );
    run_powershell(&script)
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
        Square150x150Logo="StoreLogo.png" Square44x44Logo="StoreLogo.png" />
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

fn write_logo(dir: &Path) -> Result<(), String> {
    // 1x1 PNG
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    fs::write(dir.join("StoreLogo.png"), PNG).map_err(|e| err("SHELL_REG", e))
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
