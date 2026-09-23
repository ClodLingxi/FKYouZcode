// esbuild 打包：手机 Web 客户端单文件 bundle。
// 直接引用仓库内 @zcode/shared / @zcode/rpc 的 TS 源码（同构模块），
// 产物 dist/{index.html,app.js} 可由任意静态服务器（含 apps/web-remote-relay）托管。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = require("../../node_modules/esbuild/lib/main.js");
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: join(dist, "app.js"),
  sourcemap: true,
  minify: true,
  logLevel: "info",
});

cpSync(join(root, "index.html"), join(dist, "index.html"));
console.log("[web-remote-client] dist ready");
