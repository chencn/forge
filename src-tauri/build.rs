fn main() {
    // 必须先于 tauri_build：Windows 配置把 DLL 列进 resources，缺文件会直接失败。
    build_shell_cmd_dll();
    tauri_build::build();
    link_manifest_into_tests();
}

/// 编出 Win11 新菜单用的 `forge_shell_cmd.dll`。
///
/// 用独立 `CARGO_TARGET_DIR`，避免与正在编译的 forge 抢同一把 target 锁。
/// `--target` 必须跟着传：交叉编译时宿主机的产物架构不对，装进包里加载不了。
fn build_shell_cmd_dll() {
    println!("cargo:rerun-if-changed=crates/forge-shell-cmd/src/lib.rs");
    println!("cargo:rerun-if-changed=crates/forge-shell-cmd/Cargo.toml");
    println!("cargo:rerun-if-changed=crates/forge-shell-ext/src/lib.rs");
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let out_dir = std::env::var("OUT_DIR").unwrap_or_else(|_| format!("{manifest}/target"));
    let alt_target = std::path::Path::new(&out_dir).join("forge-shell-cmd-target");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut cmd = std::process::Command::new(&cargo);
    cmd.args([
        "build",
        "-p",
        "forge-shell-cmd",
        "--manifest-path",
        &format!("{manifest}/Cargo.toml"),
        "--target-dir",
        &alt_target.to_string_lossy(),
        "--target",
        &target,
    ]);
    // `PROFILE` 可能是自定义 profile 名（`--profile foo`），那类目录 cargo 也建在
    // target/<profile> 下，但只有 debug/release 才对应 `--release` 语义。
    if profile == "release" {
        cmd.arg("--release");
    }
    match cmd.status() {
        Ok(code) if code.success() => {
            let dll_name = "forge_shell_cmd.dll";
            // 传了 --target 之后产物落在 target/<triple>/<profile>/。
            let built = alt_target.join(&target).join(&profile).join(dll_name);
            if !built.is_file() {
                println!(
                    "cargo:warning=forge-shell-cmd 已编译但未找到 {}",
                    built.display()
                );
                return;
            }
            let main_target = std::env::var("CARGO_TARGET_DIR")
                .unwrap_or_else(|_| format!("{manifest}/target"));
            let main_target = std::path::Path::new(&main_target);
            // 交叉编译时主产物的目录也带 triple；原生编译则不带。取已经存在的那个。
            let triple_dir = main_target.join(&target).join(&profile);
            let sibling_dir = if triple_dir.is_dir() {
                triple_dir
            } else {
                main_target.join(&profile)
            };
            let sibling = sibling_dir.join(dll_name);
            let _ = std::fs::create_dir_all(&sibling_dir);
            let _ = std::fs::copy(&built, &sibling);
            let bundle_dir = std::path::Path::new(&manifest).join("windows").join("shell");
            let _ = std::fs::create_dir_all(&bundle_dir);
            let _ = std::fs::copy(&built, bundle_dir.join(dll_name));
            let _ = std::fs::copy(&built, std::path::Path::new(&out_dir).join(dll_name));
            println!("cargo:warning=forge_shell_cmd.dll -> {}", sibling.display());
        }
        Ok(_) => println!("cargo:warning=forge-shell-cmd 编译失败，Win11 新菜单将不可用"),
        Err(error) => println!("cargo:warning=无法启动 forge-shell-cmd 编译：{error}"),
    }
}

/// 让 `cargo test` 生成的测试可执行文件也带上 Common-Controls 依赖声明。
///
/// `tauri_build` 那份资源进不了测试二进制，测试 exe 没有这段清单声明，系统就把
/// `comctl32.dll` 解析成 v5，而 `tao`/`muda` 要 `TaskDialogIndirect`（只有 v6 有），
/// 进程在装载阶段直接以 STATUS_ENTRYPOINT_NOT_FOUND 退出，一个用例都跑不起来。
///
/// 只在设了 `FORGE_TEST_MANIFEST` 时做，且只走 `cargo:rustc-link-arg`：正式的
/// `tauri dev`/`tauri build` 不设这个变量，清单仍由 `tauri_build` 一份给全，不会重复。
/// 跑测试用 `FORGE_TEST_MANIFEST=1 cargo test --manifest-path src-tauri/Cargo.toml`。
/// 链接时会有一句 `.rsrc merge failure: multiple non-default manifests` 的告警，
/// 是 rustc 自带的默认清单和这份合并时的正常提示，测试二进制照样能起，不用管。
fn link_manifest_into_tests() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=FORGE_TEST_MANIFEST");
    if std::env::var("FORGE_TEST_MANIFEST").is_err() {
        return;
    }
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.ends_with("pc-windows-gnu") {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let out = std::path::Path::new(&out_dir);

    // 清单本体。`1` 是 CREATEPROCESS_MANIFEST_RESOURCE_ID，`24` 是 RT_MANIFEST。
    let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;
    if std::fs::write(out.join("test-manifest.manifest"), manifest).is_err() {
        return;
    }
    if std::fs::write(
        out.join("test-manifest.rc"),
        "1 24 \"test-manifest.manifest\"\n",
    )
    .is_err()
    {
        return;
    }

    let tool = std::env::var("WINDRES").unwrap_or_else(|_| "windres".to_string());
    let built = std::process::Command::new(&tool)
        .current_dir(out)
        .args(["--input", "test-manifest.rc", "--output-format=coff", "--output", "test-manifest.res"])
        .status();
    match built {
        Ok(status) if status.success() => {
            let res = out.join("test-manifest.res");
            println!("cargo:rustc-link-arg={}", res.display());
        }
        _ => {
            println!("cargo:warning=没能编出测试清单资源，cargo test 会因缺 Common-Controls 起不来");
        }
    }
}
