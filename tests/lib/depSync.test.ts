import { describe, expect, it, vi } from "vitest";
import {
  crcSignature,
  detectInstalledEcosystem,
  formatSyncCommand,
  isBuildWatchFile,
  isInstallMarkerPath,
  isManifestDeclarationFile,
  sameFilesCrc,
} from "../../src/lib/depSync";

// 纯函数测试，mock 掉模块顶层的 IPC 依赖。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("depSync 构建文件监听过滤与 CRC 签名契约", () => {
  it("识别根目录与一级子模块下的构建清单与锁文件（含 bun.lockb），忽略普通源码与编译副产物", () => {
    const root = "D:\\work\\demo";
    expect(isBuildWatchFile("D:\\work\\demo\\package.json", root)).toBe(true);
    expect(isBuildWatchFile("D:\\work\\demo\\pnpm-lock.yaml", root)).toBe(true);
    expect(isBuildWatchFile("D:\\work\\demo\\bun.lockb", root)).toBe(true);
    expect(isBuildWatchFile("D:\\work\\demo\\sub\\pom.xml", root)).toBe(true);
    expect(isBuildWatchFile("D:\\work\\demo\\packages\\ui\\gradle\\libs.versions.toml", root)).toBe(true);
    expect(isBuildWatchFile("D:\\work\\demo\\app\\App.csproj", root)).toBe(true);
    expect(isBuildWatchFile("D:\\work\\demo\\node_modules\\.modules.yaml", root)).toBe(true);

    // 路径大小写混用与斜杠兼容性
    expect(isBuildWatchFile("d:/work/demo/package.json", root)).toBe(true);
    expect(isBuildWatchFile("D:/work/demo/BUN.LOCKB", root)).toBe(true);

    // 排除普通源码文件、编译副产物锁文件（Cargo.lock / go.sum）与深层缓存文件
    expect(isBuildWatchFile("D:\\work\\demo\\src\\App.tsx", root)).toBe(false);
    expect(isBuildWatchFile("D:\\work\\demo\\Cargo.lock", root)).toBe(false);
    expect(isBuildWatchFile("D:\\work\\demo\\go.sum", root)).toBe(false);
    expect(isBuildWatchFile("D:\\work\\demo\\node_modules\\react\\package.json", root)).toBe(false);
    expect(isBuildWatchFile("D:\\work\\demo\\node_modules\\.vite\\deps\\react.js", root)).toBe(false);
    expect(isBuildWatchFile("D:\\work\\demo\\target\\package\\Cargo.toml", root)).toBe(false);
  });

  it("精确识别包管理器安装完成标记及其生态分类", () => {
    const root = "D:\\work\\demo";
    expect(isInstallMarkerPath("D:\\work\\demo\\node_modules\\.modules.yaml", root)).toBe(true);
    expect(detectInstalledEcosystem("D:\\work\\demo\\node_modules\\.modules.yaml", root)).toBe("npm");
    expect(detectInstalledEcosystem("D:\\work\\demo\\vendor\\autoload.php", root)).toBe("php");
    expect(detectInstalledEcosystem("D:\\work\\demo\\.venv\\pyvenv.cfg", root)).toBe("python");
    expect(detectInstalledEcosystem("D:\\work\\demo\\.dart_tool\\package_config.json", root)).toBe("dart");
    expect(isInstallMarkerPath("D:\\work\\demo\\node_modules\\.vite\\deps\\react.js", root)).toBe(false);

    // 区分工程构建声明文件与本地安装目录标记
    expect(isManifestDeclarationFile("D:\\work\\demo\\package.json", root)).toBe(true);
    expect(isManifestDeclarationFile("D:\\work\\demo\\node_modules\\.modules.yaml", root)).toBe(false);
  });

  it("crcSignature 与 sameFilesCrc 按键值稳定比对", () => {
    const a = { "package.json": 123456, "pnpm-lock.yaml": 654321 };
    const b = { "pnpm-lock.yaml": 654321, "package.json": 123456 };
    const c = { "package.json": 999999, "pnpm-lock.yaml": 654321 };

    expect(crcSignature(a)).toBe(crcSignature(b));
    expect(sameFilesCrc(a, b)).toBe(true);
    expect(sameFilesCrc(a, c)).toBe(false);
  });

  it("formatSyncCommand 将占位展开为简洁可读的命令文本", () => {
    expect(formatSyncCommand("${mvn} dependency:resolve")).toBe("mvn dependency:resolve");
    expect(formatSyncCommand("${gradle} --refresh-dependencies help")).toBe(
      "gradle --refresh-dependencies"
    );
  });
});
