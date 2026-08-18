from pathlib import Path
import re

APP = Path("app.js")
INDEX = Path("index.html")
SW = Path("sw.js")

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: ожидалось 1 совпадение, найдено {count}")
    return text.replace(old, new, 1)

# ---------- app.js ----------
s = APP.read_text(encoding="utf-8")

s = replace_once(
    s,
    "const APP_VERSION = '1.0.28';",
    "const APP_VERSION = '1.0.29';",
    "APP_VERSION"
)

# Точечное исправление подтверждено двумя независимыми историческими
# снимками официального Stoloto (тройная проверка) и текущим live-файлом.
if "id:267486" not in s:
    s = replace_once(
        s,
        "  { id:267354, date:'30.07.26', time:'06:40', a:0, b:3, c:9 }\n];",
        "  { id:267354, date:'30.07.26', time:'06:40', a:0, b:3, c:9 },\n"
        "  { id:267486, date:'12.08.26', time:'09:40', a:6, b:3, c:8 }\n];",
        "VERIFIED_CORRECTIONS 267486"
    )

repair_code = r"""
function isVerifiedOfficialSource(source) {
  return /^Официальный Столото · OAuth · (двойная|тройная) проверка$/.test(String(source || '').trim());
}

async function repairVerifiedOnlineOverlap(items, source) {
  if (!isVerifiedOfficialSource(source) || !db || !storageReady || !Array.isArray(items)) return 0;

  const valid = items.filter(draw => isValidDraw(draw) && DRAW_TIMES.includes(draw.time));
  const localById = new Map(draws.map(draw => [draw.id, draw]));
  const overlap = valid.filter(draw => localById.has(draw.id));

  // Автокоррекция разрешена только если большая часть контрольной зоны
  // уже подтверждена локальной базой и источник — официальный OAuth-файл.
  if (overlap.length < 10) return 0;

  const exactMatches = overlap.filter(draw => sameDraw(draw, localById.get(draw.id)));
  const mismatches = overlap.filter(draw => !sameDraw(draw, localById.get(draw.id)));

  if (!mismatches.length) return 0;
  if (exactMatches.length < 10 || mismatches.length > 5) return 0;

  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const draw of mismatches) {
    store.put({
      id: Number(draw.id),
      date: String(draw.date),
      time: String(draw.time),
      a: Number(draw.a),
      b: Number(draw.b),
      c: Number(draw.c)
    });
  }
  await withTimeout(txDone(tx), 6000, 'Исправление проверенных онлайн-тиражей');
  await loadAllDraws();
  return mismatches.length;
}

"""

if "async function repairVerifiedOnlineOverlap(" not in s:
    marker = "function validateOnlineBatch(items) {"
    if marker not in s:
        raise SystemExit("Не найден validateOnlineBatch")
    s = s.replace(marker, repair_code + marker, 1)

s = replace_once(
    s,
    "    const result=await fetchLuckyDraws();\n    const items=validateOnlineBatch(result.items);",
    "    const result=await fetchLuckyDraws();\n"
    "    const repaired=await repairVerifiedOnlineOverlap(result.items,result.source);\n"
    "    const items=validateOnlineBatch(result.items);",
    "sync verified repair"
)

s = replace_once(
    s,
    "    if (added) await refreshFromDB();",
    "    if (added || repaired) await refreshFromDB();",
    "refresh after repair"
)

APP.write_text(s, encoding="utf-8")

# ---------- index.html ----------
h = INDEX.read_text(encoding="utf-8")
if "1.0.28" not in h and "1.0.29" not in h:
    raise SystemExit("index.html: версия 1.0.28 не найдена")
h = h.replace("1.0.28", "1.0.29")
INDEX.write_text(h, encoding="utf-8")

# ---------- sw.js ----------
w = SW.read_text(encoding="utf-8")
w = w.replace("const CACHE_NAME = 'yulia-top3-v1-0-27';",
              "const CACHE_NAME = 'yulia-top3-v1-0-29';")

assets_pattern = re.compile(
    r"const ASSETS = \[\n"
    r"\s*'\./index\.html', '\./repair\.html', '\./styles\.css\?v=[^']+', '\./app\.js\?v=[^']+',\n"
    r"\s*'\./top3-data\.js\?v=[^']+', '\./manifest\.webmanifest',\n"
    r"\s*'\./icon-192\.png', '\./icon-512\.png', '\./icon-top3-yulia-v1\.png'\n"
    r"\];"
)

new_assets = """const ASSETS = [
  './index.html', './repair.html', './styles.css?v=1.0.29-fix1', './app.js?v=1.0.29-fix1',
  './mirror-method.css?v=1.0.29-fix1', './mirror-method.js?v=1.0.29-fix1',
  './top3-data.js?v=1.0.21', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-top3-yulia-v1.png'
];"""

w2, n = assets_pattern.subn(new_assets, w, count=1)
if n != 1:
    raise SystemExit(f"sw.js: блок ASSETS не найден, заменено {n}")

SW.write_text(w2, encoding="utf-8")

print("TOP3 local mismatch repair patch applied: v1.0.29")
