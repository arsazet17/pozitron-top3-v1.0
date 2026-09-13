import fs from 'node:fs/promises';

async function read(path) { return fs.readFile(path, 'utf8'); }
async function write(path, text) { await fs.writeFile(path, text, 'utf8'); }
function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Не найден фрагмент: ${label}`);
  return text.replace(from, to);
}

// 1) Client: keep every forecast and remove startup overwrite race.
let app = await read('app.js');
app = mustReplace(app, "const APP_VERSION='1.2.2';", "const APP_VERSION='1.2.3';", 'APP_VERSION');
app = mustReplace(
  app,
  `  forecastArchive = forecastArchive\n    .sort((a,b)=>Number(a.targetId)-Number(b.targetId))\n    .slice(-120);`,
  `  forecastArchive = forecastArchive\n    .sort((a,b)=>Number(a.targetId)-Number(b.targetId));`,
  'automatic forecast limit'
);
app = mustReplace(
  app,
  `  forecastArchive = forecastArchive\n    .sort((a,b) => Number(a.targetId || 0) - Number(b.targetId || 0))\n    .slice(-240);`,
  `  forecastArchive = forecastArchive\n    .sort((a,b) => Number(a.targetId || 0) - Number(b.targetId || 0));`,
  'server forecast limit'
);
const oldHydrate = `async function hydrateForecastArchive() {\n  const loaded = await loadForecastArchive();\n  if (Array.isArray(loaded)) {\n    forecastArchive = loaded;\n    try { renderForecastArchive(); } catch {}\n  }\n}`;
const newHydrate = `async function hydrateForecastArchive() {\n  const loaded = await loadForecastArchive();\n  if (Array.isArray(loaded)) {\n    // Важно: не перезаписываем прогноз, который мог быть создан renderAll()\n    // до завершения асинхронной загрузки IndexedDB. Объединяем оба архива.\n    const merged = [...loaded, ...forecastArchive];\n    const byId = new Map();\n    for (const item of merged) {\n      if (!item || typeof item !== 'object') continue;\n      const key = item.id\n        ? String(item.id)\n        : \`${'${item.automatic ? \'auto\' : \'manual\'}'}:${'${Number(item.targetId) || 0}'}:${'${String(item.createdAt || \'\')}'}\`;\n      const previous = byId.get(key);\n      if (!previous || String(item.createdAt || '') >= String(previous.createdAt || '')) byId.set(key, item);\n    }\n    forecastArchive = [...byId.values()].sort((a,b) =>\n      Number(a.targetId || 0) - Number(b.targetId || 0) ||\n      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))\n    );\n    await saveForecastArchive();\n    try { renderHomeForecast(); } catch {}\n    try { renderForecastArchive(); } catch {}\n  }\n}`;
app = mustReplace(app, oldHydrate, newHydrate, 'hydrateForecastArchive');
await write('app.js', app);

// 2) Server: active API updater must generate a pre-fact forecast on every run.
let updater = await read('update-top3-api.mjs');
const oldUpdater = await read('update-top3.mjs');
const startMarker = '// ===== СЕРВЕРНЫЙ ПРОГНОЗ: СОХРАНЕНА ЛОГИКА Yulia TOP-3 =====';
const endMarker = '// ===== ОСНОВНАЯ БЕЗОПАСНАЯ ЗАПИСЬ =====';
const start = oldUpdater.indexOf(startMarker);
const end = oldUpdater.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error('Не найден серверный модуль прогноза в update-top3.mjs');
let forecastModule = oldUpdater.slice(start, end).trim();
forecastModule = forecastModule.replace(
  `  return forecasts\n    .sort((first, second) => Number(first.targetId) - Number(second.targetId))\n    .slice(-240);`,
  `  return forecasts\n    .sort((first, second) => Number(first.targetId) - Number(second.targetId));`
);
if (!forecastModule.includes('function ensureServerForecast')) throw new Error('Секция прогноза повреждена');

updater = mustReplace(
  updater,
  "const LIVE_FILE = new URL('./top3-live.json', import.meta.url);",
  "const LIVE_FILE = new URL('./top3-live.json', import.meta.url);\nconst HISTORY_FILE = new URL('./top3-history.json', import.meta.url);",
  'HISTORY_FILE'
);
const insertBefore = "const live = JSON.parse(await fs.readFile(LIVE_FILE, 'utf8'));";
updater = mustReplace(updater, insertBefore, `${forecastModule}\n\n${insertBefore}`, 'forecast module insertion');
const oldMerged = `const merged = dedupe([...sourceRows, ...existing]).slice(0, KEEP_LIVE);\nconst nextLatest = merged[0]?.id || localLatest;`;
const newMerged = `const merged = dedupe([...sourceRows, ...existing]).slice(0, KEEP_LIVE);\nconst nextLatest = merged[0]?.id || localLatest;\n\n// Для прогноза нужна полная история по каждому времени, а не только live-хвост.\nlet permanentDraws = [];\ntry {\n  const permanent = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8'));\n  permanentDraws = dedupe(Array.isArray(permanent) ? permanent : (permanent?.draws || []));\n} catch (error) {\n  console.log(\`FORECAST HISTORY WARNING: ${'${error?.message || error}'}\`);\n}\nconst forecastHistory = dedupe([...permanentDraws, ...merged]);\nconst forecasts = ensureServerForecast(live?.forecasts || [], forecastHistory);`;
updater = mustReplace(updater, oldMerged, newMerged, 'forecast history block');
updater = mustReplace(
  updater,
  "  forecasts: Array.isArray(live?.forecasts) ? live.forecasts : [],",
  "  forecasts,",
  'payload forecasts'
);
await write('update-top3-api.mjs', updater);

// 3) Version/cache bust so the browser really receives the repaired client.
let index = await read('index.html');
if (!index.includes('1.2.2')) throw new Error('index.html already differs from expected v1.2.2');
index = index.replaceAll('1.2.2', '1.2.3');
await write('index.html', index);

let sw = await read('sw.js');
sw = sw.replace("yulia-top3-v1-2-2-direct-api", "yulia-top3-v1-2-3-forecast-all");
sw = sw.replaceAll('1.2.2', '1.2.3');
await write('sw.js', sw);

let manifest = await read('manifest.webmanifest');
manifest = manifest.replace('./?v=1.2.2-direct-api', './?v=1.2.3-forecast-all');
await write('manifest.webmanifest', manifest);

console.log('v1.2.3 forecast persistence patch applied');
