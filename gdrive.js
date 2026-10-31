// gdrive.js — "My Google Drive" addon (Stremio protocol) mounted at /gdrive
//
// Indexes the video files in the user's Google Drive, matches them to IMDb
// entries through Cinemeta (so Nuvio shows real posters/metadata), exposes
// them as catalogs, and streams them straight from Google with a Bearer
// token header (no proxy bandwidth). A proxied stream is offered as fallback
// for players that cannot send headers.
//
// Env:
//   GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN  (private Drive, via /gdrive/setup)
//   GDRIVE_FOLDER_ID   optional: only index this folder (recursively); default = whole Drive
//   GDRIVE_API_KEY     alternative: public "anyone with the link" folder, no OAuth (needs GDRIVE_FOLDER_ID)

import { Readable } from "node:stream";
import crypto from "node:crypto";

const UA = "NuvioGDrive/1.0";
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm|wmv|flv|mpg|mpeg)$/i;

function env() {
  return {
    clientId: process.env.GDRIVE_CLIENT_ID || "",
    clientSecret: process.env.GDRIVE_CLIENT_SECRET || "",
    refreshToken: process.env.GDRIVE_REFRESH_TOKEN || "",
    apiKey: process.env.GDRIVE_API_KEY || "",
    folderId: process.env.GDRIVE_FOLDER_ID || "",
    indexMinutes: Number(process.env.GDRIVE_INDEX_MINUTES || 15),
  };
}
const oauthMode = (c) => Boolean(c.clientId && c.clientSecret && c.refreshToken);
const keyMode = (c) => Boolean(c.apiKey && c.folderId);
export const gdriveConfigured = () => {
  const c = env();
  return oauthMode(c) || keyMode(c);
};

async function fetchT(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

// ---------- auth ----------
let tokenCache = { value: null, exp: 0 };
async function accessToken() {
  const c = env();
  if (!oauthMode(c)) return null;
  if (tokenCache.value && tokenCache.exp > Date.now() + 60_000) return tokenCache.value;
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchT("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!res.ok) throw new Error(`google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  tokenCache = { value: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function driveAuth() {
  const c = env();
  if (oauthMode(c)) return { headers: { Authorization: `Bearer ${await accessToken()}` }, query: "" };
  return { headers: {}, query: `&key=${encodeURIComponent(c.apiKey)}` };
}

// ---------- Drive listing ----------
const FIELDS = "nextPageToken,files(id,name,size,mimeType,modifiedTime,parents,thumbnailLink,videoMediaMetadata(durationMillis))";

async function listChildren(folderId, auth, kind) {
  const out = [];
  let pageToken = "";
  const q =
    kind === "folders"
      ? `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
      : `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  do {
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(FIELDS)}` +
      `&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ""}${auth.query}`;
    const res = await fetchT(url, { headers: auth.headers });
    if (!res.ok) throw new Error(`drive list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    out.push(...(json.files || []));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function listAllVideos(auth) {
  // Whole-drive query (OAuth mode without a folder).
  const out = [];
  let pageToken = "";
  const q = "mimeType contains 'video/' and trashed = false";
  do {
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(FIELDS)}` +
      `&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ""}${auth.query}`;
    const res = await fetchT(url, { headers: auth.headers });
    if (!res.ok) throw new Error(`drive list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    out.push(...(json.files || []));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function collectVideos() {
  const c = env();
  const auth = await driveAuth();
  if (!c.folderId) return listAllVideos(auth);
  const videos = [];
  const queue = [{ id: c.folderId, path: [] }];
  const seen = new Set();
  while (queue.length) {
    const { id, path } = queue.shift();
    if (seen.has(id) || path.length > 6) continue;
    seen.add(id);
    const [files, folders] = await Promise.all([listChildren(id, auth, "files"), listChildren(id, auth, "folders")]);
    for (const f of files) if (isVideo(f)) videos.push({ ...f, folderPath: path });
    for (const d of folders) queue.push({ id: d.id, path: [...path, d.name] });
  }
  return videos;
}

const isVideo = (f) => (f.mimeType || "").startsWith("video/") || VIDEO_EXT.test(f.name || "");

// ---------- filename parsing ----------
const JUNK =
  /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?\+?|dv|dolby|vision|web[- ]?dl|webrip|bluray|blu-ray|bdrip|brrip|hdtv|hdrip|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac|ac3|dts|atmos|truehd|ddp?5\.?1|5\.1|7\.1|proper|repack|extended|unrated|remastered|imax|multi|dual|arabic|ar|eng?|sub(bed|s)?|esub|msubs?|yts|yify|rarbg|amzn|nf|dsnp|atvp|hmax|hulu)\b.*$/i;

export function parseName(raw) {
  let name = (raw || "").replace(VIDEO_EXT, "");
  name = name.replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  let season = null;
  let episode = null;
  let m = name.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i) || name.match(/\b(\d{1,2})x(\d{1,3})\b/) || name.match(/\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,3})\b/i);
  if (m) {
    season = Number(m[1]);
    episode = Number(m[2]);
    name = name.slice(0, m.index);
  }
  let year = null;
  const ym = name.match(/[(\[]?\b((?:19|20)\d{2})\b[)\]]?/);
  if (ym && ym.index > 0) {
    year = Number(ym[1]);
    name = name.slice(0, ym.index);
  }
  name = name.replace(JUNK, "");
  name = name.replace(/[-–—]\s*$/, "").replace(/[()\[\]]/g, "").replace(/\s+/g, " ").trim();
  return { title: name || raw, year, season, episode, isSeries: season != null };
}

// ---------- Cinemeta matching (no API key needed) ----------
const metaCache = new Map(); // key -> {hit, exp}
async function cinemetaSearch(type, title, year) {
  const key = `${type}|${title.toLowerCase()}|${year || ""}`;
  const cached = metaCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.hit;
  let hit = null;
  try {
    const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(title)}.json`;
    const res = await fetchT(url, {}, 10000);
    if (res.ok) {
      const metas = (await res.json()).metas || [];
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim();
      const t = norm(title);
      const scored = metas
        .map((m) => {
          let s = 0;
          const n = norm(m.name);
          if (n === t) s += 5;
          else if (n.startsWith(t) || t.startsWith(n)) s += 2;
          const my = Number(String(m.releaseInfo || m.year || "").slice(0, 4));
          if (year && my) s += Math.abs(my - year) <= 1 ? 3 : -2;
          return { m, s };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      hit = scored[0]?.m || null;
    }
  } catch {
    /* offline or Cinemeta down: fall back to local meta */
  }
  metaCache.set(key, { hit, exp: Date.now() + 24 * 3600 * 1000 });
  return hit;
}

// ---------- index ----------
// movies: Map<id, {id, name, poster, year, files:[file]}>   id = tt... or gd:<fileId>
// series: Map<id, {id, name, poster, episodes: Map<"s:e", [file]>}>
let index = { movies: new Map(), series: new Map(), builtAt: 0, error: null, fileCount: 0 };
let building = null;

export async function buildIndex(force = false) {
  if (building) return building;
  const c = env();
  if (!force && Date.now() - index.builtAt < c.indexMinutes * 60 * 1000) return index;
  building = (async () => {
    try {
      const files = await collectVideos();
      const movies = new Map();
      const series = new Map();
      const slug = (s) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "-").replace(/(^-|-$)/g, "");
      // Resolve with limited concurrency to be gentle with Cinemeta.
      const parsed = files.map((f) => ({ f, p: parseName(f.name) }));
      const uniq = new Map();
      for (const { p } of parsed) {
        const k = `${p.isSeries ? "series" : "movie"}|${p.title.toLowerCase()}|${p.isSeries ? "" : p.year || ""}`;
        if (!uniq.has(k)) uniq.set(k, p);
      }
      const keys = [...uniq.keys()];
      const hits = new Map();
      let i = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (i < keys.length) {
            const k = keys[i++];
            const p = uniq.get(k);
            hits.set(k, await cinemetaSearch(p.isSeries ? "series" : "movie", p.title, p.isSeries ? null : p.year));
          }
        }),
      );
      for (const { f, p } of parsed) {
        const k = `${p.isSeries ? "series" : "movie"}|${p.title.toLowerCase()}|${p.isSeries ? "" : p.year || ""}`;
        const hit = hits.get(k);
        if (p.isSeries) {
          const id = hit?.id || `gd:s:${slug(p.title)}`;
          const entry = series.get(id) || { id, name: hit?.name || p.title, poster: hit?.poster || null, background: hit?.background || null, description: hit?.description || "", episodes: new Map(), matched: Boolean(hit), modified: f.modifiedTime };
          const ek = `${p.season}:${p.episode}`;
          entry.episodes.set(ek, [...(entry.episodes.get(ek) || []), f]);
          if (f.modifiedTime > entry.modified) entry.modified = f.modifiedTime;
          series.set(id, entry);
        } else {
          const id = hit?.id || `gd:m:${f.id}`;
          const entry = movies.get(id) || { id, name: hit?.name || p.title, year: hit ? Number(String(hit.releaseInfo || "").slice(0, 4)) || p.year : p.year, poster: hit?.poster || null, background: hit?.background || null, description: hit?.description || "", files: [], matched: Boolean(hit), modified: f.modifiedTime };
          entry.files.push(f);
          if (f.modifiedTime > entry.modified) entry.modified = f.modifiedTime;
          movies.set(id, entry);
        }
      }
      index = { movies, series, builtAt: Date.now(), error: null, fileCount: files.length };
      console.log(`[gdrive] indexed ${files.length} files → ${movies.size} movies, ${series.size} series`);
    } catch (err) {
      index = { ...index, error: err.message, builtAt: index.builtAt || Date.now() - 10 * 60 * 1000 };
      console.warn("[gdrive] index error:", err.message);
    } finally {
      building = null;
    }
    return index;
  })();
  return building;
}

// ---------- Stremio responses ----------
export function manifest(baseUrl) {
  const configured = gdriveConfigured();
  return {
    id: "org.nuvio.gdrive",
    version: "1.0.0",
    name: "My Google Drive",
    description: "أفلامك ومسلسلاتك من Google Drive داخل Nuvio: صف على الشاشة الرئيسية، بوسترات ومعلومات تلقائية، وتشغيل مباشر من Google.",
    logo: "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f4c2.png",
    resources: [
      { name: "catalog", types: ["movie", "series"] },
      { name: "meta", types: ["movie", "series"], idPrefixes: ["gd:"] },
      { name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "gd:"] },
    ],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "gdrive-movies", name: "Google Drive · أفلامي", extra: [{ name: "search" }, { name: "skip" }] },
      { type: "series", id: "gdrive-series", name: "Google Drive · مسلسلاتي", extra: [{ name: "search" }, { name: "skip" }] },
    ],
    behaviorHints: { configurable: true, configurationRequired: !configured },
  };
}

function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`;
}

function thumb(baseUrl, f) {
  return f.thumbnailLink ? `${baseUrl}/gdrive/thumb/${f.id}` : null;
}

function movieMeta(baseUrl, m) {
  const f = m.files[0];
  return {
    id: m.id,
    type: "movie",
    name: m.name,
    poster: m.poster || thumb(baseUrl, f),
    background: m.background || undefined,
    releaseInfo: m.year ? String(m.year) : undefined,
    description: m.description || m.files.map((x) => `${x.name} (${fmtSize(x.size)})`).join("\n"),
  };
}
function seriesMeta(baseUrl, s) {
  const first = [...s.episodes.values()][0]?.[0];
  return {
    id: s.id,
    type: "series",
    name: s.name,
    poster: s.poster || thumb(baseUrl, first),
    background: s.background || undefined,
    description: s.description || `${s.episodes.size} حلقة من Google Drive`,
  };
}

export async function catalog(baseUrl, type, id, extra) {
  const idx = await buildIndex();
  const search = (extra.search || "").toLowerCase();
  const skip = Number(extra.skip || 0);
  let metas;
  if (id === "gdrive-movies" && type === "movie") metas = [...idx.movies.values()].sort((a, b) => (b.modified > a.modified ? 1 : -1)).map((m) => movieMeta(baseUrl, m));
  else if (id === "gdrive-series" && type === "series") metas = [...idx.series.values()].sort((a, b) => (b.modified > a.modified ? 1 : -1)).map((s) => seriesMeta(baseUrl, s));
  else metas = [];
  if (search) metas = metas.filter((m) => m.name.toLowerCase().includes(search));
  return { metas: metas.slice(skip, skip + 100) };
}

export async function meta(baseUrl, type, id) {
  const idx = await buildIndex();
  if (type === "movie" && idx.movies.has(id)) return { meta: movieMeta(baseUrl, idx.movies.get(id)) };
  if (type === "series" && idx.series.has(id)) {
    const s = idx.series.get(id);
    const videos = [...s.episodes.entries()]
      .map(([k, files]) => {
        const [season, episode] = k.split(":").map(Number);
        return { id: `${s.id}:${season}:${episode}`, title: `الحلقة ${episode}`, season, episode, released: files[0].modifiedTime, thumbnail: thumb(baseUrl, files[0]) || undefined };
      })
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { meta: { ...seriesMeta(baseUrl, s), videos } };
  }
  return { meta: null };
}

async function streamsForFiles(baseUrl, files) {
  const c = env();
  const auth = oauthMode(c) ? { Authorization: `Bearer ${await accessToken()}` } : null;
  const out = [];
  for (const f of files) {
    const direct = `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true${auth ? "" : `&key=${encodeURIComponent(c.apiKey)}`}`;
    const title = `${f.name}\n${fmtSize(f.size)}${f.folderPath?.length ? ` · ${f.folderPath.join("/")}` : ""}`;
    out.push({
      name: "Google Drive",
      title,
      url: direct,
      behaviorHints: {
        notWebReady: true,
        filename: f.name,
        videoSize: Number(f.size) || undefined,
        bingeGroup: "gdrive",
        ...(auth ? { proxyHeaders: { request: auth } } : {}),
      },
    });
    out.push({
      name: "Google Drive\n(proxy)",
      title: `${f.name}\n${fmtSize(f.size)} · للمشغّلات الخارجية`,
      url: `${baseUrl}/gdrive/play/${f.id}/${encodeURIComponent(f.name)}`,
      behaviorHints: { filename: f.name, videoSize: Number(f.size) || undefined, bingeGroup: "gdrive-proxy" },
    });
  }
  return out;
}

export async function stream(baseUrl, type, rawId) {
  const idx = await buildIndex();
  const id = decodeURIComponent(rawId);
  if (type === "movie") {
    const m = idx.movies.get(id);
    return { streams: m ? await streamsForFiles(baseUrl, m.files) : [] };
  }
  // series: <seriesId>:<season>:<episode>
  const mm = id.match(/^(.*):(\d+):(\d+)$/);
  if (!mm) return { streams: [] };
  const s = idx.series.get(mm[1]);
  const files = s?.episodes.get(`${Number(mm[2])}:${Number(mm[3])}`) || [];
  return { streams: await streamsForFiles(baseUrl, files) };
}

// ---------- proxy endpoints ----------
export async function play(req, res, fileId) {
  const c = env();
  const auth = await driveAuth();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true${auth.query}`;
  const headers = { ...auth.headers };
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetchT(url, { headers, method: req.method }, 30000);
  const pass = {};
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) pass[h] = v;
  }
  res.writeHead(upstream.status, { "Access-Control-Allow-Origin": "*", "accept-ranges": "bytes", ...pass });
  if (req.method === "HEAD" || !upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
  req.on("close", () => upstream.body?.cancel?.().catch(() => {}));
  void c;
}

export async function thumbnail(res, fileId) {
  const auth = await driveAuth();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink&supportsAllDrives=true${auth.query}`;
  const metaRes = await fetchT(url, { headers: auth.headers });
  if (!metaRes.ok) {
    res.writeHead(404);
    return res.end();
  }
  const link = (await metaRes.json()).thumbnailLink;
  if (!link) {
    res.writeHead(404);
    return res.end();
  }
  const img = await fetchT(link.replace(/=s\d+$/, "=s600"), { headers: auth.headers });
  res.writeHead(img.status, { "Content-Type": img.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=86400" });
  Readable.fromWeb(img.body).pipe(res);
}

// ---------- OAuth setup helper (/gdrive/setup) ----------
const pending = new Map(); // state -> {clientId, clientSecret, exp}
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export function setupStart(baseUrl, clientId, clientSecret) {
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, { clientId, clientSecret, exp: Date.now() + 10 * 60 * 1000 });
  const redirect = `${baseUrl}/gdrive/oauth/callback`;
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function setupCallback(baseUrl, code, state) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.exp < Date.now()) throw new Error("انتهت صلاحية الجلسة، ابدأ من جديد");
  const body = new URLSearchParams({ code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: `${baseUrl}/gdrive/oauth/callback`, grant_type: "authorization_code" });
  const res = await fetchT("https://oauth2.googleapis.com/token", { method: "POST", body });
  const json = await res.json();
  if (!res.ok || !json.refresh_token) throw new Error(`Google: ${json.error_description || json.error || res.status}`);
  return { clientId: p.clientId, refreshToken: json.refresh_token };
}

export function setupPage(baseUrl, result, error) {
  const cfg = env();
  const status = gdriveConfigured()
    ? `<p class="ok">✅ الإضافة مهيأة. رابط التثبيت: <code>${baseUrl}/gdrive/manifest.json</code></p>`
    : `<p class="warn">⚠️ لم تُضبط متغيرات البيئة بعد.</p>`;
  const resultHtml = result
    ? `<div class="card ok"><h3>نجح الربط ✅</h3><p>أضف هذه المتغيرات في Render → Environment ثم اضغط Save (سيُعاد النشر تلقائياً):</p>
<pre>GDRIVE_CLIENT_ID=${result.clientId}
GDRIVE_CLIENT_SECRET=&lt;الـ Client secret نفسه الذي أدخلته&gt;
GDRIVE_REFRESH_TOKEN=${result.refreshToken}</pre>
<p>اختياري: <code>GDRIVE_FOLDER_ID</code> = معرّف مجلد الأفلام (الجزء الأخير من رابط المجلد في Drive) لفهرسة هذا المجلد فقط.</p>
<p>بعد النشر، ثبّت في Nuvio: <code>${baseUrl}/gdrive/manifest.json</code></p></div>`
    : "";
  const errHtml = error ? `<div class="card err">❌ ${error}</div>` : "";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My Google Drive · إعداد</title>
<style>body{margin:0;background:#0f1115;color:#e8eaf0;font:16px/1.6 system-ui,Tahoma,sans-serif}main{max-width:720px;margin:0 auto;padding:28px 16px 60px}
.card{background:#171a21;border:1px solid #262b36;border-radius:14px;padding:18px;margin:14px 0}.ok{border-color:#30c48d}.err{border-color:#e05d5d}.warn{color:#f5c451}
label{display:block;font-weight:600;margin:12px 0 6px}input{width:100%;padding:11px;border-radius:10px;border:1px solid #262b36;background:#0c0e12;color:#e8eaf0;direction:ltr;box-sizing:border-box}
button{margin-top:14px;padding:11px 18px;border-radius:10px;border:0;background:#30c48d;color:#07140e;font-weight:700;font-size:15px;cursor:pointer}
pre,code{direction:ltr;text-align:left;background:#0c0e12;border-radius:8px;padding:4px 8px;font-size:13px;overflow:auto;display:block;white-space:pre-wrap;word-break:break-all}code{display:inline}ol{padding-inline-start:22px}a{color:#30c48d}</style></head><body><main>
<h1>📂 My Google Drive · إعداد</h1>${status}${resultHtml}${errHtml}
<div class="card"><h3>1) أنشئ OAuth Client في Google Cloud (مرة واحدة)</h3><ol>
<li>افتح <a href="https://console.cloud.google.com/projectcreate" target="_blank">console.cloud.google.com</a> وأنشئ مشروعاً (أي اسم).</li>
<li>فعّل <b>Google Drive API</b>: APIs &amp; Services → Library → ابحث Google Drive API → Enable.</li>
<li>APIs &amp; Services → <b>OAuth consent screen</b>: External → اسم التطبيق وبريدك → حفظ. ثم اضغط <b>Publish app</b> (مهم، وإلا تنتهي الصلاحية كل 7 أيام).</li>
<li>APIs &amp; Services → Credentials → Create credentials → <b>OAuth client ID</b> → Web application، وفي <b>Authorized redirect URIs</b> أضف بالضبط:<br><code>${baseUrl}/gdrive/oauth/callback</code></li>
<li>انسخ Client ID و Client secret إلى الحقول أدناه.</li></ol></div>
<form class="card" method="get" action="${baseUrl}/gdrive/oauth/start"><h3>2) اربط حسابك</h3>
<label>Client ID</label><input name="client_id" required placeholder="xxxx.apps.googleusercontent.com">
<label>Client secret</label><input name="client_secret" required placeholder="GOCSPX-...">
<button type="submit">تسجيل الدخول بـ Google</button>
<p style="color:#9aa3b2;font-size:14px">سيظهر تحذير "Google hasn't verified this app" لأن التطبيق تطبيقك الخاص: اضغط Advanced ثم Go to … (unsafe) ثم اسمح بالقراءة فقط.</p></form>
<div class="card"><h3>بديل بدون OAuth</h3><p>لو كانت أفلامك في مجلد مشارك "Anyone with the link": أنشئ <b>API key</b> من Credentials وضع <code>GDRIVE_API_KEY</code> و <code>GDRIVE_FOLDER_ID</code> في Render.</p></div>
<p style="color:#9aa3b2">الوضع الحالي: ${oauthMode(cfg) ? "OAuth (Drive خاص)" : keyMode(cfg) ? "API key (مجلد عام)" : "غير مهيأ"}${index.builtAt ? ` · مفهرس: ${index.fileCount} ملف، ${index.movies.size} فيلم، ${index.series.size} مسلسل` : ""}${index.error ? ` · خطأ: ${index.error}` : ""}</p>
</main></body></html>`;
}

export function status() {
  return { configured: gdriveConfigured(), files: index.fileCount, movies: index.movies.size, series: index.series.size, builtAt: index.builtAt ? new Date(index.builtAt).toISOString() : null, error: index.error };
}

// Minimal legal pages: Google's OAuth consent screen requires public
// home/privacy/terms URLs before an app can be published.
export function legalPage(kind, baseUrl) {
  const privacy = kind === "privacy";
  const title = privacy ? "Privacy Policy" : "Terms of Service";
  const body = privacy
    ? `<p>This is a personal, self-hosted media add-on. It accesses the Google Drive account of its owner only, with read-only scope, to list and stream the owner's own video files inside the Nuvio app.</p>
<p>No data is sold, shared, or sent to third parties. Access tokens are kept in memory on the owner's own server instance and are used solely to call the Google Drive API on the owner's behalf. File metadata (names, sizes) is cached temporarily to build the library listing. You can revoke access at any time from <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>`
    : `<p>This add-on is provided as-is, for personal use by its owner, without warranty of any kind. It only streams files that the owner already has in their own Google Drive. The owner is responsible for complying with Google's Terms of Service and applicable law.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · My Google Drive add-on</title>
<style>body{margin:0;background:#0f1115;color:#e8eaf0;font:16px/1.7 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:40px 16px}a{color:#30c48d}</style></head>
<body><main><h1>${title}</h1>${body}<p>Home: <a href="${baseUrl}/gdrive/">${baseUrl}/gdrive/</a></p></main></body></html>`;
}
