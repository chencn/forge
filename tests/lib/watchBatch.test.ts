import { expect, it } from "vitest";

import {
  isBuildOutputPath,
  isBulkArtifactPath,
  isPackageInstallPath,
  needsFullTreeRefresh,
  planWorkspaceFlush,
} from "../../src/lib/watchBatch";

const plan = (input: Partial<Parameters<typeof planWorkspaceFlush>[0]>) =>
  planWorkspaceFlush({
    workspacePaths: [],
    gitPaths: [],
    bulk: false,
    finishedInstall: false,
    manifestChanged: false,
    ...input,
  });

it("保存一个源文件：精确作废目录缓存，顺带重取变更清单", () => {
  expect(plan({ workspacePaths: ["D:/repo/src/App.tsx"] })).toEqual({
    tree: "precise",
    configs: false,
    git: "changes",
  });
});

it("改了构建声明文件才重扫顶栏配置", () => {
  expect(plan({ workspacePaths: ["D:/repo/package.json"], manifestChanged: true }).configs).toBe(
    true
  );
  expect(plan({ workspacePaths: ["D:/repo/src/a.ts"] }).configs).toBe(false);
});

it("构建产物风暴只精确作废，不再整树重来", () => {
  const buildOutput = [
    "D:/repo/target/debug/deps/a.d",
    "D:/repo/target/debug/incremental/x.rs",
    "D:/repo/dist/app.js",
  ];
  expect(plan({ workspacePaths: buildOutput, bulk: true })).toEqual({
    tree: "precise",
    configs: false,
    git: "changes",
  });
});

it("安装收尾把攒下的依赖路径按全量落地", () => {
  expect(
    plan({
      workspacePaths: ["D:/repo/node_modules/react/index.js", "D:/repo/package-lock.json"],
      bulk: true,
      finishedInstall: true,
      manifestChanged: true,
    })
  ).toEqual({ tree: "full", configs: true, git: "changes" });
});

it("安装收尾即使一个路径都没攒到也重读一次树", () => {
  const p = plan({ finishedInstall: true });
  expect(p.tree).toBe("full");
  expect(p.git).toBe("changes");
});

it("只有 .git 变动的批次不动目录树", () => {
  expect(plan({ gitPaths: ["D:/repo/.git/index"] })).toEqual({
    tree: "none",
    configs: false,
    git: "changes",
  });
  // HEAD / 引用 / 合并态变了要连分支与提交记录一起重取。
  expect(plan({ gitPaths: ["D:/repo/.git/HEAD"] }).git).toBe("full");
  expect(plan({ gitPaths: ["D:/repo/.git/MERGE_HEAD"] }).git).toBe("full");
  expect(plan({ gitPaths: ["D:\\repo\\.git\\packed-refs"] }).git).toBe("full");
});

it("什么都没有的一批什么都不刷", () => {
  expect(plan({})).toEqual({ tree: "none", configs: false, git: "none" });
});

it("只有构建产物在写的批次不作废整棵目录树", () => {
  const batch = [
    "D:/repo/target/debug/deps/forge-1a2b.d",
    "D:/repo/target/debug/incremental/build.rs",
    "D:/repo/dist/app.js",
  ];
  expect(batch.every(isBuildOutputPath)).toBe(true);
  // 即便监听器把这批标成风暴（路径数够多），也只该按路径精确作废。
  expect(needsFullTreeRefresh(batch, true)).toBe(false);
  expect(needsFullTreeRefresh(batch, false)).toBe(false);
});

it("掺了非产物路径的真批量仍然全量作废", () => {
  const batch = [
    "D:/repo/target/debug/app.exe",
    "D:/repo/src/App.tsx",
    "D:/repo/src/components/Button.tsx",
  ];
  expect(needsFullTreeRefresh(batch, true)).toBe(true);
  // 同样的批次没到风暴阈值时保持精确作废：单文件保存不该重读整棵树。
  expect(needsFullTreeRefresh(batch, false)).toBe(false);
});

it("依赖目录整块出现时全量作废", () => {
  expect(needsFullTreeRefresh(["D:/repo/node_modules/react/index.js"], false)).toBe(true);
  expect(needsFullTreeRefresh(["D:\\repo\\.pnpm\\lock.yaml"], false)).toBe(true);
  expect(needsFullTreeRefresh(["/home/u/proj/vendor/autoload.php"], false)).toBe(true);
  expect(isPackageInstallPath("/home/u/proj/.venv/bin/python")).toBe(true);
});

it("改清单与锁文件不再牵连整棵树重读", () => {
  const batch = ["D:/repo/package.json", "D:/repo/package-lock.json"];
  expect(needsFullTreeRefresh(batch, false)).toBe(false);
});

it("空批次什么都不作废", () => {
  expect(needsFullTreeRefresh([], true)).toBe(false);
});

it("分隔符与大小写写法不影响判定", () => {
  const windows = "d:\\Repo\\Build\\Output\\app.pdb";
  expect(isBuildOutputPath(windows)).toBe(true);
  expect(needsFullTreeRefresh([windows], true)).toBe(false);
  // .NET 产物落在 bin/Debug 下，同样只该精确作废。
  expect(isBuildOutputPath("D:/repo/src/bin/Debug/net8.0/app.dll")).toBe(true);
});

it("产物目录自身也算产物：真实批次里 notify 会把 `.../target` 这条一起报来", () => {
  const buildOutputWithSelf = [
    "D:\\app\\code\\forge\\src-tauri\\target",
    "D:\\app\\code\\forge\\src-tauri\\target\\e2e-why\\b-0.o",
    "D:\\app\\code\\forge\\src-tauri\\target\\e2e-why\\b-1.o",
  ];
  expect(isBuildOutputPath("D:\\repo\\src-tauri\\target")).toBe(true);
  expect(isBuildOutputPath("D:/repo/target/")).toBe(true);
  expect(needsFullTreeRefresh(buildOutputWithSelf, true)).toBe(false);
  // 依赖目录同理：`.venv` 自己被报来时也该认作依赖痕迹，而不是落到「掺了别的东西」。
  expect(isPackageInstallPath("/home/u/proj/.venv")).toBe(true);
  expect(isPackageInstallPath("D:\\repo\\node_modules")).toBe(true);
  // 但不是任意同名尾巴：`my-vendor` 不该被当成 vendor。
  expect(isBuildOutputPath("D:/repo/scripts/my-build")).toBe(false);
});

it("节流用的批量特征路径照旧认产物与依赖", () => {
  expect(isBulkArtifactPath("D:/repo/dist/bundle.js")).toBe(true);
  expect(isBulkArtifactPath("D:/repo/node_modules/vue/runtime.esm.js")).toBe(true);
  expect(isBulkArtifactPath("D:/repo/src/main.rs")).toBe(false);
});
