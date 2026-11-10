# Apple Music 歌单同步（Songloft 插件）

把 Apple Music 资料库里的歌单同步成 Songloft 歌单。只收录 Songloft 曲库里**已经存在**的歌曲，Apple 侧歌单变化后按间隔自动增量同步。

- 插件版本：`2026.11.10.0`
- 最低宿主版本（`minHostVersion`）：`2.13.3`
- 入口：`apple-music-sync`

## 安装

1. Songloft → 插件管理 → 上传 `dist/apple-music-sync.jsplugin.zip`；
2. 启用插件，点击插件卡片进入配置页（`/api/v1/jsplugin/apple-music-sync/`）；
3. 点「登录 Apple Music」，在弹窗里完成 Apple ID 登录；
4. 回到页面刷新歌单列表，按需开关要同步的歌单；
5. 打开「自动同步」，设置检查间隔。

## 它做了什么

```
Apple Music /v1/me/library/playlists
        │  （后端：开发者令牌自动从 Apple 网页播放器提取 + Music-User-Token）
        ▼
   Apple 歌单与曲目（自动翻页）
        │  （匹配：标题 0.62 + 艺术家 0.26 + 专辑/时长 0.12）
        ▼
   Songloft 曲库索引（一次同步任务内构建，缓存 10 分钟）
        │
        ▼
   Songloft 歌单「前缀 + Apple 歌单名」
```

- **只匹配已存在的歌曲**：拿不到高置信匹配的曲目直接跳过，并在日志里列出歌名/艺术家。
- **不修改 Apple 侧数据**：只读取资料库，不写回。
- **歌单名**：`playlistPrefix + Apple 歌单名`，同名歌单会被复用而不是重复创建。
- **顺序对齐**：宿主支持 `playlists.replaceSongs` 时原子替换；否则用差集增删 + `reorder` 兜底。
- **变化检测**：对每个 Apple 歌单算曲目快照哈希（id/标题/艺术家/专辑）。哈希没变就只更新「上次检查」，不写歌单。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 自动同步 | 开 | 定时检查 Apple 歌单变化 |
| 检查间隔 | 60 分钟 | 5–1440 分钟 |
| 歌单名前缀 | 空 | 最终名 = 前缀 + Apple 歌单名（总长截断 200） |
| 匹配阈值 | 0.80 | 0.5–0.98，越高越严格 |
| 严格匹配 | 关 | 不剥离 `(Live)`/`(Remaster)`/feat 等后缀，阈值提升到 0.9 |
| 移除已删除曲目 | 开 | Apple 侧删掉的歌同步时也从歌单移除 |
| 自动纳管新歌单 | 开 | Apple 新建的歌单默认参与同步 |
| 商店区域 | cn | 登录后自动按 `/me/storefront` 校正 |
| 开发者令牌 | 自动 | 失败时可手动指定（高级） |

## 关于登录与令牌

用户**不需要**手动提取任何 token：

1. **开发者令牌（Developer Token）**：后端从 `https://music.apple.com/{storefront}/browse` 的构建产物里提取 `iss=AMPWebPlay` 的 JWT，按 `exp` 缓存（键 `apple-music-sync/devtoken`）。过期自动重取。
2. **Music-User-Token**：前端用开发者令牌构造 `https://authorize.music.apple.com/woa` 授权 URL，`window.open` 打开 Apple 官方登录页；登录完成后 Apple 通过 `postMessage`（JSON-RPC，`thirdPartyInfo` / `authorize`）回传令牌，插件校验并保存。

> Apple 接口的硬约束：网页播放器的开发者令牌带 `root_https_origin: ["apple.com"]`，**所有请求必须带 `Origin: https://music.apple.com`**，否则一律 401。插件已在 `AppleClient` 里统一加上。

**备用方式**：点「登录」后页面会自动展开粘贴框。若弹窗被拦、账号是网页版登录态异常、或 Apple 未回传，可在已登录 Apple Music 的浏览器里取到 `Music-User-Token` 粘贴保存（配置页同样会做 `/me/storefront` 校验，无效令牌不会落库）。

## HTTP 接口

挂在 `/api/v1/jsplugin/apple-music-sync/`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活检查 |
| GET/POST | `/api/config` | 读取 / 保存配置（白名单字段） |
| GET | `/api/devtoken` | 取开发者令牌（含过期时间） |
| GET | `/api/auth/status` | 授权状态（可选校验） |
| POST | `/api/auth/token` | { userToken } 校验并保存 |
| POST | `/api/auth/logout` | 退出授权 |
| GET | `/api/playlists` | Apple 歌单 + 同步状态 |
| POST | `/api/playlists/toggle` | { id, enabled, name? } |
| POST | `/api/sync` | { id?, force? } 启动后台同步 |
| GET | `/api/job` | 同步进度 |
| GET | `/api/last-run` | 上次同步摘要 |
| GET | `/api/logs?limit=` | 运行日志（最多 200 条） |

## 权限

`storage`、`songs.read`、`playlists.read`、`playlists.write`

不申请 `net`：对 Apple 的请求走宿主默认的 `fetch` 能力（非 `songloft.net` 通道），加载宿主页面不需要额外权限。

## 运行时行为（踩过的坑）

- 宿主对单次 `onHTTPRequest` 只有 30s 上限，同步任务用 `setTimeout(0)` 甩到后台执行，HTTP 立即返回，前端轮询 `/api/job`。
- 宿主空闲 10 分钟会卸载 VM；`setInterval` 的远端定时器会被登记并在到点前唤醒（健康检查 `wakeupLead`）。`onInit` 里比对 `last-run.at` 与间隔，落后就补跑一次。
- 所有状态（配置 / 令牌 / 日志 / 上次运行）都落 `songloft.storage`，卸载重启后不丢。
- `playlists.replaceSongs` 在 SDK 2.18 的 `index.d.ts` 里没有类型声明，但宿主 2.13.3+ 的 bridge 实际提供，因此运行时探测 + 失败回退。

## 开发

```bash
npm install          # esbuild / jszip / @songloft/plugin-builder
node build.mjs       # src/main.ts → dist/_build → dist/apple-music-sync.jsplugin.zip
node tests/run.mjs   # 24 项行为回归（宿主 mock + Apple 假接口）
```

构建脚本自己实现打包，但 `entryHash` / `zipHash` 直接调用 `@songloft/plugin-builder` 的官方实现，与宿主 `internal/jsplugin/hash.go` 的规范化算法逐字节一致（已用 Go 实现交叉验证）。

## 已知限制

- Apple Music 资料库接口只能读到自己资料库里的歌单，公开歌单（catalog）不在同步范围。
- 匹配是启发式的：同名不同版本（如现场版 vs 录音室版）在关闭「严格匹配」时可能匹配到录音室版，可在日志里核对后调高阈值或开启严格匹配。
- 曲库超大（几万首）时首次同步需要几十秒建索引，之后 10 分钟内复用。
