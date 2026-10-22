# Arabic Subs · Auto — إضافة ترجمة عربية تلقائية لـ Nuvio

إضافة بصيغة Stremio (يقرأها Nuvio مباشرة) تجلب الترجمات العربية من **SubDL** و **OpenSubtitles** و **Wyzie**، ترتّبها حسب الجودة، وتقدّمها بصيغة SRT نظيفة بترميز UTF-8 (تحوّل Windows-1256 القديم تلقائياً).

المزامنة نفسها لا تحتاج إضافة: Nuvio يحتوي على ميزة **Auto Sync Subtitle** مدمجة تقارن توقيت الترجمة بالتوقيت المضمّن في الفيديو وتصحّح الإزاحة والانحراف، وتجرّب ترجمات أخرى بنفس اللغة عند بدء التشغيل. هذه الإضافة تعطيها ما تحتاجه: ترجمات عربية كثيرة ومرتبة لتختار منها.

## التشغيل

```bash
npm install
npm start          # http://localhost:7700/configure
```

أو بـ Docker:

```bash
docker build -t arabic-subs .
docker run -p 7700:7700 arabic-subs
```

يعمل كما هو على Render / Railway / Fly.io / Koyeb / أي VPS (يقرأ `PORT` من البيئة).

## المفاتيح (مجانية)

| المصدر | من أين |
|---|---|
| SubDL | subdl.com → حسابك → API |
| OpenSubtitles | opensubtitles.com → API Consumers (مفتاح مجاني؛ إضافة اسم المستخدم/كلمة المرور يرفع حد التحميل اليومي) |
| Wyzie | store.wyzie.io/redeem (1000 طلب/يوم مجاناً) |

مفتاح واحد يكفي. ضعها في صفحة `/configure` لتوليد رابط التثبيت، أو في متغيرات البيئة (انظر `.env.example`).

## التثبيت في Nuvio

1. افتح `https://<عنوانك>/configure`، أدخل المفاتيح، انسخ الرابط.
2. **Settings → Addons → Add by URL** والصق الرابط.
3. **Settings → Playback → Subtitle / Audio**:
   - **Preferred subtitle language → Arabic**
   - فعّل **Auto Sync Subtitle** (ويمكن اختيار Thorough).
4. شغّل الفيلم. ستظهر «Auto synced» على بطاقة الترجمة عند النجاح.

## كيف تعمل

- `GET /manifest.json` و `GET /subtitles/{type}/{id}.json` حسب بروتوكول Stremio. تدعم `tt…` و `tmdb:…` للأفلام والمسلسلات (`tt123:1:2`).
- لو أرسل المشغّل `filename` (Stremio يفعل، Nuvio لا)، تُرجَّح الترجمات المطابقة لاسم الإصدار.
- كل ترجمة تُقدَّم عبر `/sub/{token}/{id}.srt`: يُفكّ الـ zip، يُختار ملف الحلقة الصحيح من الحزم، ويُصلَح الترميز.
- الترتيب: مطابقة الإصدار > مصدر WEB/BluRay > عدد التحميلات، مع استبعاد ترجمات ضعاف السمع والترجمة الآلية افتراضياً.

## ملاحظات

- Auto Sync في Nuvio يعمل مع مشغّل ExoPlayer الداخلي على Android والفيديو الذي يحتوي توقيت ترجمة مضمّن (أغلب ملفات WEB-DL/BluRay). بدون توقيت مضمّن تبقى الترجمة كما هي.
- حدود OpenSubtitles المجانية صغيرة (تحميلات/يوم)؛ لذلك SubDL هو المصدر الأساسي الموصى به.
