/**
 * 配置与持久化。
 *
 * 配置存在 songloft.storage（插件私有存储）里，键 `apple-music-sync/config`。
 * 令牌（Apple Music Music-User-Token）与常规配置放在一起，但返回给前端时会脱敏。
 */

export interface PlaylistState {
  /** 是否参与自动同步 */
  enabled: boolean;
  /** Apple Music 歌单名（缓存，用于生成 Songloft 歌单名与日志） */
  name: string;
  /** 最近一次成功同步的时间（ISO 字符串） */
  lastSyncAt?: string;
  /** 最近一次检查（无论是否发生变化） */
  lastCheckAt?: string;
  /** 曲目快照哈希，用于检测 Apple Music 侧是否发生变化 */
  lastHash?: string;
  /** Apple Music 曲目总数 */
  total?: number;
  /** 成功匹配到 Songloft 歌曲的数量 */
  matched?: number;
  /** 目标 Songloft 歌单 id */
  songloftPlaylistId?: number;
  /** 最近一次错误信息 */
  lastError?: string;
}

export interface Config {
  v: number;
  /** 是否开启自动同步 */
  autoSync: boolean;
  /** 轮询间隔（分钟） */
  intervalMinutes: number;
  /** Songloft 歌单名前缀 */
  playlistPrefix: string;
  /** 匹配阈值 0.5 - 1.0 */
  matchThreshold: number;
  /** 严格匹配：标题必须高度一致，且不剥离括号/后缀 */
  strictMatch: boolean;
  /** 是否移除 Apple Music 歌单里已经不存在的曲目 */
  pruneMissing: boolean;
  /** 是否自动纳管 Apple Music 里新增的歌单 */
  autoIncludeNew: boolean;
  /** Apple Music 商店区域（us / cn / jp ...） */
  storefront: string;
  /** 高级：自定义开发者令牌（留空则自动从 Apple 网页播放器获取） */
  devToken: string;
  /** Apple Music Music-User-Token（登录授权后写入） */
  userToken: string;
  /** 授权时间 */
  authorizedAt?: string;
  /** 各 Apple Music 歌单的同步状态，键为 Apple 歌单 id */
  playlists: Record<string, PlaylistState>;
}

export const DEFAULT_CONFIG: Config = {
  v: 1,
  autoSync: true,
  intervalMinutes: 60,
  playlistPrefix: "",
  matchThreshold: 0.8,
  strictMatch: false,
  pruneMissing: true,
  autoIncludeNew: true,
  storefront: "cn",
  devToken: "",
  userToken: "",
  playlists: {},
};

const STORAGE_KEY = "apple-music-sync/config";

let cache: Config | null = null;

function clamp(n: number, min: number, max: number): number {
  if (typeof n !== "number" || isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 合并默认值 + 清洗字段，避免旧版本配置缺字段或非法值。 */
export function normalizeConfig(raw: unknown): Config {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Config>;
  const merged: Config = { ...DEFAULT_CONFIG, ...r };
  merged.playlists = r.playlists && typeof r.playlists === "object" ? r.playlists : {};
  merged.autoSync = !!merged.autoSync;
  merged.intervalMinutes = Math.round(clamp(merged.intervalMinutes, 5, 1440));
  merged.matchThreshold = clamp(merged.matchThreshold, 0.5, 1);
  merged.strictMatch = !!merged.strictMatch;
  merged.pruneMissing = !!merged.pruneMissing;
  merged.autoIncludeNew = !!merged.autoIncludeNew;
  merged.storefront = typeof merged.storefront === "string" && /^[a-z]{2}$/.test(merged.storefront) ? merged.storefront : "cn";
  merged.playlistPrefix = typeof merged.playlistPrefix === "string" ? merged.playlistPrefix.slice(0, 40) : "";
  merged.devToken = typeof merged.devToken === "string" ? merged.devToken.trim() : "";
  merged.userToken = typeof merged.userToken === "string" ? merged.userToken.trim() : "";
  return merged;
}

export async function loadConfig(force = false): Promise<Config> {
  if (cache && !force) return cache;
  let raw: unknown = null;
  try {
    raw = await songloft.storage.get(STORAGE_KEY);
  } catch (e) {
    songloft.log.warn("读取配置失败: " + e);
  }
  cache = normalizeConfig(raw);
  return cache;
}

export async function saveConfig(cfg: Config): Promise<void> {
  cache = cfg;
  try {
    await songloft.storage.set(STORAGE_KEY, cfg);
  } catch (e) {
    songloft.log.error("保存配置失败: " + e);
  }
}

/** 当前内存里的配置（同步任务与 HTTP 处理共用）。 */
export function currentConfig(): Config {
  return cache || DEFAULT_CONFIG;
}

export function patchPlaylistState(cfg: Config, id: string, patch: Partial<PlaylistState>): void {
  const prev: PlaylistState = cfg.playlists[id] || { enabled: true, name: "" };
  cfg.playlists[id] = { ...prev, ...patch };
}

/** 给前端的安全视图：令牌只返回是否存在的标记。 */
export function publicConfig(cfg: Config): Record<string, unknown> {
  return {
    autoSync: cfg.autoSync,
    intervalMinutes: cfg.intervalMinutes,
    playlistPrefix: cfg.playlistPrefix,
    matchThreshold: cfg.matchThreshold,
    strictMatch: cfg.strictMatch,
    pruneMissing: cfg.pruneMissing,
    autoIncludeNew: cfg.autoIncludeNew,
    storefront: cfg.storefront,
    authorized: !!cfg.userToken,
    userTokenHint: cfg.userToken ? cfg.userToken.slice(0, 6) + "…" : "",
    authorizedAt: cfg.authorizedAt || "",
    hasCustomDevToken: !!cfg.devToken,
    playlists: cfg.playlists,
  };
}

/** 应用前端提交的配置补丁（只接受白名单字段）。 */
export function applyConfigPatch(cfg: Config, patch: Record<string, unknown>): Config {
  if (!patch || typeof patch !== "object") return cfg;
  if ("autoSync" in patch) cfg.autoSync = !!patch.autoSync;
  if ("intervalMinutes" in patch) cfg.intervalMinutes = Math.round(clamp(Number(patch.intervalMinutes), 5, 1440));
  if ("playlistPrefix" in patch && typeof patch.playlistPrefix === "string") cfg.playlistPrefix = patch.playlistPrefix.slice(0, 40);
  if ("matchThreshold" in patch) cfg.matchThreshold = clamp(Number(patch.matchThreshold), 0.5, 1);
  if ("strictMatch" in patch) cfg.strictMatch = !!patch.strictMatch;
  if ("pruneMissing" in patch) cfg.pruneMissing = !!patch.pruneMissing;
  if ("autoIncludeNew" in patch) cfg.autoIncludeNew = !!patch.autoIncludeNew;
  if ("storefront" in patch && typeof patch.storefront === "string" && /^[a-z]{2}$/.test(patch.storefront)) {
    cfg.storefront = patch.storefront;
  }
  if ("devToken" in patch && typeof patch.devToken === "string") cfg.devToken = patch.devToken.trim();
  return cfg;
}
