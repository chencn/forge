import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const port = 1420;

export default defineConfig(({ command }) => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // dist 整个打进安装包：product build 带上 .map 就是白塞几十 MB 进去。
    // 开发时的报错还是要能对上行号，所以只在 dev server 上出图。
    sourcemap: command === "serve",
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // 测试集中在 tests/，目录与 src 镜像；钉死 include 免得默认 glob 把 src 内散落的也扫进来。
  test: {
    include: ["tests/**/*.test.ts"],
  },
}));
