/** 同步引擎：拉取 Apple Music 歌单 → 匹配本地曲库 → 写入 Songloft 歌单。 */

import type { Playlist, Song } from "@songloft/plugin-sdk";
import type { Config } from "./config";
import { patchPlaylistState, saveConfig } from "./config";
import { AppleClient, AppleError, type ApplePlaylist, type AppleTrack, tracksHash } from "./apple";
import { buildIndex, matchTrack, type MatchIndex } from "./matcher";
import { log } from "./log";

export interface UnmatchedTrack {
  title: string;
  artist: string;
}

export interface SyncResult {
  id: string;
  name: string;
  status: "synced" | "skipped" | "empty" | "no_match" | "error";
  total: number;
  matched: number;
  added: number;
  removed: number;
  playlistId?: number;
  unmatched: UnmatchedTrack[];
  error?: string;
  startedAt: number;
  durationMs: number;
}

export interface JobState {
  running: boolean;
  trigger: string;
  startedAt: number;
  finishedAt: number;
  current: string;
  donePlaylists: number;
  totalPlaylists: number;
  results: SyncResult[];
  error: string;
}

export const job: JobState = {
  running: false,
  trigger: "",
  startedAt: 0,
  finishedAt: 0,
  current: "",
  donePlaylists: 0,
  totalPlaylists: 0,
  results: [],
  error: "",
};

const STATE_KEY = "apple-music-sync/last-run";

/** 曲库索引缓存：一次同步任务内复用，跨任务最多缓存 10 分钟。 */
let indexCache: MatchIndex | null = null;
let indexCacheAt = 0;
let playlistCache: { list: Playlist[]; at: number } | null = null;

export function invalidatePlaylistCache(): void {
  playlistCache = null;
}

async function songloftPlaylists(): Promise<Playlist[]> {
  const now = Date.now();
  if (playlistCache && now - playlistCache.at < 20000) return playlistCache.list;
  const list = (await songloft.playlists.list()) || [];
  playlistCache = { list, at: now };
  return list;
}

async function loadLibraryIndex(force = false): Promise<MatchIndex> {
  const now = Date.now();
  if (!force && indexCache && now - indexCacheAt < 10 * 60 * 1000) return indexCache;

  log.info("正在读取 Songloft 本地曲库，建立匹配索引…");
  const songs: Song[] = [];
  const pageSize = 2000;
  let offset = 0;
  let lastFirstId = -1;
  for (let page = 0; page < 200; page++) {
    const batch = await songloft.songs.list({ limit: pageSize, offset });
    if (!batch || !batch.length) break;
    // 宿主若忽略 offset 会返回同一页，检测到重复即停止，避免死循环
    if (page > 0 && batch[0] && batch[0].id === lastFirstId) break;
    lastFirstId = batch[0] ? batch[0].id : -1;
    for (let i = 0; i < batch.length; i++) songs.push(batch[i]);
    offset += batch.length;
  }
  const index = buildIndex(songs);
  indexCache = index;
  indexCacheAt = now;
  log.info("曲库索引完成：可匹配歌曲 " + index.refs.length + " 首（总读取 " + songs.length + " 首）");
  return index;
}

function uniqueIds(ids: number[]): number[] {
  const seen: Record<number, boolean> = {};
  const out: number[] = [];
  for (const id of ids) {
    if (!seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  }
  return out;
}

interface WriteResult {
  added: number;
  removed: number;
}

/** 把目标歌曲集合写入指定歌单（优先用宿主的原子 replaceSongs）。 */
async function writePlaylistSongs(playlistId: number, desired: number[], prune: boolean): Promise<WriteResult> {
  const api = songloft.playlists as unknown as Record<string, unknown>;

  if (typeof api.replaceSongs === "function") {
    const before = await songloft.playlists.getSongs(playlistId, { limit: 100000 });
    const beforeIds = before.map((s) => s.id);
    try {
      await (api.replaceSongs as (id: number, ids: number[]) => Promise<void>).call(
        songloft.playlists,
        playlistId,
        desired
      );
      let added = 0;
      for (const id of desired) if (beforeIds.indexOf(id) === -1) added++;
      let removed = 0;
      for (const id of beforeIds) if (desired.indexOf(id) === -1) removed++;
      invalidatePlaylistCache();
      return { added, removed };
    } catch (e) {
      log.warn("宿主 replaceSongs 调用失败，回退到差集增删: " + e);
    }
  }

  // 兼容旧宿主：按差集增删 + 重排
  const current = await songloft.playlists.getSongs(playlistId, { limit: 100000 });
  const currentIds = uniqueIds(current.map((s) => s.id));

  let removed = 0;
  if (prune) {
    const toRemove = currentIds.filter((id) => desired.indexOf(id) === -1);
    if (toRemove.length) {
      await songloft.playlists.removeSongs(playlistId, toRemove);
      removed = toRemove.length;
    }
  }

  const toAdd = desired.filter((id) => currentIds.indexOf(id) === -1);
  let added = 0;
  if (toAdd.length) {
    const res = await songloft.playlists.addSongs(playlistId, toAdd);
    added = res && typeof res.added === "number" ? res.added : toAdd.length;
  }

  invalidatePlaylistCache();

  // 顺序对齐（只有数量一致时宿主才允许 reorder）
  const after = await songloft.playlists.getSongs(playlistId, { limit: 100000 });
  const afterIds = uniqueIds(after.map((s) => s.id));
  if (afterIds.length === desired.length) {
    let same = true;
    for (let i = 0; i < desired.length; i++) {
      if (afterIds[i] !== desired[i]) {
        same = false;
        break;
      }
    }
    if (!same) await songloft.playlists.reorder(playlistId, desired);
  }
  return { added, removed };
}

async function ensureTargetPlaylist(name: string, description: string, coverUrl: string): Promise<Playlist> {
  const list = await songloftPlaylists();
  for (const p of list) {
    if (p.name === name && p.type !== "radio") return p;
  }
  const created = await songloft.playlists.create({
    name,
    description,
    ...(coverUrl ? { coverUrl } : {}),
  });
  invalidatePlaylistCache();
  return created;
}

function targetPlaylistName(prefix: string, appleName: string): string {
  const base = appleName.trim() || "未命名歌单";
  return (prefix + base).slice(0, 200);
}

async function syncOnePlaylist(
  cfg: Config,
  client: AppleClient,
  pl: ApplePlaylist,
  force: boolean,
  onProgress: (matched: number) => void
): Promise<SyncResult> {
  const startedAt = Date.now();
  const state = cfg.playlists[pl.id] || { enabled: true, name: pl.name };
  const result: SyncResult = {
    id: pl.id,
    name: pl.name,
    status: "skipped",
    total: 0,
    matched: 0,
    added: 0,
    removed: 0,
    unmatched: [],
    startedAt,
    durationMs: 0,
  };

  try {
    const tracks = await client.playlistTracks(pl.id);
    result.total = tracks.length;
    const hash = tracksHash(tracks);

    patchPlaylistState(cfg, pl.id, {
      name: pl.name,
      total: tracks.length,
      lastCheckAt: new Date().toISOString(),
    });

    if (tracks.length === 0) {
      result.status = "empty";
      patchPlaylistState(cfg, pl.id, { lastHash: hash, matched: 0, lastError: "" });
      log.info("Apple 歌单「" + pl.name + "」为空，跳过");
      return result;
    }

    if (!force && state.lastHash === hash && state.lastSyncAt) {
      result.status = "skipped";
      result.matched = Number(state.matched || 0);
      log.info("Apple 歌单「" + pl.name + "」无变化（" + tracks.length + " 首）");
      return result;
    }

    const index = await loadLibraryIndex();
    const used: Record<number, boolean> = {};
    const desired: number[] = [];
    for (const track of tracks) {
      const hit = matchTrack(track, index, { threshold: cfg.matchThreshold, strict: cfg.strictMatch });
      if (!hit) {
        if (result.unmatched.length < 100) result.unmatched.push({ title: track.title, artist: track.artist });
        continue;
      }
      const ref = index.refs[hit.index];
      if (used[ref.id]) continue;
      used[ref.id] = true;
      desired.push(ref.id);
      if (desired.length % 25 === 0) onProgress(desired.length);
    }
    result.matched = desired.length;
    onProgress(desired.length);

    if (!desired.length) {
      result.status = "no_match";
      patchPlaylistState(cfg, pl.id, {
        lastHash: hash,
        matched: 0,
        lastError: "没有匹配到任何本地歌曲",
      });
      log.warn("Apple 歌单「" + pl.name + "」的 " + tracks.length + " 首曲目都没有匹配到本地歌曲");
      return result;
    }

    const name = targetPlaylistName(cfg.playlistPrefix, pl.name);
    const target = await ensureTargetPlaylist(
      name,
      "由 Apple Music 歌单「" + pl.name + "」自动同步（" + desired.length + "/" + tracks.length + " 首匹配）",
      pl.coverUrl
    );
    result.playlistId = target.id;

    const write = await writePlaylistSongs(target.id, desired, cfg.pruneMissing);
    result.added = write.added;
    result.removed = write.removed;
    result.status = "synced";

    patchPlaylistState(cfg, pl.id, {
      lastHash: hash,
      matched: desired.length,
      lastSyncAt: new Date().toISOString(),
      songloftPlaylistId: target.id,
      lastError: "",
    });

    log.info(
      "已同步「" + pl.name + "」→ Songloft 歌单「" + name + "」：匹配 " + desired.length + "/" + tracks.length +
        "，新增 " + write.added + "，移除 " + write.removed
    );
  } catch (e) {
    const err = e as Error;
    result.status = "error";
    result.error = err && err.message ? err.message : String(e);
    patchPlaylistState(cfg, pl.id, { lastError: result.error });
    log.error("同步 Apple 歌单「" + pl.name + "」失败: " + result.error);
    throw e;
  } finally {
    result.durationMs = Date.now() - startedAt;
  }
  return result;
}

async function persistLastRun(summary: Record<string, unknown>): Promise<void> {
  try {
    await songloft.storage.set(STATE_KEY, summary);
  } catch (e) {
    /* ignore */
  }
}

interface StartOptions {
  ids?: string[] | null;
  force?: boolean;
  trigger?: string;
  includeNew?: boolean;
}

/** 启动一次同步任务：立即返回，真正的同步在后台进行。 */
export function startSync(cfg: Config, opts: StartOptions): JobState {
  if (job.running) {
    throw new Error("同步任务正在运行中，请稍后再试");
  }
  job.running = true;
  job.trigger = opts.trigger || "manual";
  job.startedAt = Date.now();
  job.finishedAt = 0;
  job.current = "";
  job.donePlaylists = 0;
  job.totalPlaylists = 0;
  job.results = [];
  job.error = "";

  const run = async () => {
    const startedAt = Date.now();
    try {
      if (!cfg.userToken) throw new AppleError("auth_required", "尚未授权 Apple Music，请先在插件页登录", 401);
      const client = new AppleClient(cfg);
      const all = await client.libraryPlaylists();
      const wanted = opts.ids && opts.ids.length ? opts.ids : null;

      const targets: ApplePlaylist[] = [];
      for (const p of all) {
        const st = cfg.playlists[p.id];
        if (wanted) {
          if (wanted.indexOf(p.id) !== -1) targets.push(p);
          continue;
        }
        if (st && st.enabled) targets.push(p);
        else if (!st && opts.includeNew) {
          patchPlaylistState(cfg, p.id, { enabled: true, name: p.name });
          targets.push(p);
        }
      }

      job.totalPlaylists = targets.length;
      if (!targets.length) {
        log.warn("没有需要同步的 Apple 歌单（请先在插件页勾选）");
      }

      for (const pl of targets) {
        job.current = pl.name;
        try {
          const res = await syncOnePlaylist(cfg, client, pl, !!opts.force, (n) => {
            job.current = pl.name + "（已匹配 " + n + " 首）";
          });
          job.results.push(res);
        } catch (e) {
          const err = e as Error;
          const failed: SyncResult = {
            id: pl.id,
            name: pl.name,
            status: "error",
            total: 0,
            matched: 0,
            added: 0,
            removed: 0,
            unmatched: [],
            error: err && err.message ? err.message : String(e),
            startedAt: Date.now(),
            durationMs: 0,
          };
          job.results.push(failed);
          // 鉴权失效时中断整个任务
          if (e instanceof AppleError && (e.code === "auth_expired" || e.code === "auth_required")) {
            job.error = err.message;
            break;
          }
        }
        job.donePlaylists++;
        await saveConfig(cfg);
      }
      job.current = "";
    } catch (e) {
      const err = e as Error;
      job.error = err && err.message ? err.message : String(e);
      log.error("同步任务失败: " + job.error);
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
      await saveConfig(cfg);
      await persistLastRun({
        at: new Date().toISOString(),
        trigger: job.trigger,
        ok: !job.error && job.results.every((r) => r.status !== "error"),
        error: job.error,
        durationMs: Date.now() - startedAt,
        total: job.results.length,
        synced: job.results.filter((r) => r.status === "synced").length,
        skipped: job.results.filter((r) => r.status === "skipped").length,
        failed: job.results.filter((r) => r.status === "error").length,
        matched: job.results.reduce((sum, r) => sum + r.matched, 0),
      });
    }
  };

  // 后台执行：用 setTimeout(0) 把任务甩出当前 HTTP 请求的执行上下文，
  // 既不阻塞响应（宿主对单次 onHTTPRequest 只有 30s 上限），也不受其取消影响。
  setTimeout(() => {
    run().catch((e) => {
      log.error("同步任务异常: " + e);
      job.running = false;
      job.error = String(e);
    });
  }, 0);

  return job;
}

export async function lastRunSummary(): Promise<Record<string, unknown> | null> {
  try {
    return (await songloft.storage.get(STATE_KEY)) as Record<string, unknown> | null;
  } catch (e) {
    return null;
  }
}

export function jobSnapshot(cfg: Config): Record<string, unknown> {
  return {
    running: job.running,
    trigger: job.trigger,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    current: job.current,
    donePlaylists: job.donePlaylists,
    totalPlaylists: job.totalPlaylists,
    error: job.error,
    results: job.results.slice(-20),
    autoSync: cfg.autoSync,
    intervalMinutes: cfg.intervalMinutes,
  };
}
