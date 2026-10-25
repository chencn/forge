/// Windows 11 稀疏包的稳定身份。运行时生成清单、打包、签名都按这一份协议定义。
pub const PACKAGE_NAME: &str = "Forge.ShellOpen";
pub const CERT_SUBJECT: &str = "CN=Forge Shell Open";
pub const CLSID_FILE: &str = "B8E4F1A2-9C3D-4E5F-A1B2-C3D4E5F60718";
/// `registered.txt` 的协议版本；清单语义变化时必须递增，强制运行时重新注册。
pub const PACKAGE_SCHEMA_VERSION: u32 = 8;

/// AppX 版本必须是四段纯数字；预发布标记不能进入清单版本。
pub fn package_version(crate_version: &str) -> String {
    let mut parts: Vec<u32> = crate_version
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

/// 生成系统实际消费的 AppX 清单。运行时重注册时按它重新打包。
pub fn manifest(crate_version: &str, publisher: &str, dll_rel: &str) -> String {
    let version = package_version(crate_version);
    format!(
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
    )
}
