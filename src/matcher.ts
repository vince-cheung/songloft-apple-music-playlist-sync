/**
 * Apple Music 曲目 ↔ Songloft 本地曲库的匹配。
 *
 * 纯本地计算，不额外请求宿主接口：同步开始前拉一次全库，建立轻量索引，
 * 之后每首歌用「标题 + 艺术家 + 专辑/时长」打分取最优候选。
 */

import type { AppleTrack } from "./apple";
import type { Song } from "@songloft/plugin-sdk";

export interface SongRef {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  nt: string;
  na: string;
  nalb: string;
  nlt: string;
  nla: string;
}

export interface MatchIndex {
  refs: SongRef[];
  byTitle: Record<string, number[]>;
  byLooseTitle: Record<string, number[]>;
  byKey: Record<string, number>;
  byLooseKey: Record<string, number>;
  byArtist: Record<string, number[]>;
  builtAt: number;
  total: number;
}

const ACCENT_GROUPS: Array<[RegExp, string]> = [
  [/[àáâãäåāăą]/g, "a"],
  [/[èéêëēĕėẹě]/g, "e"],
  [/[ìíîïīĭį]/g, "i"],
  [/[òóôõöōŏőø]/g, "o"],
  [/[ùúûüūŭůű]/g, "u"],
  [/[çćč]/g, "c"],
  [/[ñń]/g, "n"],
  [/[ýÿ]/g, "y"],
  [/[šś]/g, "s"],
  [/[žź]/g, "z"],
  [/[ďđ]/g, "d"],
  [/[ť]/g, "t"],
  [/æ/g, "ae"],
  [/œ/g, "oe"],
  [/ß/g, "ss"],
];

/** 归一化：小写、全角转半角、去变音符号、去标点。
 *  loose=true 时额外剥离括号内容与 remaster/live 之类的版本后缀。 */
export function normalize(input: string, loose = false): string {
  let s = String(input || "").toLowerCase();
  // 全角 ASCII → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, " ");
  // 常见弯引号 / 破折号
  s = s.replace(/[\u2018\u2019\u201b]/g, "'").replace(/[\u201c\u201d\u201f]/g, '"');
  s = s.replace(/[\u2010-\u2015]/g, "-");
  for (const pair of ACCENT_GROUPS) s = s.replace(pair[0], pair[1]);
  s = s.replace(/&/g, " and ");

  if (loose) {
    s = s.replace(/\([^)]*\)/g, " ");
    s = s.replace(/（[^）]*）/g, " ");
    s = s.replace(/\[[^\]]*\]/g, " ");
    s = s.replace(/【[^】]*】/g, " ");
    s = s.replace(/\{[^}]*\}/g, " ");
    s = s.replace(
      /\b(feat|ft|featuring|remaster|remastered|deluxe|edition|version|explicit|clean|radio edit|mono|stereo|bonus track|live at|from the)\b/g,
      " "
    );
  }
  // 只保留字母/数字/CJK/音节文字
  s = s.replace(/[^0-9a-z\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ");
  return s.trim().replace(/\s+/g, " ");
}

function tokens(s: string): string[] {
  if (!s) return [];
  const parts = s.split(" ");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && out.indexOf(parts[i]) === -1) out.push(parts[i]);
  }
  return out;
}

function bigrams(s: string): string[] {
  const clean = s.replace(/\s+/g, "");
  const out: string[] = [];
  if (clean.length <= 1) {
    if (clean) out.push(clean);
    return out;
  }
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.substr(i, 2));
  return out;
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let overlap = 0;
  for (const x of a) if (b.indexOf(x) !== -1) overlap++;
  return (2 * overlap) / (a.length + b.length);
}

/** 文本相似度 0..1：token Dice 与字符 bigram Dice 取较大值，包含关系额外加分。 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  let score = dice(ta, tb);
  const cb = dice(bigrams(a), bigrams(b));
  if (cb > score) score = cb;
  if (a.length >= 3 && b.length >= 3) {
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      score = Math.max(score, 0.82 + 0.18 * ratio);
    }
  }
  return Math.min(1, score);
}

function artistSet(artist: string): string[] {
  return tokens(
    normalize(
      String(artist || "")
        .replace(/\bfeat\b|\bft\b|\bfeaturing\b|\bwith\b|\bvs\b/g, "&")
        .replace(/[&,，、/;x×+]/g, " "),
      false
    )
  );
}

function artistSimilarity(a: string, b: string): number {
  const sa = artistSet(a);
  const sb = artistSet(b);
  if (!sa.length || !sb.length) return 0;
  let best = 0;
  for (let i = 0; i < sa.length; i++) {
    for (let j = 0; j < sb.length; j++) {
      const s = similarity(sa[i], sb[j]);
      if (s > best) best = s;
    }
  }
  return best;
}

function push(map: Record<string, number[]>, key: string, idx: number): void {
  if (!key) return;
  if (!map[key]) map[key] = [];
  const arr = map[key];
  if (arr.length < 400) arr.push(idx);
}

/** 根据本地曲库建立匹配索引。 */
export function buildIndex(songs: Song[]): MatchIndex {
  const index: MatchIndex = {
    refs: [],
    byTitle: {},
    byLooseTitle: {},
    byKey: {},
    byLooseKey: {},
    byArtist: {},
    builtAt: Date.now(),
    total: songs.length,
  };
  for (const song of songs) {
    if (!song || typeof song.id !== "number") continue;
    if (song.type === "radio" || song.is_video) continue;
    if (!song.title) continue;
    const ref: SongRef = {
      id: song.id,
      title: song.title,
      artist: song.artist || "",
      album: song.album || "",
      duration: Number(song.duration || 0),
      nt: normalize(song.title, false),
      na: normalize(song.artist || "", false),
      nalb: normalize(song.album || "", false),
      nlt: normalize(song.title, true),
      nla: normalize(song.artist || "", true),
    };
    const idx = index.refs.length;
    index.refs.push(ref);
    if (ref.nt) {
      push(index.byTitle, ref.nt, idx);
      if (!index.byKey[ref.nt + "|" + ref.na]) index.byKey[ref.nt + "|" + ref.na] = idx;
    }
    if (ref.nlt) {
      push(index.byLooseTitle, ref.nlt, idx);
      if (!index.byLooseKey[ref.nlt + "|" + ref.nla]) index.byLooseKey[ref.nlt + "|" + ref.nla] = idx;
    }
    push(index.byArtist, ref.na, idx);
  }
  return index;
}

export interface Candidate {
  index: number;
  score: number;
}

function scoreCandidate(track: AppleTrack, nt: string, nlt: string, na: string, nla: string, ref: SongRef): number {
  const titleSim = Math.max(similarity(nt, ref.nt), similarity(nlt, ref.nlt));
  const artistSim = Math.max(artistSimilarity(na, ref.na), artistSimilarity(nla, ref.nla));
  const albumSim = ref.nalb ? similarity(normalize(track.album || ""), ref.nalb) : 0;

  let durationSim = 0;
  let hasDuration = false;
  if (track.durationMs > 0 && ref.duration > 0) {
    hasDuration = true;
    const diff = Math.abs(track.durationMs / 1000 - ref.duration);
    durationSim = diff <= 3 ? 1 : diff >= 20 ? 0 : 1 - (diff - 3) / 17;
  }

  const bonus = hasDuration ? 0.7 * albumSim + 0.3 * durationSim : albumSim;
  const score = 0.62 * titleSim + 0.26 * artistSim + 0.12 * bonus;

  // 硬门槛：标题必须高度接近；艺术家完全对不上时只在标题完全一致时放行
  if (titleSim < 0.72) return 0;
  if (artistSim < 0.32 && titleSim < 0.995) return 0;
  if (hasDuration && Math.abs(track.durationMs / 1000 - ref.duration) > 45 && titleSim < 0.995) return 0;
  return score;
}

export interface MatchOptions {
  threshold: number;
  strict: boolean;
}

/** 在索引里为单首 Apple Music 曲目找最佳本地候选；找不到返回 null。 */
export function matchTrack(track: AppleTrack, index: MatchIndex, opts: MatchOptions): Candidate | null {
  const strict = !!opts.strict;
  const nt = normalize(track.title || "", false);
  // 严格模式不用「剥离括号/版本后缀」的宽松形态，避免 (Live)/(Remaster) 配到录音室版
  const nlt = strict ? nt : normalize(track.title || "", true);
  const na = normalize(track.artist || "", false);
  const nla = strict ? na : normalize(track.artist || "", true);
  if (!nt && !nlt) return null;

  const seen: Record<number, boolean> = {};
  const picks: number[] = [];

  const addAll = (arr: number[] | undefined) => {
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) {
        seen[arr[i]] = true;
        picks.push(arr[i]);
      }
    }
  };

  const exactKey = index.byKey[nt + "|" + na];
  if (typeof exactKey === "number") addAll([exactKey]);
  if (!strict) {
    const looseKey = index.byLooseKey[nlt + "|" + nla];
    if (typeof looseKey === "number") addAll([looseKey]);
  }
  addAll(index.byTitle[nt]);
  if (!strict && nlt !== nt) addAll(index.byLooseTitle[nlt]);
  addAll(index.byArtist[na]);

  // 标题 token 兜底（处理 "Song (Live)" → "Song" 之类）
  if (!picks.length && nt) {
    const first = nt.split(" ")[0];
    if (first && first.length >= 2) {
      for (let i = 0; i < index.refs.length; i++) {
        if (index.refs[i].nt.indexOf(first) === 0) {
          picks.push(i);
          if (picks.length > 300) break;
        }
      }
    }
  }

  let best: Candidate | null = null;
  for (let i = 0; i < picks.length; i++) {
    const ref = index.refs[picks[i]];
    const score = scoreCandidate(track, nt, nlt, na, nla, ref);
    if (!best || score > best.score) best = { index: picks[i], score };
  }
  if (!best) return null;

  const need = opts.strict ? Math.max(0.9, opts.threshold) : opts.threshold;
  if (best.score < need) return null;
  return best;
}
