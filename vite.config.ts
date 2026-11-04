import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFile, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const port = 1420;

/** PDF 支持资源保持同源、离线可用；只发布运行时文件，不拷贝源码或 source map。 */
function pdfResources(): Plugin {
  const base = new URL("./node_modules/pdfjs-dist/", import.meta.url);
  const assets = new Map<string, URL>();
  return {
    name: "pdf-runtime-resources",
    async buildStart() {
      assets.clear();
      assets.set("LICENSE", new URL("LICENSE", base));
      for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
        for (const name of await readdir(new URL(`${dir}/`, base))) {
          if (/\.(bcmap|pfb|ttf|wasm|icc|js)$/.test(name) || name.startsWith("LICENSE")) {
            assets.set(`${dir}/${name}`, new URL(`${dir}/${name}`, base));
          }
        }
      }
      if (this.environment.config.command === "build") {
        for (const [name, url] of assets) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${name}`, source: await readFile(url) });
        }
      }
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const file = assets.get((req.url ?? "").split("?")[0].replace(/^\//, ""));
        if (!file) return next();
        res.setHeader("Content-Type", file.pathname.endsWith(".wasm") ? "application/wasm"
          : file.pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        createReadStream(fileURLToPath(file)).on("error", next).pipe(res);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), pdfResources()],
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
    // 词典改成按语言懒加载后，测试得先统一预载（见 tests/setup.ts）。
    setupFiles: ["tests/setup.ts"],
  },
}));
