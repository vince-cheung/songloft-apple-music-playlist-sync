/**
 * 构建脚本：src/main.ts → dist/apple-music-sync.jsplugin.zip
 *
 * 与官方 @songloft/plugin-builder 的差异：
 *  - 保留 main.js（不编译成 .jsc），兼容不支持字节码入口的宿主版本；
 *  - 静态资源不做内容 hash 改名（manifest.staticHash=false），页面引用路径固定；
 *  - entryHash / zipHash 直接复用官方实现，保证与后端校验算法完全一致。
 */
import { build } from "esbuild";
import JSZip from "jszip";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { computeCanonicalZipHash, computeEntryHash } from "@songloft/plugin-builder";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(root, "dist");
const buildDir = join(outDir, "_build");

function log(msg) {
  console.log(msg);
}

async function main() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf-8"));

  const entry = join(root, "src", "main.ts");
  if (!existsSync(entry)) throw new Error("缺少 src/main.ts");

  await build({
    entryPoints: [entry],
    outfile: join(buildDir, "main.js"),
    bundle: true,
    platform: "neutral",
    format: "iife",
    target: "es2020",
    minify: true,
    legalComments: "none",
    charset: "utf8",
  });

  if (existsSync(join(root, "static"))) {
    cpSync(join(root, "static"), join(buildDir, "static"), { recursive: true });
  }

  const mainJs = readFileSync(join(buildDir, "main.js"));
  const entryHash = computeEntryHash(mainJs);
  const zipHash = computeCanonicalZipHash(buildDir);

  const finalManifest = {
    ...manifest,
    main: "main.js",
    entryHash,
    zipHash,
  };
  writeFileSync(join(buildDir, "plugin.json"), JSON.stringify(finalManifest, null, 2), "utf-8");

  const zip = new JSZip();
  const files = walk(buildDir);
  for (const rel of files) {
    zip.file(rel, readFileSync(join(buildDir, rel)));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const zipPath = join(outDir, manifest.entryPath + ".jsplugin.zip");
  writeFileSync(zipPath, buffer);

  log("构建完成");
  log("  产物   " + zipPath + "  (" + (buffer.length / 1024).toFixed(1) + " KB)");
  log("  main.js " + (mainJs.length / 1024).toFixed(1) + " KB");
  log("  entryHash " + entryHash);
  log("  zipHash   " + zipHash);
  log("  文件清单:");
  for (const rel of files) {
    const size = statSync(join(buildDir, rel)).size;
    log("    - " + rel + "  (" + size + " B)");
  }
}

function walk(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? posix.join(prefix, name) : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

await main();
