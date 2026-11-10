/**
 * 校验打包产物：dist/{entryPath}.jsplugin.zip
 *
 * 独立于 build.mjs，直接从 zip 内容复算宿主需要的两个 hash，并与 zip 内
 * plugin.json 的值比对。算法与 Songloft 后端 internal/jsplugin/hash.go 一致：
 *   - entryHash = sha256(main.js 内容)
 *   - zipHash   = sha256( 对除 plugin.json 外的每个文件写 "<path>\n<sha256hex>\n"，
 *                          文件按路径字节序升序 )
 *
 * 用法：node scripts/verify-artifact.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const entryPath = manifest.entryPath;
if (!entryPath) fail("plugin.json 缺少 entryPath");

const zipPath = join(root, "dist", entryPath + ".jsplugin.zip");
let zip;
try {
  zip = await JSZip.loadAsync(readFileSync(zipPath));
} catch (e) {
  fail("无法读取产物 " + zipPath + "（先执行 npm run build）: " + e.message);
}

// 必需文件
for (const required of ["plugin.json", "main.js", "static/index.html"]) {
  if (!zip.file(required)) fail("zip 内缺少必需文件: " + required);
}

const embedded = JSON.parse(await zip.file("plugin.json").async("string"));
const entryName = embedded.main || "main.js";

// entryHash
const entryData = await zip.file(entryName)?.async("nodebuffer");
if (!entryData) fail("zip 内找不到入口文件: " + entryName);
const entryHash = sha256(entryData);

// zipHash（排除 plugin.json，目录条目跳过，按路径字节序排序）
const entries = [];
zip.forEach((relPath, file) => {
  if (file.dir) return;
  if (relPath === "plugin.json") return;
  entries.push({ relPath, file });
});
entries.sort((a, b) => Buffer.compare(Buffer.from(a.relPath, "utf8"), Buffer.from(b.relPath, "utf8")));

let canonical = "";
for (const { relPath, file } of entries) {
  const buf = await file.async("nodebuffer");
  canonical += relPath + "\n" + sha256(buf) + "\n";
}
const zipHash = sha256(Buffer.from(canonical, "utf8"));

// 清单字段合法性与一致性
for (const field of ["entryHash", "zipHash"]) {
  const value = embedded[field];
  if (!value) fail("plugin.json 缺少 " + field);
  if (!/^[0-9a-f]{64}$/.test(value)) fail(field + " 不是 64 位小写 hex: " + value);
}
if (embedded.entryHash !== entryHash) fail("entryHash 不匹配：清单 " + embedded.entryHash + "，实际 " + entryHash);
if (embedded.zipHash !== zipHash) fail("zipHash 不匹配：清单 " + embedded.zipHash + "，实际 " + zipHash);

if (embedded.icon) {
  const iconPath = embedded.icon.includes("/") ? embedded.icon : "static/" + embedded.icon;
  if (!zip.file(iconPath)) fail("清单声明的 icon 不存在于 zip 内: " + iconPath);
}

const files = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
console.log("✓ 产物校验通过：" + zipPath);
console.log("  version   " + embedded.version);
console.log("  author    " + (embedded.author || "-"));
console.log("  entryHash " + entryHash);
console.log("  zipHash   " + zipHash);
console.log("  文件      " + files.join(", "));
