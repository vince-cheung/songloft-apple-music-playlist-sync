/**
 * 生成 GitHub Release 的说明正文（stdout）。
 * 读取 plugin.json 与 dist/_build/plugin.json（构建时回填了 hash 的清单）。
 */
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const built = JSON.parse(readFileSync(join(root, "dist", "_build", "plugin.json"), "utf8"));
const zipPath = join(root, "dist", manifest.entryPath + ".jsplugin.zip");
const sizeKb = (statSync(zipPath).size / 1024).toFixed(1);

const permissions = (built.permissions || []).map((p) => "`" + p + "`").join("、") || "无";

console.log(`## Apple Music 歌单同步 v${built.version}

把 Apple Music 资料库里的歌单同步成 Songloft 歌单：只收录 Songloft 曲库中**已存在**的歌曲，Apple 侧歌单变化后按设定间隔自动增量同步。

### 安装

1. 下载下方的 \`${manifest.entryPath}.jsplugin.zip\`
2. Songloft → 插件管理 → 上传插件 → 启用
3. 打开插件配置页，点「登录 Apple Music」完成 Apple ID 授权（无需手动提取 token）
4. 勾选要同步的 Apple 歌单，打开「自动同步」并设置检查间隔

### 产物信息

| 字段 | 值 |
| --- | --- |
| 版本 | \`${built.version}\` |
| 入口 | \`${built.entryPath}\` |
| 最低宿主版本 | \`${built.minHostVersion || "-"}\` |
| 权限 | ${permissions} |
| 大小 | ${sizeKb} KB |
| entryHash | \`${built.entryHash}\` |
| zipHash | \`${built.zipHash}\` |

> \`entryHash\` / \`zipHash\` 由构建脚本按宿主 \`internal/jsplugin/hash.go\` 的规范化算法计算
> （zipHash 覆盖除 \`plugin.json\` 外的全部文件），并由 \`npm run verify\` 对最终 zip 复算校验。
> 手动下载后可用同目录的 \`SHA256SUMS\` 核对文件完整性。

### 校验与回归

- \`npm test\`：26 项行为回归（宿主 API mock + Apple 接口假响应）
- \`npm run verify\`：对最终 zip 复算 entryHash / zipHash，并与清单比对

### 已知限制

- 只同步资料库内的歌单，公开 catalog 歌单不在范围内
- 匹配为启发式打分；同名不同版本（现场版/录音室版）可开启「严格匹配」降低误配
- 首次同步需为曲库建索引，曲库很大时会多花几十秒（索引缓存 10 分钟）
`);
