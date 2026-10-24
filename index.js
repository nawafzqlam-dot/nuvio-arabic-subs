// nuvio-arabic-subs — Stremio-protocol subtitle addon for Nuvio
// Returns ranked Arabic subtitles as clean UTF-8 SRT, so Nuvio's built-in
// "Auto Sync Subtitle" can pick and re-time the best candidate on its own.

import http from "node:http";
import { unzipSync } from "fflate";
import { configurePage } from "./configure.js";

const PORT = Number(process.env.PORT || 7700);
const UA = "NuvioArabicSubs/1.0 (+https://github.com/)";
const LANG_SUBDL = "AR";
const LANG_OS = "ar";
const LANG_WYZIE = "ar";

// ---------- small utilities ----------

const b64url = {
  enc: (s) => Buffer.from(s, "utf8").toString("base64url"),
  dec: (s) => Buffer.from(s, "base64url").toString("utf8"),
};

function envConfig() {
  return {
    subdl: process.env.SUBDL_API_KEY || "",
    os: process.env.OPENSUBTITLES_API_KEY || "",
    osUser: process.env.OPENSUBTITLES_USERNAME || "",
    osPass: process.env.OPENSUBTITLES_PASSWORD || "",
    wyzie: process.env.WYZIE_API_KEY || "",
    hi: process.env.HEARING_IMPAIRED || "exclude", // exclude | include
    max: Number(process.env.MAX_RESULTS || 20),
  };
}

function parseConfig(segment) {
  const base = envConfig();
  if (!segment) return base;
  try {
    const parsed = JSON.parse(b64url.dec(segment));
    const merged = { ...base, ...parsed };
    merged.max = Math.min(60, Math.max(3, Number(merged.max) || 20));
    merged.hi = merged.hi === "include" ? "include" : "exclude";
    return merged;
  } catch {
    return base;
  }
}

function hasAnySource(cfg) {
  return Boolean(cfg.subdl || cfg.os || cfg.wyzie);
}

// Simple TTL cache with a size cap.
class TtlCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.val;
  }
  set(key, val, ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { val, exp: Date.now() + ttlMs });
  }
}
const listCache = new TtlCache(400); // subtitle lists
const fileCache = new TtlCache(200); // extracted SRT text
const inflight = new Map(); // dedupe concurrent identical work

async function singleFlight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

// ---------- id parsing ----------
// tt1234567 | tt1234567:1:2 | tmdb:603 | tmdb:1399:1:2
function parseVideoId(type, rawId) {
  const id = decodeURIComponent(rawId);
  const parts = id.split(":");
  const out = { type: type === "tv" ? "series" : type, imdb: null, tmdb: null, season: null, episode: null };
  if (parts[0] === "tmdb") {
    out.tmdb = parts[1];
    if (parts.length >= 4) {
      out.season = Number(parts[2]);
      out.episode = Number(parts[3]);
    }
  } else if (/^tt\d+$/i.test(parts[0])) {
    out.imdb = parts[0].toLowerCase();
    if (parts.length >= 3) {
      out.season = Number(parts[1]);
      out.episode = Number(parts[2]);
    }
  }
  if (out.season != null && !out.type) out.type = "series";
  return out;
}

function parseExtra(segment) {
  const extra = {};
  if (!segment) return extra;
  for (const pair of segment.split("&")) {
    const [k, v] = pair.split("=");
    if (k) extra[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
  }
  return extra;
}

// ---------- release-name heuristics ----------

const RELEASE_TOKENS = ["web", "webrip", "web-dl", "webdl", "bluray", "blu-ray", "bdrip", "brrip", "hdtv", "amzn", "nf", "dsnp", "atvp", "hmax", "2160p", "1080p", "720p", "x264", "x265", "h264", "h265", "hevc", "remux"];

function normalizeRelease(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\.(srt|ass|ssa|vtt|zip|mkv|mp4|avi)$/i, "")
    .replace(/[._\-\s]+/g, " ")
    .trim();
}

function releaseTokens(s) {
  return new Set(normalizeRelease(s).split(" ").filter((t) => t.length > 1));
}

function releaseAffinity(candidate, filename) {
  if (!filename) return 0;
  const a = releaseTokens(candidate);
  const b = releaseTokens(filename);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common += RELEASE_TOKENS.includes(t) ? 2 : 1;
  // group names (last token) matter most
  const groupA = [...a].pop();
  const groupB = [...b].pop();
  if (groupA && groupA === groupB) common += 4;
  return common;
}

function qualityHint(release) {
  const r = normalizeRelease(release);
  let s = 0;
  if (/\b(web|webrip|web dl|webdl|amzn|nf|dsnp|atvp|hmax)\b/.test(r)) s += 2;
  if (/\b(bluray|blu ray|bdrip|brrip|remux)\b/.test(r)) s += 2;
  if (/\b(1080p|2160p)\b/.test(r)) s += 1;
  if (/\b(cam|ts|telesync|hdcam|hc)\b/.test(r)) s -= 3;
  return s;
}

// ---------- sources ----------

// SubDL — https://api.subdl.com/api/v1/subtitles  (free key from subdl.com → API)
async function searchSubdl(cfg, vid) {
  if (!cfg.subdl) return [];
  const q = new URLSearchParams({ api_key: cfg.subdl, languages: LANG_SUBDL, subs_per_page: "30" });
  if (vid.imdb) q.set("imdb_id", vid.imdb);
  else if (vid.tmdb) q.set("tmdb_id", vid.tmdb);
  else return [];
  q.set("type", vid.type === "series" ? "tv" : "movie");
  if (vid.season != null) {
    q.set("season_number", String(vid.season));
    q.set("episode_number", String(vid.episode));
  }
  const res = await fetchWithTimeout(`https://api.subdl.com/api/v1/subtitles?${q}`);
  if (!res.ok) throw new Error(`subdl ${res.status}`);
  const json = await res.json();
  if (!json || json.status === false) return [];
  const subs = Array.isArray(json.subtitles) ? json.subtitles : [];
  return subs
    .filter((s) => s && s.url)
    .filter((s) => {
      // For series, prefer exact episode files; drop full-season packs unless nothing else.
      if (vid.season == null) return true;
      if (s.full_season) return false;
      if (s.episode != null && Number(s.episode) !== vid.episode) return false;
      return true;
    })
    .map((s) => ({
      source: "subdl",
      ref: s.url, // zip path, e.g. /subtitle/123-456.zip
      release: s.release_name || s.name || "",
      hi: Boolean(s.hi),
      downloads: 0,
      author: s.author || "",
    }));
}

// OpenSubtitles REST — https://api.opensubtitles.com (free API key; optional account for more daily downloads)
const osTokenCache = new TtlCache(20);
async function osToken(cfg) {
  if (!cfg.osUser || !cfg.osPass) return null;
  const key = `${cfg.os}:${cfg.osUser}`;
  const cached = osTokenCache.get(key);
  if (cached) return cached;
  const res = await fetchWithTimeout("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    headers: { "Api-Key": cfg.os, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: cfg.osUser, password: cfg.osPass }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.token) osTokenCache.set(key, json.token, 20 * 3600 * 1000);
  return json.token || null;
}

async function searchOpenSubtitles(cfg, vid) {
  if (!cfg.os) return [];
  const q = new URLSearchParams({ languages: LANG_OS, order_by: "download_count", order_direction: "desc" });
  if (vid.imdb) {
    const num = vid.imdb.replace(/^tt0*/, "");
    if (vid.season != null) q.set("parent_imdb_id", num);
    else q.set("imdb_id", num);
  } else if (vid.tmdb) {
    if (vid.season != null) q.set("parent_tmdb_id", vid.tmdb);
    else q.set("tmdb_id", vid.tmdb);
  } else return [];
  if (vid.season != null) {
    q.set("season_number", String(vid.season));
    q.set("episode_number", String(vid.episode));
  }
  if (cfg.hi === "exclude") q.set("hearing_impaired", "exclude");
  const res = await fetchWithTimeout(`https://api.opensubtitles.com/api/v1/subtitles?${q}`, {
    headers: { "Api-Key": cfg.os, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`opensubtitles ${res.status}`);
  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : [];
  return data
    .map((d) => {
      const a = d.attributes || {};
      const f = (a.files || [])[0];
      if (!f || !f.file_id) return null;
      return {
        source: "os",
        ref: String(f.file_id),
        release: a.release || f.file_name || "",
        hi: Boolean(a.hearing_impaired),
        downloads: Number(a.download_count || 0),
        author: a.uploader?.name || "",
        ai: Boolean(a.ai_translated || a.machine_translated),
      };
    })
    .filter(Boolean);
}

// Wyzie Subs — https://sub.wyzie.io/search (free key: store.wyzie.io/redeem)
async function searchWyzie(cfg, vid) {
  if (!cfg.wyzie) return [];
  const q = new URLSearchParams({ language: LANG_WYZIE, format: "srt", key: cfg.wyzie, source: "charlie,lima" });
  if (vid.imdb) q.set("id", vid.imdb);
  else if (vid.tmdb) q.set("id", vid.tmdb);
  else return [];
  if (vid.season != null) {
    q.set("season", String(vid.season));
    q.set("episode", String(vid.episode));
  }
  const res = await fetchWithTimeout(`https://sub.wyzie.io/search?${q}`);
  if (!res.ok) throw new Error(`wyzie ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : [];
  return items
    .filter((s) => s && s.url)
    .map((s) => ({
      source: "wyzie",
      ref: s.url,
      release: s.release || s.fileName || "",
      hi: Boolean(s.isHearingImpaired),
      downloads: Number(s.downloadCount || 0),
      author: "",
      ai: Boolean(s.ai),
    }));
}

// ---------- ranking ----------

function rank(cands, cfg, extra) {
  const filename = extra.filename || "";
  const scored = [];
  for (const c of cands) {
    if (c.hi && cfg.hi === "exclude") continue;
    let score = 0;
    score += releaseAffinity(c.release, filename) * 3; // strongest signal when the player tells us the file name
    score += qualityHint(c.release);
    score += Math.min(6, Math.log10(1 + c.downloads) * 2);
    if (c.ai) score -= 4;
    if (c.hi) score -= 2;
    if (c.source === "subdl") score += 0.5; // Arabic catalogue is deep and fast
    scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // Same release from several sources: keep the best-scored copy only.
  const seen = new Set();
  const out = [];
  for (const c of scored) {
    const key = c.release ? `${normalizeRelease(c.release)}|${c.hi}` : `${c.source}:${c.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, cfg.max);
}

// ---------- SRT fetching / normalisation ----------

function decodeSubtitleBytes(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // UTF-16 BOMs
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Legacy Arabic subs are almost always Windows-1256.
    return new TextDecoder("windows-1256").decode(bytes);
  }
}

function tidySrt(text) {
  let t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // Convert WebVTT to SRT if a source handed us VTT.
  if (/^WEBVTT/m.test(t)) {
    t = t
      .replace(/^WEBVTT.*\n(?:.*\n)*?\n/, "")
      .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, "$1,$2")
      .replace(/^(\d{2}:\d{2})[,.](\d{3}) --> (\d{2}:\d{2})[,.](\d{3})/gm, "00:$1,$2 --> 00:$3,$4");
    let i = 0;
    t = t
      .split(/\n\n+/)
      .filter((b) => /-->/.test(b))
      .map((b) => (/^\d+\n/.test(b) ? b : `${++i}\n${b}`))
      .join("\n\n");
  }
  // Strip common HTML-ish tags some uploaders leave in; keep <i>.
  t = t.replace(/<\/?(font|b|u)[^>]*>/gi, "");
  return t.trim() + "\n";
}

function pickSrtFromZip(buf, vid) {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).filter((n) => /\.(srt|vtt|ass|ssa)$/i.test(n) && !n.startsWith("__MACOSX"));
  if (!names.length) throw new Error("no subtitle file in zip");
  const srt = names.filter((n) => /\.(srt|vtt)$/i.test(n));
  const pool = srt.length ? srt : names;
  if (vid && vid.season != null && pool.length > 1) {
    const pat = new RegExp(`s0*${vid.season}\\s*e0*${vid.episode}(?!\\d)`, "i");
    const hit = pool.find((n) => pat.test(n));
    if (hit) return files[hit];
  }
  // Otherwise: the biggest file is the most likely to be the real subtitle.
  pool.sort((a, b) => files[b].length - files[a].length);
  return files[pool[0]];
}

async function fetchSubtitleText(cfg, source, ref, vid) {
  const cacheKey = `${source}:${ref}`;
  const hit = fileCache.get(cacheKey);
  if (hit) return hit;
  return singleFlight(cacheKey, async () => {
    let bytes;
    if (source === "subdl") {
      const res = await fetchWithTimeout(`https://dl.subdl.com${ref.startsWith("/") ? ref : "/" + ref}`, {}, 20000);
      if (!res.ok) throw new Error(`subdl download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = /\.zip$/i.test(ref) || buf[0] === 0x50 ? pickSrtFromZip(buf, vid) : buf;
    } else if (source === "os") {
      const headers = { "Api-Key": cfg.os, "Content-Type": "application/json", Accept: "application/json" };
      const token = await osToken(cfg);
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetchWithTimeout("https://api.opensubtitles.com/api/v1/download", {
        method: "POST",
        headers,
        body: JSON.stringify({ file_id: Number(ref), sub_format: "srt" }),
      });
      if (!res.ok) throw new Error(`opensubtitles download ${res.status}`);
      const { link } = await res.json();
      if (!link) throw new Error("opensubtitles: no link (daily quota reached?)");
      const file = await fetchWithTimeout(link, {}, 20000);
      if (!file.ok) throw new Error(`opensubtitles file ${file.status}`);
      bytes = Buffer.from(await file.arrayBuffer());
    } else if (source === "wyzie") {
      const res = await fetchWithTimeout(ref, {}, 20000);
      if (!res.ok) throw new Error(`wyzie download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf[0] === 0x50 && buf[1] === 0x4b ? pickSrtFromZip(buf, vid) : buf;
    } else {
      throw new Error("unknown source");
    }
    const text = tidySrt(decodeSubtitleBytes(bytes));
    fileCache.set(cacheKey, text, 6 * 3600 * 1000);
    return text;
  });
}

// ---------- addon protocol ----------

function manifest(cfg) {
  return {
    id: "org.nuvio.arabicsubs",
    version: "1.0.0",
    name: "Arabic Subs · Auto",
    description:
      "ترجمة عربية مرتبة حسب الجودة وجاهزة للمزامنة التلقائية في Nuvio (SubDL + OpenSubtitles + Wyzie). Ranked Arabic subtitles served as clean UTF-8 SRT.",
    logo: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f1f8-1f1e6.png",
    resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt", "tmdb:"] }],
    types: ["movie", "series"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: !hasAnySource(cfg) },
  };
}

function serveToken(source, ref) {
  return b64url.enc(JSON.stringify({ s: source, r: ref }));
}

async function subtitlesHandler(cfg, cfgSegment, baseUrl, type, rawId, extraSegment) {
  const vid = parseVideoId(type, rawId);
  const extra = parseExtra(extraSegment);
  if (!vid.imdb && !vid.tmdb) return { subtitles: [] };
  if (!hasAnySource(cfg)) return { subtitles: [] };

  const key = JSON.stringify([cfgSegment || "env", vid, cfg.hi, cfg.max, extra.filename || ""]);
  const cached = listCache.get(key);
  if (cached) return cached;

  const results = await Promise.allSettled([searchSubdl(cfg, vid), searchOpenSubtitles(cfg, vid), searchWyzie(cfg, vid)]);
  const cands = [];
  const names = ["subdl", "opensubtitles", "wyzie"];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") cands.push(...r.value);
    else console.warn(`[${names[i]} error]`, r.reason?.message || r.reason);
  });
  console.log(
    `[${rawId}]`,
    results.map((r, i) => `${names[i]}=${r.status === "fulfilled" ? r.value.length : "ERR"}`).join(" "),
  );
  const ranked = rank(cands, cfg, extra);

  // Pass the video id along in the URL so zip packs can be narrowed to the episode.
  const idPart = encodeURIComponent(decodeURIComponent(rawId));
  const subtitles = ranked.map((c, i) => ({
    id: `arsub-${c.source}-${i}`,
    url: `${baseUrl}/${cfgSegment ? cfgSegment + "/" : ""}sub/${serveToken(c.source, c.ref)}/${idPart}.srt`,
    lang: "ara",
  }));
  const out = { subtitles, cacheMaxAge: 1800, staleRevalidate: 3600, staleError: 86400 };
  listCache.set(key, out, 30 * 60 * 1000);
  return out;
}

// ---------- HTTP server ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...headers,
  });
  res.end(body);
}
const json = (res, obj, status = 200, cache = "public, max-age=300") =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    const url = new URL(req.url, "http://x");
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const parts = url.pathname.split("/").filter(Boolean).map((p) => p);

    if (parts.length === 0 || parts[0] === "configure") return send(res, 200, configurePage(baseUrl), { "Content-Type": "text/html; charset=utf-8" });

    // Optional leading config segment
    let cfgSegment = "";
    if (!["manifest.json", "subtitles", "sub", "health"].includes(parts[0])) cfgSegment = parts.shift();
    const cfg = parseConfig(cfgSegment);

    if (parts[0] === "health") return json(res, { ok: true, sources: { subdl: !!cfg.subdl, opensubtitles: !!cfg.os, wyzie: !!cfg.wyzie } }, 200, "no-store");

    if (parts[0] === "configure") return send(res, 200, configurePage(baseUrl), { "Content-Type": "text/html; charset=utf-8" });

    if (parts[0] === "manifest.json") return json(res, manifest(cfg));

    if (parts[0] === "subtitles" && parts.length >= 3) {
      const type = parts[1];
      const idSeg = parts[2].replace(/\.json$/, "");
      const extraSeg = parts.length >= 4 ? parts[3].replace(/\.json$/, "") : "";
      const out = await subtitlesHandler(cfg, cfgSegment, baseUrl, type, idSeg, extraSeg);
      return json(res, out, 200, `public, max-age=${out.cacheMaxAge || 300}`);
    }

    if (parts[0] === "sub" && parts.length >= 2) {
      let tok;
      try {
        tok = JSON.parse(b64url.dec(parts[1]));
      } catch {
        return send(res, 400, "bad token");
      }
      const vid = parts[2] ? parseVideoId("", parts[2].replace(/\.srt$/, "")) : null;
      const text = await fetchSubtitleText(cfg, tok.s, tok.r, vid);
      return send(res, 200, text, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'inline; filename="arabic.srt"',
        "Cache-Control": "public, max-age=21600",
      });
    }

    return send(res, 404, "not found");
  } catch (err) {
    console.error(err);
    return send(res, 502, `error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Arabic Subs addon listening on http://localhost:${PORT}  (open /configure)`);
  startKeepAlive();
});

// Free hosts (Render, Koyeb, ...) spin the service down after ~15 min without
// inbound traffic. Hitting our own public URL every 10 min keeps it awake.
// Render sets RENDER_EXTERNAL_URL automatically; set KEEPALIVE_URL elsewhere.
function startKeepAlive() {
  const url = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  const every = Number(process.env.KEEPALIVE_MINUTES || 10) * 60 * 1000;
  const ping = async () => {
    try {
      await fetchWithTimeout(`${url.replace(/\/$/, "")}/health`, {}, 30000);
    } catch (err) {
      console.warn("[keepalive]", err.message);
    }
  };
  setInterval(ping, every).unref();
  console.log(`[keepalive] pinging ${url}/health every ${every / 60000} min`);
}
