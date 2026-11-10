/**
 * Apple Music 客户端。
 *
 * 令牌获取方式（用户全程不需要手动抓 token）：
 *  1. 开发者令牌（Developer Token）：插件后端自动从 Apple 网页播放器
 *     (music.apple.com/{storefront}/browse) 的构建产物里提取，并按其 JWT 的 exp 缓存。
 *  2. Music-User-Token：用户在插件配置页点「登录 Apple Music」，
 *     通过 Apple 官方授权页 (authorize.music.apple.com/woa) 完成 Apple ID 登录后回传。
 *
 * 注意：网页播放器的开发者令牌带 root_https_origin=apple.com，
 * 因此所有 API 请求都必须显式带 `Origin: https://music.apple.com`，否则 401。
 */

import { Config } from "./config";

export type AppleErrorCode =
  | "auth_required"
  | "auth_expired"
  | "forbidden"
  | "rate_limited"
  | "network"
  | "token_extract_failed"
  | "api_error";

export class AppleError extends Error {
  code: AppleErrorCode;
  status: number;
  constructor(code: AppleErrorCode, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const API_BASE = "https://api.music.apple.com/v1";
const WEB_BASE = "https://music.apple.com";
const WEB_ORIGIN = "https://music.apple.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TOKEN_STORAGE_KEY = "apple-music-sync/devtoken";

export interface ApplePlaylist {
  id: string;
  name: string;
  coverUrl: string;
  trackCount: number;
}

export interface AppleTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
}

let tokenCache: { token: string; exp: number } | null = null;

function b64urlDecode(input: string): string {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) s += "===";
  return atob(s);
}

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
  } catch (e) {
    return null;
  }
}

function nowTs(): number {
  try {
    // @ts-ignore QuickJS 注入
    if (typeof __go_now_ms === "function") return __go_now_ms();
  } catch (e) {
    /* ignore */
  }
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCachedToken(): Promise<{ token: string; exp: number } | null> {
  if (tokenCache) return tokenCache;
  try {
    const raw = (await songloft.storage.get(TOKEN_STORAGE_KEY)) as { token?: string; exp?: number } | null;
    if (raw && typeof raw.token === "string" && typeof raw.exp === "number") {
      tokenCache = { token: raw.token, exp: raw.exp };
      return tokenCache;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function storeToken(token: string, exp: number): Promise<void> {
  tokenCache = { token, exp };
  try {
    await songloft.storage.set(TOKEN_STORAGE_KEY, { token, exp });
  } catch (e) {
    songloft.log.warn("缓存开发者令牌失败: " + e);
  }
}

function extractTokenFromJs(js: string): { token: string; exp: number } | null {
  const re = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  let match: RegExpExecArray | null;
  let best: { token: string; exp: number } | null = null;
  const now = nowTs() / 1000;
  while ((match = re.exec(js)) !== null) {
    const token = match[0];
    const payload = jwtPayload(token);
    if (!payload || payload.iss !== "AMPWebPlay") continue;
    const exp = typeof payload.exp === "number" ? payload.exp : 0;
    if (exp <= now + 300) continue;
    if (!best || exp > best.exp) best = { token, exp };
  }
  return best;
}

async function fetchText(url: string, timeoutMs = 25000): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/javascript,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "X-Fetch-Timeout-Ms": String(timeoutMs),
    },
  });
  if (!resp.ok) {
    throw new AppleError("network", "拉取 Apple 网页失败: HTTP " + resp.status, resp.status);
  }
  return await resp.text();
}

/** 读取 JWT 的过期时间（秒），解析失败返回 0。 */
export function jwtExpiry(token: string): number {
  const payload = jwtPayload(token);
  return payload && typeof payload.exp === "number" ? payload.exp : 0;
}

/** 自动获取 Apple 网页播放器使用的开发者令牌。 */
export async function getDeveloperToken(cfg: Config, force = false): Promise<string> {
  if (cfg.devToken) return cfg.devToken;

  const cached = await loadCachedToken();
  if (!force && cached && cached.exp > nowTs() / 1000 + 300) return cached.token;

  const storefronts = [cfg.storefront || "cn", "us", "cn", "gb", "jp"].filter(
    (v, i, arr) => arr.indexOf(v) === i
  );
  let lastError: unknown = null;

  for (const sf of storefronts) {
    try {
      const html = await fetchText(WEB_BASE + "/" + sf + "/browse");
      const bundles: string[] = [];
      const re = /\/assets\/[A-Za-z0-9_.~-]+\.js/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const path = m[0];
        if (path.indexOf("index") === -1 && bundles.length >= 6) continue;
        if (bundles.indexOf(path) === -1) bundles.push(path);
        if (bundles.length >= 8) break;
      }
      // 优先加载 index~hash.js（网页播放器主包，令牌在其中的概率最高）
      bundles.sort((a, b) => (a.indexOf("index") === -1 ? 1 : 0) - (b.indexOf("index") === -1 ? 1 : 0));

      for (const b of bundles) {
        const js = await fetchText(WEB_BASE + b, 30000);
        const found = extractTokenFromJs(js);
        if (found) {
          await storeToken(found.token, found.exp);
          songloft.log.info(
            "已获取 Apple 开发者令牌（区域 " + sf + "，有效期至 " +
              new Date(found.exp * 1000).toISOString().slice(0, 10) + "）"
          );
          return found.token;
        }
      }
      lastError = new AppleError(
        "token_extract_failed",
        "Apple 网页构建产物中未找到 WebPlay 开发者令牌（区域 " + sf + "）"
      );
    } catch (e) {
      lastError = e;
    }
  }

  if (lastError instanceof AppleError) throw lastError;
  throw new AppleError("token_extract_failed", "无法获取 Apple 开发者令牌: " + lastError);
}

export class AppleClient {
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private async token(force = false): Promise<string> {
    return await getDeveloperToken(this.cfg, force);
  }

  private buildUrl(path: string): string {
    if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) return path;
    if (path.indexOf("/v1/") === 0) return "https://api.music.apple.com" + path;
    return API_BASE + path;
  }

  /** 发一个带鉴权的 Apple Music API 请求，返回 JSON。 */
  async request(path: string, opts?: { method?: string; retry?: boolean }): Promise<any> {
    const method = (opts && opts.method) || "GET";
    const retry = opts ? opts.retry !== false : true;
    let attempt = 0;
    let forceToken = false;

    while (attempt < 3) {
      attempt++;
      const token = await this.token(forceToken);
      const headers: Record<string, string> = {
        Authorization: "Bearer " + token,
        Origin: WEB_ORIGIN,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "X-Fetch-Timeout-Ms": "25000",
      };
      if (this.cfg.userToken) headers["Music-User-Token"] = this.cfg.userToken;

      let resp: any;
      try {
        resp = await fetch(this.buildUrl(path), { method, headers });
      } catch (e) {
        if (attempt >= 3 || !retry) {
          throw new AppleError("network", "访问 Apple Music 失败: " + e);
        }
        await sleep(1200 * attempt);
        continue;
      }

      if (resp.status === 401) {
        // 开发者令牌可能已过期：强制刷新一次再试
        if (!forceToken && this.cfg.devToken === "") {
          forceToken = true;
          tokenCache = null;
          try {
            await songloft.storage.delete(TOKEN_STORAGE_KEY);
          } catch (e) {
            /* ignore */
          }
          continue;
        }
        throw new AppleError("auth_expired", "Apple Music 登录状态已失效，请重新授权", 401);
      }
      if (resp.status === 403) {
        throw new AppleError("forbidden", "Apple Music 拒绝了请求（可能需要订阅 Apple Music 或更换商店区域）", 403);
      }
      if (resp.status === 429) {
        if (attempt < 3 && retry) {
          await sleep(3000 * attempt);
          continue;
        }
        throw new AppleError("rate_limited", "Apple Music 接口限流，请稍后再试", 429);
      }
      if (resp.status >= 500 && attempt < 3 && retry) {
        await sleep(1500 * attempt);
        continue;
      }
      if (!resp.ok) {
        let detail = "";
        try {
          const text = await resp.text();
          detail = text.slice(0, 200);
        } catch (e) {
          /* ignore */
        }
        throw new AppleError("api_error", "Apple Music 接口返回 " + resp.status + " " + detail, resp.status);
      }
      try {
        return await resp.json();
      } catch (e) {
        return {};
      }
    }
    throw new AppleError("network", "访问 Apple Music 失败（重试次数已用尽）");
  }

  /** 校验 Music-User-Token 是否可用，并返回商店区域。 */
  async verifyUserToken(userToken: string): Promise<{ storefront: string }> {
    const saved = this.cfg.userToken;
    this.cfg.userToken = userToken;
    try {
      const resp = await this.request("/me/storefront", { retry: false });
      let storefront = "";
      const data = (resp && resp.data) || [];
      if (data.length && data[0] && data[0].id) storefront = String(data[0].id);
      if (!storefront) {
        const lists = await this.request("/me/library/playlists?limit=1", { retry: false });
        if (!lists || !lists.data) throw new AppleError("auth_expired", "Music User Token 无效", 401);
      }
      return { storefront };
    } finally {
      this.cfg.userToken = saved;
    }
  }

  /** 拉取资料库全部歌单（自动翻页）。 */
  async libraryPlaylists(): Promise<ApplePlaylist[]> {
    const out: ApplePlaylist[] = [];
    let path = "/me/library/playlists?limit=100";
    let guard = 0;
    while (path && guard < 30) {
      guard++;
      const resp = await this.request(path);
      const data = (resp && resp.data) || [];
      for (const item of data) {
        const attrs = item.attributes || {};
        let cover = "";
        if (attrs.artwork && attrs.artwork.url) cover = String(attrs.artwork.url).replace("{w}", "400").replace("{h}", "400");
        out.push({
          id: String(item.id),
          name: String(attrs.name || "未命名歌单"),
          coverUrl: cover,
          trackCount: Number(attrs.trackCount || 0),
        });
      }
      path = resp && resp.next ? String(resp.next) : "";
      if (path && path.charAt(0) === "/" && path.indexOf("/v1/") !== 0) path = "/v1" + path;
    }
    return out;
  }

  /** 拉取某个资料库歌单的全部曲目（自动翻页）。 */
  async playlistTracks(playlistId: string, onPage?: (count: number) => void): Promise<AppleTrack[]> {
    const out: AppleTrack[] = [];
    let path = "/me/library/playlists/" + encodeURIComponent(playlistId) + "/tracks?limit=100";
    let guard = 0;
    while (path && guard < 60) {
      guard++;
      const resp = await this.request(path);
      const data = (resp && resp.data) || [];
      for (const item of data) {
        const attrs = item.attributes || {};
        const type = String(item.type || "");
        if (type && type.indexOf("song") === -1 && type.indexOf("music-video") === -1) continue;
        out.push({
          id: String(item.id),
          title: String(attrs.name || ""),
          artist: String(attrs.artistName || ""),
          album: String(attrs.albumName || ""),
          durationMs: Number(attrs.durationInMillis || 0),
        });
        if (onPage) onPage(out.length);
      }
      path = resp && resp.next ? String(resp.next) : "";
      if (path && path.charAt(0) === "/" && path.indexOf("/v1/") !== 0) path = "/v1" + path;
    }
    return out;
  }
}

/** 曲目快照哈希（FNV-1a），用于判断 Apple 歌单内容是否发生变化。 */
export function tracksHash(tracks: AppleTrack[]): string {
  let h = 0x811c9dc5;
  for (const t of tracks) {
    const line = t.id + "\u0001" + t.title + "\u0001" + t.artist + "\u0001" + t.album;
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  }
  return tracks.length + "-" + h.toString(16);
}
