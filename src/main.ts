/// <reference types="@songloft/plugin-sdk" />
/**
 * Apple Music 歌单同步 —— Songloft 插件入口。
 *
 * 路由挂载在 /api/v1/jsplugin/apple-music-sync/ 下：
 *   GET  /api/config              读取配置
 *   POST /api/config              保存配置
 *   GET  /api/devtoken            获取 Apple 开发者令牌（供授权页构造请求）
 *   GET  /api/auth/status         授权状态
 *   POST /api/auth/token          保存登录后回传的 Music-User-Token
 *   POST /api/auth/logout         退出授权
 *   GET  /api/playlists           列出 Apple Music 歌单 + 同步状态
 *   POST /api/playlists/toggle    开启/关闭某个歌单的同步
 *   POST /api/sync                启动同步任务（后台运行）
 *   GET  /api/job                 同步任务进度
 *   GET  /api/last-run            上一次同步摘要
 *   GET  /api/logs                运行日志
 */

import { applyConfigPatch, currentConfig, loadConfig, publicConfig, saveConfig, type Config } from "./config";
import { AppleClient, AppleError, getDeveloperToken, jwtExpiry, type ApplePlaylist } from "./apple";
import { jobSnapshot, lastRunSummary, startSync, job } from "./sync";
import { initLogs, log, recentLogs } from "./log";

const VERSION = "2026.11.10.0";

type Handler = (req: HTTPRequest, params: Record<string, string>) => HTTPResponse | Promise<HTTPResponse>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function register(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((part) => {
      if (part.charAt(0) === ":") {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  routes.push({ method: method.toUpperCase(), regex: new RegExp("^" + pattern + "/?$"), keys, handler });
}

function json(body: unknown, status = 200): HTTPResponse {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function errorJson(code: string, message: string, status = 400): HTTPResponse {
  return json({ ok: false, code, error: message }, status);
}

function decodeUtf8(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  const bytes = body as unknown as ArrayLike<number>;
  let out = "";
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (c < 0xf0) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const cp = ((c & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      const off = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
    }
  }
  return out;
}

function readJson(req: HTTPRequest): Record<string, unknown> {
  const text = decodeUtf8(req.body);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    return {};
  }
}

// ===== 定时自动同步 =====

let autoTimer: number | null = null;
let firstTimer: number | null = null;

function clearTimers(): void {
  if (autoTimer !== null) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (firstTimer !== null) {
    clearTimeout(firstTimer);
    firstTimer = null;
  }
}

async function runAutoSync(): Promise<void> {
  const cfg = currentConfig();
  if (!cfg.autoSync || !cfg.userToken || job.running) return;
  try {
    startSync(cfg, { trigger: "auto", includeNew: cfg.autoIncludeNew, force: false });
    lastAutoRunAt = Date.now();
    log.info("自动同步已启动（间隔 " + cfg.intervalMinutes + " 分钟）");
  } catch (e) {
    log.warn("自动同步启动失败: " + e);
  }
}

function scheduleAutoSync(cfg: Config): void {
  clearTimers();
  if (!cfg.autoSync || !cfg.userToken) return;
  const intervalMs = Math.max(5, cfg.intervalMinutes) * 60 * 1000;
  autoTimer = setInterval(() => {
    runAutoSync();
  }, intervalMs) as unknown as number;
  // 启动后如果距上次同步已超过一个周期，稍后补一次
  const dueTimer = setTimeout(() => {
    const last = lastAutoRunAt;
    if (!last || Date.now() - last >= intervalMs * 0.8) runAutoSync();
  }, 40000) as unknown as number;
  firstTimer = dueTimer;
}

let lastAutoRunAt = 0;

// ===== 路由 =====

register("GET", "/api/health", () => json({ ok: true, plugin: "apple-music-sync", version: VERSION }));

register("GET", "/api/config", async () => {
  const cfg = await loadConfig();
  scheduleAutoSync(cfg);
  return json({ ok: true, config: publicConfig(cfg) });
});

register("POST", "/api/config", async (req) => {
  const cfg = await loadConfig();
  const patch = readJson(req);
  applyConfigPatch(cfg, patch);
  await saveConfig(cfg);
  scheduleAutoSync(cfg);
  log.info("配置已更新");
  return json({ ok: true, config: publicConfig(cfg) });
});

register("GET", "/api/devtoken", async () => {
  const cfg = await loadConfig();
  try {
    const token = await getDeveloperToken(cfg);
    const exp = jwtExpiry(token);
    return json({ ok: true, token, expiresAt: exp, storefront: cfg.storefront });
  } catch (e) {
    const err = e as AppleError;
    return errorJson(err.code || "token_extract_failed", err.message || String(e), 502);
  }
});

register("GET", "/api/auth/status", async () => {
  const cfg = await loadConfig();
  const result: Record<string, unknown> = {
    ok: true,
    authorized: !!cfg.userToken,
    storefront: cfg.storefront,
    authorizedAt: cfg.authorizedAt || "",
  };
  if (cfg.userToken) {
    try {
      const client = new AppleClient(cfg);
      const info = await client.verifyUserToken(cfg.userToken);
      result.verified = true;
      if (info.storefront) result.storefront = info.storefront;
    } catch (e) {
      const err = e as AppleError;
      result.verified = false;
      result.error = err.message || String(e);
      if (err.code === "auth_expired") result.authorized = false;
    }
  }
  return json(result);
});

register("POST", "/api/auth/token", async (req) => {
  const cfg = await loadConfig();
  const body = readJson(req);
  const token = typeof body.userToken === "string" ? body.userToken.trim() : "";
  if (!token) return errorJson("invalid_token", "缺少 Music-User-Token", 400);
  try {
    const client = new AppleClient(cfg);
    const info = await client.verifyUserToken(token);
    cfg.userToken = token;
    cfg.authorizedAt = new Date().toISOString();
    if (info.storefront) cfg.storefront = info.storefront;
    await saveConfig(cfg);
    scheduleAutoSync(cfg);
    log.info("Apple Music 授权成功（区域 " + cfg.storefront + "）");
    return json({ ok: true, storefront: cfg.storefront });
  } catch (e) {
    const err = e as AppleError;
    log.warn("Apple Music 授权校验失败: " + (err.message || String(e)));
    return errorJson(err.code || "auth_failed", err.message || String(e), 401);
  }
});

register("POST", "/api/auth/logout", async () => {
  const cfg = await loadConfig();
  cfg.userToken = "";
  cfg.authorizedAt = "";
  await saveConfig(cfg);
  clearTimers();
  log.info("已退出 Apple Music 授权");
  return json({ ok: true });
});

register("GET", "/api/playlists", async (req) => {
  const cfg = await loadConfig();
  if (!cfg.userToken) return json({ ok: true, authorized: false, playlists: [] });

  const client = new AppleClient(cfg);
  let appleList: ApplePlaylist[];
  try {
    appleList = await client.libraryPlaylists();
  } catch (e) {
    const err = e as AppleError;
    return errorJson(err.code || "apple_error", err.message || String(e), err.code === "auth_expired" ? 401 : 502);
  }

  const items = appleList.map((p) => {
    const st = cfg.playlists[p.id];
    return {
      id: p.id,
      name: p.name,
      coverUrl: p.coverUrl,
      trackCount: p.trackCount,
      enabled: st ? !!st.enabled : cfg.autoIncludeNew,
      managed: !!st,
      lastSyncAt: st && st.lastSyncAt ? st.lastSyncAt : "",
      lastCheckAt: st && st.lastCheckAt ? st.lastCheckAt : "",
      matched: st && typeof st.matched === "number" ? st.matched : null,
      total: st && typeof st.total === "number" ? st.total : p.trackCount || null,
      playlistId: st && st.songloftPlaylistId ? st.songloftPlaylistId : null,
      lastError: st && st.lastError ? st.lastError : "",
    };
  });
  items.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  return json({ ok: true, authorized: true, playlists: items, storefront: cfg.storefront });
});

register("POST", "/api/playlists/toggle", async (req) => {
  const cfg = await loadConfig();
  const body = readJson(req);
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return errorJson("invalid_id", "缺少歌单 id", 400);
  const enabled = !!body.enabled;
  const prev = cfg.playlists[id] || { enabled: false, name: "" };
  cfg.playlists[id] = {
    ...prev,
    enabled,
    name: typeof body.name === "string" && body.name ? body.name : prev.name,
  };
  await saveConfig(cfg);
  log.info((enabled ? "开启" : "关闭") + "同步：Apple 歌单「" + cfg.playlists[id].name + "」");
  return json({ ok: true, enabled });
});

register("POST", "/api/sync", async (req) => {
  const cfg = await loadConfig();
  const body = readJson(req);
  if (!cfg.userToken) return errorJson("auth_required", "尚未授权 Apple Music", 401);
  const ids = typeof body.id === "string" && body.id ? [body.id] : null;
  try {
    startSync(cfg, {
      ids,
      force: body.force !== false,
      trigger: "manual",
      includeNew: cfg.autoIncludeNew,
    });
  } catch (e) {
    return errorJson("busy", (e as Error).message, 409);
  }
  return json({ ok: true, job: jobSnapshot(cfg) });
});

register("GET", "/api/job", async () => {
  const cfg = await loadConfig();
  return json({ ok: true, job: jobSnapshot(cfg) });
});

register("GET", "/api/last-run", async () => {
  return json({ ok: true, lastRun: await lastRunSummary() });
});

register("GET", "/api/logs", async (req) => {
  const q = parseQuerySafe(req.query);
  const limit = Math.max(10, Math.min(200, Number(q.limit) || 100));
  return json({ ok: true, logs: await recentLogs(limit) });
});

function parseQuerySafe(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  const parts = query.split("&");
  for (const part of parts) {
    if (!part) continue;
    const idx = part.indexOf("=");
    const k = idx === -1 ? part : part.slice(0, idx);
    const v = idx === -1 ? "" : part.slice(idx + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch (e) {
      out[k] = v;
    }
  }
  return out;
}

function normalizePath(path: string): string {
  let p = path || "/";
  if (p.charAt(0) !== "/") p = "/" + p;
  if (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1);
  return p;
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  // 少数宿主会把查询串一起放进 path，这里做一次兼容拆分
  const rawPath = req.path || "/";
  const qIndex = rawPath.indexOf("?");
  const path = normalizePath(qIndex >= 0 ? rawPath.slice(0, qIndex) : rawPath);
  if (!req.query && qIndex >= 0) req.query = rawPath.slice(qIndex + 1);
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = route.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.keys.length; i++) {
      try {
        params[route.keys[i]] = decodeURIComponent(m[i + 1]);
      } catch (e) {
        params[route.keys[i]] = m[i + 1];
      }
    }
    try {
      return await route.handler(req, params);
    } catch (e) {
      const err = e as Error;
      log.error("处理 " + req.method + " " + path + " 失败: " + (err && err.message ? err.message : String(e)));
      return errorJson("internal_error", err && err.message ? err.message : String(e), 500);
    }
  }
  return errorJson("not_found", "未找到路由: " + req.method + " " + path, 404);
}

async function onInit(): Promise<void> {
  await initLogs();
  const cfg = await loadConfig(true);
  const last = (await lastRunSummary()) as { at?: string } | null;
  if (last && last.at) {
    const ts = Date.parse(last.at);
    if (!isNaN(ts)) lastAutoRunAt = ts;
  }
  scheduleAutoSync(cfg);
  log.info(
    "插件已启动（v" +
      VERSION +
      "，自动同步" +
      (cfg.autoSync ? "开启，间隔 " + cfg.intervalMinutes + " 分钟" : "关闭") +
      (cfg.userToken ? "，已授权" : "，未授权") +
      "）"
  );
}

async function onDeinit(): Promise<void> {
  clearTimers();
  log.info("插件已停止，定时同步已取消");
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
