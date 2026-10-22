// Arabic (RTL) configuration page: turns API keys into an install URL.
export function configurePage(baseUrl) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arabic Subs · إعداد الإضافة</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--fg:#e8eaf0;--mut:#9aa3b2;--acc:#30c48d;--bd:#262b36}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif}
  main{max-width:720px;margin:0 auto;padding:28px 16px 60px}
  h1{font-size:26px;margin:0 0 6px}
  p.lead{color:var(--mut);margin:0 0 22px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px;margin-bottom:16px}
  label{display:block;font-weight:600;margin:12px 0 6px}
  small{color:var(--mut);font-weight:400}
  input,select{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--bd);background:#0c0e12;color:var(--fg);font-size:15px;direction:ltr;text-align:left}
  select{direction:rtl;text-align:right}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:560px){.row{grid-template-columns:1fr}}
  .out{direction:ltr;text-align:left;word-break:break-all;background:#0c0e12;border:1px dashed var(--bd);border-radius:10px;padding:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;min-height:52px}
  button,a.btn{display:inline-block;margin-top:12px;padding:11px 18px;border-radius:10px;border:0;background:var(--acc);color:#07140e;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none}
  button.sec{background:#2a3040;color:var(--fg);margin-inline-start:8px}
  ol{padding-inline-start:22px}
  .hint{color:var(--mut);font-size:14px}
  a{color:var(--acc)}
</style>
</head>
<body>
<main>
  <h1>🇸🇦 Arabic Subs · Auto</h1>
  <p class="lead">إضافة ترجمة عربية لـ Nuvio: تجمع الترجمات من عدة مصادر، ترتّبها حسب الجودة، وتقدّمها بصيغة SRT نظيفة (UTF-8) حتى تقوم ميزة <b>Auto Sync Subtitle</b> المدمجة في Nuvio باختيارها وضبط توقيتها تلقائياً.</p>

  <div class="card">
    <label>مفتاح SubDL <small>(مجاني — subdl.com ← الحساب ← API)</small></label>
    <input id="subdl" placeholder="SubDL API key" autocomplete="off">

    <label>مفتاح OpenSubtitles <small>(مجاني — opensubtitles.com ← API Consumers)</small></label>
    <input id="os" placeholder="OpenSubtitles API key" autocomplete="off">
    <div class="row">
      <div><label>اسم مستخدم OpenSubtitles <small>(اختياري، يزيد حد التحميل اليومي)</small></label><input id="osUser" placeholder="username"></div>
      <div><label>كلمة المرور <small>(اختياري)</small></label><input id="osPass" type="password" placeholder="password"></div>
    </div>

    <label>مفتاح Wyzie <small>(مجاني — store.wyzie.io/redeem)</small></label>
    <input id="wyzie" placeholder="Wyzie key" autocomplete="off">

    <div class="row">
      <div><label>ترجمات ضعاف السمع (HI)</label>
        <select id="hi"><option value="exclude">استبعادها (موصى به)</option><option value="include">تضمينها</option></select></div>
      <div><label>أقصى عدد نتائج</label><input id="max" type="number" min="3" max="60" value="20" style="direction:rtl;text-align:right"></div>
    </div>
    <p class="hint">يكفي مفتاح واحد لتعمل الإضافة. كلما زادت المصادر زادت فرص Auto Sync في إيجاد ترجمة توقيتها مطابق.</p>
  </div>

  <div class="card">
    <label>رابط التثبيت</label>
    <div class="out" id="out">—</div>
    <button id="copy">نسخ الرابط</button>
    <a class="btn sec" id="stremio" href="#" style="display:none">فتح في Stremio</a>
  </div>

  <div class="card">
    <label>خطوات التثبيت في Nuvio</label>
    <ol>
      <li>انسخ الرابط أعلاه.</li>
      <li>في Nuvio: <b>Settings → Addons → Add by URL</b> والصق الرابط.</li>
      <li><b>Settings → Playback → Subtitle / Audio</b>: اجعل <b>Preferred subtitle language = Arabic</b>.</li>
      <li>فعّل <b>Auto Sync Subtitle</b> في نفس الصفحة (اختياري: Thorough لمزيد من الدقة).</li>
      <li>شغّل أي فيلم — ستُختار الترجمة العربية وتُضبط تلقائياً بدون أي تدخل.</li>
    </ol>
  </div>
</main>
<script>
  const base = ${JSON.stringify(baseUrl)};
  const $ = (id) => document.getElementById(id);
  const fields = ["subdl","os","osUser","osPass","wyzie","hi","max"];
  function b64url(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
  function build(){
    const cfg = {};
    for (const f of fields){ const v = $(f).value.trim(); if (v) cfg[f] = f==="max" ? Number(v) : v; }
    const anyKey = cfg.subdl || cfg.os || cfg.wyzie;
    const url = anyKey ? base + "/" + b64url(JSON.stringify(cfg)) + "/manifest.json" : "";
    $("out").textContent = url || "أدخل مفتاحاً واحداً على الأقل";
    const st = $("stremio"); st.style.display = url ? "inline-block" : "none";
    if (url) st.href = "stremio://" + url.replace(/^https?:\\/\\//,"");
    try { localStorage.setItem("arsub-cfg", JSON.stringify(cfg)); } catch {}
    return url;
  }
  try { const saved = JSON.parse(localStorage.getItem("arsub-cfg")||"{}"); for (const f of fields) if (saved[f]!=null) $(f).value = saved[f]; } catch {}
  fields.forEach(f => $(f).addEventListener("input", build));
  $("copy").onclick = async () => { const u = build(); if(!u) return; try{ await navigator.clipboard.writeText(u); $("copy").textContent="تم النسخ ✓"; setTimeout(()=>$("copy").textContent="نسخ الرابط",1500);}catch{} };
  build();
</script>
</body>
</html>`;
}
