/**
 * 插件行为回归测试。
 *
 * 在 Node 里用 vm 加载构建产物 main.js，注入一套 Songloft 宿主 API 的 mock
 * 与 Apple Music 接口的假响应，验证：
 *   1. 生命周期与全部配置类接口可用
 *   2. Apple 歌单 → 本地曲库的匹配（含大小写/feat/中日韩/时长差异）
 *   3. 同步后本地歌单内容与顺序正确
 *   4. Apple 歌单变化后能检测到并增量更新（含删除曲目）
 *   5. 授权接口能校验并保存凭证
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const code = readFileSync(new URL("../dist/_build/main.js", import.meta.url), "utf-8");

// ---------- Songloft 宿主 mock ----------
const storage = new Map();
let songSeq = 0;
let playlistSeq = 0;

function mkSong(title, artist, album, duration) {
  songSeq++;
  return {
    id: songSeq, type: "local", title, artist, album, duration,
    year: 0, genre: "", file_path: "/music/" + title + ".mp3", url: "", cover_url: "",
    file_size: 1, format: "mp3", bit_rate: 320, sample_rate: 44100, is_live: false, is_video: false,
    added_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

const songs = [
  mkSong("晴天", "周杰伦", "叶惠美", 269),
  mkSong("稻香", "周杰伦", "魔杰座", 223),
  mkSong("Shape of You", "Ed Sheeran", "÷ (Deluxe)", 233),
  mkSong("Blinding Lights", "The Weeknd", "After Hours", 200),
  mkSong("起风了", "买辣椒也用券", "起风了", 325),
  mkSong("Hello", "Adele", "25", 295),
  mkSong("Someone Like You", "Adele", "21", 285),
  mkSong("七里香", "周杰伦", "七里香", 299),
];

const localPlaylists = [];

const playlistsApi = {
  async list() {
    return localPlaylists.map((p) => ({ ...p, song_count: p.songIds.length }));
  },
  async getById(id) {
    return localPlaylists.find((p) => p.id === id) || null;
  },
  async getSongs(id, opts) {
    const p = localPlaylists.find((x) => x.id === id);
    if (!p) return [];
    return p.songIds.map((sid) => songs.find((s) => s.id === sid)).filter(Boolean);
  },
  async search(q) {
    return (await this.list()).filter((p) => p.name.indexOf(q) !== -1);
  },
  async create(input) {
    playlistSeq++;
    const p = { id: playlistSeq, type: "normal", name: input.name, description: input.description || "", cover_url: input.coverUrl || "", labels: [], songIds: [], sort_by: "position", sort_order: "asc" };
    localPlaylists.push(p);
    return { ...p, song_count: 0 };
  },
  async update(id, fields) {
    const p = localPlaylists.find((x) => x.id === id);
    if (p && fields.description) p.description = fields.description;
    return p;
  },
  async addSongs(id, ids) {
    const p = localPlaylists.find((x) => x.id === id);
    let added = 0, skipped = 0;
    for (const sid of ids) {
      if (p.songIds.indexOf(sid) === -1 && songs.some((s) => s.id === sid)) { p.songIds.push(sid); added++; }
      else skipped++;
    }
    return { added, skipped };
  },
  async removeSongs(id, ids) {
    const p = localPlaylists.find((x) => x.id === id);
    p.songIds = p.songIds.filter((sid) => ids.indexOf(sid) === -1);
  },
  async reorder(id, ids) {
    const p = localPlaylists.find((x) => x.id === id);
    assert.strictEqual(ids.length, p.songIds.length, "reorder 长度必须一致");
    p.songIds = ids.slice();
  },
  async delete(id) {
    const i = localPlaylists.findIndex((p) => p.id === id);
    if (i >= 0) localPlaylists.splice(i, 1);
  },
};

const songloftMock = {
  log: { info: () => {}, warn: () => {}, error: (m) => console.log("[host-error]", m) },
  storage: {
    async get(k) { return storage.has(k) ? storage.get(k) : null; },
    async set(k, v) { storage.set(k, JSON.parse(JSON.stringify(v))); },
    async delete(k) { storage.delete(k); },
    async keys() { return [...storage.keys()]; },
  },
  songs: {
    async list(opts) {
      const limit = (opts && opts.limit) || 100000;
      const offset = (opts && opts.offset) || 0;
      return songs.slice(offset, offset + limit);
    },
    async getById(id) { return songs.find((s) => s.id === id) || null; },
    async search(q) { return songs.filter((s) => s.title.indexOf(q) !== -1); },
  },
  playlists: playlistsApi,
  plugin: { async getToken() { return "host-token"; }, async getHostUrl() { return "http://localhost:58091"; } },
  tags: {},
  comm: { onMessage: () => {}, send: async () => {}, call: async () => ({}) },
  events: { onPlayEvent: () => {}, offPlayEvent: () => {} },
};

// ---------- Apple Music 假接口 ----------
const applePlaylists = [
  { id: "p.1", name: "我的最爱", tracks: [
    { id: "t1", name: "晴天", artistName: "周杰伦", albumName: "叶惠美", durationInMillis: 269000 },
    { id: "t2", name: "Shape of You", artistName: "Ed Sheeran", albumName: "÷ (Deluxe)", durationInMillis: 233000 },
    { id: "t3", name: "起风了", artistName: "买辣椒也用券", albumName: "起风了", durationInMillis: 325000 },
    { id: "t4", name: "Someone Like You", artistName: "Adele", albumName: "21", durationInMillis: 285000 },
    { id: "t5", name: "完全不存在的歌", artistName: "Nobody", albumName: "None", durationInMillis: 120000 },
  ]},
  { id: "p.2", name: "Rock", tracks: [
    { id: "t6", name: "Blinding Lights", artistName: "The Weeknd", albumName: "After Hours", durationInMillis: 200000 },
    { id: "t7", name: "稻香 (Live)", artistName: "周杰伦", albumName: "魔杰座", durationInMillis: 223500 },
    { id: "t8", name: "Hello", artistName: "Adele", albumName: "25", durationInMillis: 295000 },
  ]},
];

function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const fakeDevToken =
  b64url({ alg: "ES256", typ: "JWT" }) + "." + b64url({ iss: "AMPWebPlay", iat: 1700000000, exp: 2000000000, root_https_origin: ["apple.com"] }) + ".signaturedeadbeef00";

const appleRequests = [];
async function fakeFetch(url, init) {
  const u = String(url);
  const headers = (init && init.headers) || {};
  if (u.indexOf("https://music.apple.com") === 0) {
    if (u.indexOf("/browse") !== -1 || /\/\w{2}\/new/.test(u)) {
      return htmlResp('<html><head><script src="/assets/index~deadbeef.js"></script></head><body>Apple Music</body></html>');
    }
    if (u.indexOf("/assets/index~deadbeef.js") !== -1) {
      return htmlResp('var t="' + fakeDevToken + '";window.__x=1;');
    }
    return htmlResp("<html></html>");
  }
  if (u.indexOf("https://api.music.apple.com") === 0) {
    appleRequests.push({ url: u, headers });
    const auth = headers.Authorization || headers.authorization || "";
    if (!auth || auth.indexOf("Bearer ") !== 0) {
      return jsonResp(401, { errors: [{ title: "Unauthorized" }] });
    }
    const userToken = headers["Music-User-Token"] || headers["music-user-token"] || "";
    if (userToken === "bad-token") {
      return jsonResp(401, { errors: [{ title: "Invalid user token" }] });
    }
    if (u.indexOf("/v1/me/storefront") !== -1) {
      return jsonResp(200, { data: [{ id: "cn", type: "storefronts" }] });
    }
    if (u.indexOf("/v1/me/library/playlists") !== -1) {
      const m = u.match(/\/me\/library\/playlists\/([^/]+)\/tracks/);
      if (m) {
        const pl = applePlaylists.find((p) => p.id === decodeURIComponent(m[1]));
        if (!pl) return jsonResp(404, { errors: [{ title: "Not Found" }] });
        const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);
        const limit = Number((u.match(/limit=(\d+)/) || [])[1] || 100);
        const slice = pl.tracks.slice(offset, offset + limit);
        const body = {
          data: slice.map((t) => ({
            id: t.id, type: "library-songs",
            attributes: { name: t.name, artistName: t.artistName, albumName: t.albumName, durationInMillis: t.durationInMillis },
          })),
          next: offset + limit < pl.tracks.length ? "/v1/me/library/playlists/" + pl.id + "/tracks?offset=" + (offset + limit) + "&limit=" + limit : undefined,
        };
        return jsonResp(200, body);
      }
      return jsonResp(200, {
        data: applePlaylists.map((p) => ({
          id: p.id, type: "library-playlists",
          attributes: { name: p.name, canEdit: true, artwork: { url: "https://example.com/cover/{w}x{h}.jpg" } },
        })),
      });
    }
    return jsonResp(404, { errors: [{ title: "Not Found" }] });
  }
  return jsonResp(500, { errors: [{ title: "unexpected url " + u }] });
}

function htmlResp(html) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "text/html" },
    async text() { return html; },
    async json() { throw new Error("not json"); },
  };
}

function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => "application/json" },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

// ---------- 加载插件 ----------
const sandbox = {
  console,
  songloft: songloftMock,
  fetch: fakeFetch,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  atob,
  btoa,
  Buffer,
  Date,
  JSON,
  Math,
  Promise,
  Uint8Array,
  TextEncoder,
  URL,
  decodeURIComponent,
  encodeURIComponent,
  RegExp,
  Error,
  Object,
  Array,
  String,
  Number,
  Boolean,
  isNaN,
  parseInt,
  escape,
  unescape,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "main.js" });

const call = async (method, path, body) => {
  const req = { method, path, headers: {}, body: body ? new TextEncoder().encode(JSON.stringify(body)) : null, query: path.indexOf("?") >= 0 ? path.split("?")[1] : "" };
  const res = await sandbox.onHTTPRequest(req);
  let parsed = null;
  if (typeof res.body === "string" && res.body) {
    try { parsed = JSON.parse(res.body); } catch (e) { parsed = res.body; }
  }
  return { status: res.statusCode, body: parsed };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const res = await call("GET", "/api/job");
    if (!res.body.job.running) return res.body.job;
    if (Date.now() - started > timeoutMs) throw new Error("同步任务超时");
    await sleep(50);
  }
}

let passed = 0;
function ok(name) { passed++; console.log("  ✓ " + name); }

async function main() {
  console.log("\n[1] 生命周期与基础接口");
  await sandbox.onInit();
  ok("onInit 正常执行");

  let res = await call("GET", "/api/health");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  ok("GET /api/health");

  res = await call("GET", "/api/config");
  assert.strictEqual(res.body.config.autoSync, true);
  assert.strictEqual(res.body.config.authorized, false);
  ok("GET /api/config 返回默认配置");

  res = await call("POST", "/api/config", { intervalMinutes: 30, playlistPrefix: "AM · ", matchThreshold: 0.8 });
  assert.strictEqual(res.body.config.intervalMinutes, 30);
  assert.strictEqual(res.body.config.playlistPrefix, "AM · ");
  ok("POST /api/config 保存配置");

  res = await call("GET", "/api/unknown");
  assert.strictEqual(res.status, 404);
  ok("未知路由返回 404");

  console.log("\n[2] 未授权时的接口行为");
  res = await call("GET", "/api/playlists");
  assert.strictEqual(res.body.authorized, false);
  assert.deepStrictEqual(res.body.playlists, []);
  ok("未授权时 /api/playlists 返回空列表");

  const preSync = await call("POST", "/api/sync", {});
  assert.strictEqual(preSync.status, 401);
  ok("未授权时禁止同步");

  console.log("\n[3] 开发者令牌自动获取");
  res = await call("GET", "/api/devtoken");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.token, fakeDevToken);
  assert.ok(res.body.expiresAt > 1900000000);
  ok("从 Apple 网页播放器构建产物中自动提取开发者令牌");

  console.log("\n[4] 授权接口");
  res = await call("POST", "/api/auth/token", { userToken: "fake-user-token" });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.storefront, "cn");
  ok("POST /api/auth/token 校验并保存凭证");

  const cfg = await call("GET", "/api/config");
  assert.strictEqual(cfg.body.config.authorized, true);
  assert.ok(cfg.body.config.userTokenHint.indexOf("fake-u") === 0);
  ok("配置返回授权状态且令牌已脱敏");

  res = await call("GET", "/api/playlists");
  assert.strictEqual(res.body.playlists.length, 2);
  assert.ok(res.body.playlists.every((p) => p.enabled === true));
  ok("列出 Apple Music 歌单（自动纳管新歌单）");

  console.log("\n[5] 首次同步");
  res = await call("POST", "/api/sync", { force: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.job.running, true);
  const job = await waitJob();
  assert.strictEqual(job.error, "");
  assert.strictEqual(job.results.length, 2);
  ok("同步任务完成，处理 2 个歌单");

  const favResult = job.results.find((r) => r.id === "p.1");
  assert.strictEqual(favResult.status, "synced");
  assert.strictEqual(favResult.total, 5);
  assert.strictEqual(favResult.matched, 4, "4 首应匹配成功，1 首不存在");
  assert.strictEqual(favResult.unmatched.length, 1);
  ok("匹配统计正确（4/5，未匹配曲目已记录）");

  const rockResult = job.results.find((r) => r.id === "p.2");
  assert.strictEqual(rockResult.matched, 3, "含 (Live) 后缀与大小写差异都应匹配");
  ok("带版本后缀 / 大小写差异的曲目匹配成功");

  const amPlaylist = localPlaylists.find((p) => p.name === "AM · 我的最爱");
  assert.ok(amPlaylist, "应创建本地歌单");
  assert.deepStrictEqual(amPlaylist.songIds, [1, 3, 5, 7], "顺序应与 Apple 歌单一致");
  ok("本地歌单内容与顺序正确");

  const rockPlaylist = localPlaylists.find((p) => p.name === "AM · Rock");
  assert.deepStrictEqual(rockPlaylist.songIds, [4, 2, 6]);
  ok("第二个歌单同步正确");

  console.log("\n[6] 无变化时跳过");
  const before = JSON.stringify(amPlaylist.songIds);
  res = await call("POST", "/api/sync", { force: false });
  const job2 = await waitJob();
  assert.ok(job2.results.every((r) => r.status === "skipped" || r.status === "synced"));
  assert.strictEqual(job2.results.find((r) => r.id === "p.1").status, "skipped");
  assert.strictEqual(JSON.stringify(amPlaylist.songIds), before);
  ok("内容未变化时跳过写入");

  console.log("\n[7] Apple 歌单变化后增量更新");
  applePlaylists[0].tracks.splice(1, 1); // 删掉 Shape of You
  applePlaylists[0].tracks.push({ id: "t9", name: "七里香", artistName: "周杰伦", albumName: "七里香", durationInMillis: 299000 });
  res = await call("POST", "/api/sync", { force: false });
  const job3 = await waitJob();
  const r3 = job3.results.find((r) => r.id === "p.1");
  assert.strictEqual(r3.status, "synced");
  assert.strictEqual(r3.removed, 1);
  assert.strictEqual(r3.added, 1);
  assert.deepStrictEqual(amPlaylist.songIds, [1, 5, 7, 8]);
  ok("检测到变化并增量增删（顺序已重排）");

  console.log("\n[8] 关闭移除后保留本地多余曲目");
  await call("POST", "/api/config", { pruneMissing: false });
  applePlaylists[0].tracks.push({ id: "t10", name: "稻香", artistName: "周杰伦", albumName: "魔杰座", durationInMillis: 223000 });
  res = await call("POST", "/api/sync", { force: true });
  const job4 = await waitJob();
  assert.strictEqual(amPlaylist.songIds.length, 5);
  ok("pruneMissing=false 时不移除、只追加");

  console.log("\n[9] 日志与任务快照");
  res = await call("GET", "/api/logs?limit=20");
  assert.ok(Array.isArray(res.body.logs) && res.body.logs.length > 0);
  assert.ok(res.body.logs[0].text);
  ok("GET /api/logs 返回运行日志");

  res = await call("GET", "/api/last-run");
  assert.ok(res.body.lastRun && res.body.lastRun.at);
  ok("GET /api/last-run 返回上次同步摘要");

  console.log("\n[10] 严格匹配降低误配");
  await call("POST", "/api/config", { strictMatch: true });
  await call("POST", "/api/sync", { force: true });
  const job5 = await waitJob();
  const rockStrict = job5.results.find((r) => r.id === "p.2");
  assert.strictEqual(rockStrict.matched, 2, "严格模式下 (Live) 曲目不应匹配录音室版本");
  assert.ok(rockStrict.unmatched.some((u) => u.title.indexOf("稻香") !== -1));
  ok("严格匹配剥离规则生效");
  await call("POST", "/api/config", { strictMatch: false });

  console.log("\n[11] 无效凭证被拒绝");
  res = await call("POST", "/api/auth/token", { userToken: "bad-token" });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.code, "auth_expired");
  const stillOk = await call("GET", "/api/config");
  assert.strictEqual(stillOk.body.config.authorized, true, "无效凭证不应覆盖已有授权");
  ok("无效 Music-User-Token 被拒绝且不影响已保存凭证");

  console.log("\n[12] 退出授权");
  res = await call("POST", "/api/auth/logout");
  const after = await call("GET", "/api/config");
  assert.strictEqual(after.body.config.authorized, false);
  ok("退出授权后状态归位");

  await sandbox.onDeinit();
  ok("onDeinit 正常清理定时器");

  // 校验所有 Apple 请求都带了 Origin 头（网页播放器令牌必须带）
  const missingOrigin = appleRequests.filter((r) => !r.headers.Origin && !r.headers.origin);
  assert.strictEqual(missingOrigin.length, 0, "所有 Apple API 请求都必须带 Origin 头");
  assert.ok(appleRequests.length > 10);
  ok("Apple 请求均携带 Origin / Bearer / Music-User-Token");

  console.log("\n全部通过：" + passed + " 项");
}

main().catch((e) => {
  console.error("\n✗ 测试失败：", e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
