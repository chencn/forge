import { describe, expect, it } from "vitest";
import { languageCatalog, languageForPath, languageLabel } from "../../src/lib/editorEnv";

describe("languageForPath 路径到 Monaco 语言映射", () => {
  it("Kotlin 与 Kotlin Script (.kts) 文件正确识别为 kotlin", () => {
    expect(languageForPath("src/main/kotlin/App.kt")).toBe("kotlin");
    expect(languageForPath("build.gradle.kts")).toBe("kotlin");
    expect(languageForPath("settings.gradle.kts")).toBe("kotlin");
    expect(languageForPath("C:\\project\\scripts\\task.kts")).toBe("kotlin");
    expect(languageForPath("/repo/submodule/BUILD.GRADLE.KTS")).toBe("kotlin");
  });

  it("Properties 配置文件正确识别为 properties", () => {
    expect(languageForPath("application.properties")).toBe("properties");
    expect(languageForPath("application-dev.properties")).toBe("properties");
    expect(languageForPath("gradle.properties")).toBe("properties");
    expect(languageForPath("C:\\project\\local.properties")).toBe("properties");
    expect(languageLabel("properties")).toBe("Properties");
  });

  it("常见编程语言正确映射", () => {
    // 目录 1:1 后 tsx 是独立的 typescriptreact（对标 IDE 的语言 id）。
    expect(languageForPath("App.tsx")).toBe("typescriptreact");
    expect(languageForPath("app.jsx")).toBe("javascriptreact");
    expect(languageForPath("index.js")).toBe("javascript");
    expect(languageForPath("main.rs")).toBe("rust");
    expect(languageForPath("Main.java")).toBe("java");
    expect(languageForPath("script.py")).toBe("python");
    expect(languageForPath("server.go")).toBe("go");
  });

  it("特殊文件名与未知扩展名", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath(".gitignore")).toBe("ignore");
    expect(languageForPath(".gitmodules")).toBe("ini");
    expect(languageForPath("gradlew")).toBe("shellscript");
    expect(languageForPath("C:\\project\\gradlew")).toBe("shellscript");
    expect(languageForPath("mvnw")).toBe("shellscript");
    expect(languageForPath("Gemfile")).toBe("ruby");
    expect(languageForPath("Rakefile")).toBe("ruby");
    expect(languageForPath("build.sbt")).toBe("scala");
    expect(languageForPath("Cargo.lock")).toBe("toml");
    expect(languageForPath("D:\\app\\code\\forge\\Cargo.lock")).toBe("toml");
    expect(languageForPath(".env")).toBe("dotenv");
    expect(languageForPath(".env.development")).toBe("dotenv");
    expect(languageForPath("D:\\app\\code\\gyt-h5\\.env.development")).toBe("dotenv");
    expect(languageForPath(".env.production.local")).toBe("dotenv");
    expect(languageForPath(".environment")).toBe("plaintext");
    expect(languageForPath(".bashrc")).toBe("shellscript");
    expect(languageForPath(".gitconfig")).toBe("ini");
    expect(languageForPath("README")).toBe("plaintext");
    expect(languageForPath("data.unknown")).toBe("plaintext");
    expect(languageForPath("api.http")).toBe("http");
    expect(languageForPath("api.rest")).toBe("http");
    expect(languageForPath("C:\\project\\requests\\login.HTTP")).toBe("http");
    // Shebang 识别
    expect(languageForPath("custom-script", "#!/bin/bash\necho 1")).toBe("shellscript");
    expect(languageForPath("run-job", "#!/usr/bin/env python3\nprint(1)")).toBe("python");
  });

  it("云原生、多语言与专业工程配置正确识别", () => {
    // Protobuf & IaC
    expect(languageForPath("service.proto")).toBe("proto");
    expect(languageForPath("main.tf")).toBe("terraform");
    expect(languageForPath("variables.tfvars")).toBe("terraform-vars");
    expect(languageForPath("infra.bicep")).toBe("bicep");

    // 现代前端与模板
    expect(languageForPath("doc.mdx")).toBe("markdown");
    expect(languageForPath("view.pug")).toBe("pug");
    expect(languageForPath("page.hbs")).toBe("handlebars");
    expect(languageForPath("email.ftl")).toBe("freemarker2");

    // 多语言生态
    expect(languageForPath("Main.scala")).toBe("scala");
    expect(languageForPath("server.ex")).toBe("elixir");
    expect(languageForPath("core.clj")).toBe("clojure");
    expect(languageForPath("math.jl")).toBe("julia");
    expect(languageForPath("script.pl")).toBe("perl");
    expect(languageForPath("token.sol")).toBe("sol");
    expect(languageForPath("app.fs")).toBe("fsharp");
    expect(languageForPath("controller.m")).toBe("objective-c");

    // .NET / XML 家族
    expect(languageForPath("App.csproj")).toBe("xml");
    expect(languageForPath("MainWindow.xaml")).toBe("xml");
    expect(languageForPath("Directory.Build.props")).toBe("xml");
    expect(languageForPath("Index.cshtml")).toBe("razor");

    // NSIS 安装脚本
    expect(languageForPath("installer.nsi")).toBe("nsis");
    expect(languageForPath("windows/nsis/installer.nsi")).toBe("nsis");
    expect(languageForPath("utils.nsh")).toBe("nsis");
    expect(languageForPath("C:\\project\\FileAssociation.NSH")).toBe("nsis");

    // 语言展示名
    expect(languageLabel("proto")).toBe("Protocol Buffers");
    expect(languageLabel("nsis")).toBe("NSIS");
    expect(languageLabel("hcl")).toBe("HCL");
    expect(languageLabel("scala")).toBe("Scala");
    expect(languageLabel("sol")).toBe("Solidity");
  });

  it("主流语言的工程文件按文件名识别", () => {
    expect(languageForPath("D:\\app\\go\\go-print\\go.mod")).toBe("gomod");
    expect(languageForPath("go.work")).toBe("gowork");
    expect(languageForPath("go.sum")).toBe("plaintext");
    expect(languageForPath("go.work.sum")).toBe("plaintext");
    expect(languageForPath("build.gradle")).toBe("groovy");
    expect(languageForPath("settings.gradle")).toBe("groovy");
    expect(languageForPath("build.gradle.kts")).toBe("kotlin");
    expect(languageForPath("CMakeLists.txt")).toBe("cmake");
    expect(languageForPath("src\\CMakeLists.txt")).toBe("cmake");
    expect(languageForPath("toolchain.cmake")).toBe("cmake");
    expect(languageForPath("requirements.txt")).toBe("plaintext");
    expect(languageForPath("dev-requirements.txt")).toBe("plaintext");
    expect(languageForPath("notes.txt")).toBe("plaintext");
    expect(languageForPath("Pipfile")).toBe("toml");
    expect(languageForPath("setup.cfg")).toBe("ini");
    expect(languageForPath("composer.lock")).toBe("json");
    expect(languageForPath("poetry.lock")).toBe("toml");
    expect(languageForPath("pubspec.lock")).toBe("plaintext");
    expect(languageForPath("Dockerfile.dev")).toBe("dockerfile");
    expect(languageForPath("Containerfile")).toBe("dockerfile");
    expect(languageForPath("GNUmakefile")).toBe("makefile");
    expect(languageLabel("gomod")).toBe("Go Module");
    expect(languageLabel("groovy")).toBe("Groovy");
    expect(languageLabel("cmake")).toBe("CMake");
  });

  it("语言目录是对标 IDE 的 72 门，id 与显示名一一对应", () => {
    const catalog = languageCatalog();
    expect(catalog).toHaveLength(72);
    const ids = new Set(catalog.map((entry) => entry.id));
    expect(ids.has("gomod")).toBe(true);
    expect(ids.has("ocaml-interface")).toBe(true);
    expect(ids.has("typescriptreact")).toBe(true);
  });
});
