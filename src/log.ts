/** 轻量运行日志：内存环形缓冲 + 落盘（方便插件休眠苏醒后仍能看到最近记录）。 */

export interface LogEntry {
  t: number;
  level: "info" | "warn" | "error";
  msg: string;
}

const MAX = 300;
const STORAGE_KEY = "apple-music-sync/logs";

const buffer: LogEntry[] = [];
let loaded = false;
let dirty = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = (await songloft.storage.get(STORAGE_KEY)) as LogEntry[] | null;
    if (raw && raw.length) {
      for (const e of raw) if (buffer.length < MAX) buffer.push(e);
    }
  } catch (e) {
    /* ignore */
  }
}

function fmt(entry: LogEntry): string {
  const d = new Date(entry.t);
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds()) +
    " [" +
    entry.level +
    "] " +
    entry.msg
  );
}

async function persist(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await songloft.storage.set(STORAGE_KEY, buffer.slice(-80));
  } catch (e) {
    /* ignore */
  }
}

export function push(level: LogEntry["level"], msg: string): void {
  const entry: LogEntry = { t: Date.now(), level, msg: String(msg) };
  buffer.push(entry);
  while (buffer.length > MAX) buffer.shift();
  dirty = true;
  if (level === "error") songloft.log.error(msg);
  else if (level === "warn") songloft.log.warn(msg);
  else songloft.log.info(msg);
  // 不 await：避免日志拖慢业务
  persist();
}

export const log = {
  info: (msg: string) => push("info", msg),
  warn: (msg: string) => push("warn", msg),
  error: (msg: string) => push("error", msg),
};

export async function recentLogs(limit = 120): Promise<{ t: number; level: string; msg: string; text: string }[]> {
  await ensureLoaded();
  const out = buffer.slice(-limit).map((e) => ({ t: e.t, level: e.level, msg: e.msg, text: fmt(e) }));
  return out.reverse();
}

export async function initLogs(): Promise<void> {
  await ensureLoaded();
}
