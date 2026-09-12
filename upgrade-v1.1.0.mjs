import fs from 'node:fs/promises';

const VERSION = '1.1.0';

async function read(path) {
  return fs.readFile(path, 'utf8');
}

async function write(path, text) {
  await fs.writeFile(path, text, 'utf8');
}

function replaceRequired(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`Не найден фрагмент для ${label}`);
  return text.replace(from, to);
}

function replaceRegexRequired(text, regex, to, label) {
  if (typeof to === 'string' && text.includes(to)) return text;
  if (!regex.test(text)) throw new Error(`Не найден шаблон для ${label}`);
  regex.lastIndex = 0;
  return text.replace(regex, to);
}

// app.js
let app = await read('app.js');
app = app.replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${VERSION}';`);
app = replaceRegexRequired(
  app,
  /const DRAW_TIMES = \[[^\n]+\];/,
  `const DRAW_TIMES = Array.from({ length: 48 }, (_, index) => {\n  const totalMinutes = 25 + index * 30;\n  const hour = Math.floor(totalMinutes / 60) % 24;\n  const minute = totalMinutes % 60;\n  return \`${'${String(hour).padStart(2, \'0\')}:${String(minute).padStart(2, \'0\')}'}\`;\n});`,
  '48-тиражного расписания в app.js'
);
app = app.replace("let archiveTime = '13:40';", "let archiveTime = '13:25';");
app = app.replace("const LIVE_DATA_URL = './top3-live.json';", "const LIVE_DATA_URL = './top3-history.json';");
app = replaceRequired(
  app,
  "  const existing = await withTimeout(countDB(), 6000, 'Проверка базы');\n  if (existing && !force) return;",
  "  const existing = await withTimeout(countDB(), 6000, 'Проверка базы');\n  const rows = seedObjects();\n  // После расширения встроенного архива один раз дольём недостающую историю в IndexedDB.\n  if (existing && !force && existing >= rows.length) return;",
  'доливки полного архива в IndexedDB'
);
app = replaceRequired(
  app,
  "  const rows = seedObjects();\n  const batchSize = 500;",
  "  const batchSize = 500;",
  'переноса seedObjects'
);
app = replaceRequired(
  app,
  "  const valid = items.filter(draw => isValidDraw(draw) && DRAW_TIMES.includes(draw.time));",
  "  // Полный постоянный архив содержит и исторические расписания, поэтому здесь проверяем сам факт, а не только текущие 48 времён.\n  const valid = items.filter(draw => isValidDraw(draw));",
  'проверки исторических времён'
);
app = replaceRequired(
  app,
  "  const timeButtons = DRAW_TIMES.map(time => {",
  "  const sourceTimes = attributeName === 'archive-time'\n    ? [...new Set([...DRAW_TIMES, ...draws.map(draw => draw.time)])].sort((a,b) => {\n        const [ah,am] = a.split(':').map(Number); const [bh,bm] = b.split(':').map(Number);\n        return ah * 60 + am - (bh * 60 + bm);\n      })\n    : DRAW_TIMES;\n  const timeButtons = sourceTimes.map(time => {",
  'исторических времён в архиве'
);

const oldComboBlock = `  const combos = new Map();\n  list.forEach(d=>{ const k=\`${'${d.a}${d.b}${d.c}'}\`; combos.set(k,(combos.get(k)||0)+1); });\n  const top=[...combos.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,10);\n  $('comboTable').innerHTML = top.map(([k,n],i)=>\`<div class=\"combo-item\"><b>${'${i+1}. ${k}'}</b><span>${'${n}'} раз</span></div>\`).join('');`;

const newComboBlock = `  const combos = new Map();\n  list.forEach(d=>{ const k=\`${'${d.a}${d.b}${d.c}'}\`; combos.set(k,(combos.get(k)||0)+1); });\n  const top=[...combos.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,20);\n  $('comboTable').innerHTML = top.map(([k,n],i)=>\`<div class=\"combo-item\"><b>${'${i+1}. ${k}'}</b><span>${'${n}'} раз</span></div>\`).join('');\n\n  // Отдельная фактическая статистика троек XXX: 000, 111 ... 999.\n  const tripleCodes = Array.from({length:10}, (_,digit) => String(digit).repeat(3));\n  const periodTriple = new Map(tripleCodes.map(code => [code,0]));\n  const allTriple = new Map(tripleCodes.map(code => [code,0]));\n  list.forEach(d => {\n    if (d.a === d.b && d.b === d.c) {\n      const code = String(d.a).repeat(3);\n      periodTriple.set(code, (periodTriple.get(code) || 0) + 1);\n    }\n  });\n  draws.forEach(d => {\n    if (d.a === d.b && d.b === d.c) {\n      const code = String(d.a).repeat(3);\n      allTriple.set(code, (allTriple.get(code) || 0) + 1);\n    }\n  });\n\n  const last20Counts = new Map(tripleCodes.map(code => [code,0]));\n  draws.slice(0,20).forEach(d => {\n    if (d.a === d.b && d.b === d.c) {\n      const code = String(d.a).repeat(3);\n      last20Counts.set(code, (last20Counts.get(code) || 0) + 1);\n    }\n  });\n  const leader20 = [...last20Counts.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0];\n  $('tripleLeader20').textContent = leader20 && leader20[1] > 0 ? \`${'${leader20[0]} · ${leader20[1]} раз'}\` : 'XXX не было';\n\n  const lastTripleIndex = draws.findIndex(d => d.a === d.b && d.b === d.c);\n  const lastTriple = lastTripleIndex >= 0 ? draws[lastTripleIndex] : null;\n  $('tripleLast').textContent = lastTriple\n    ? \`${'${String(lastTriple.a).repeat(3)} · ${lastTriple.date} ${lastTriple.time} · ${lastTripleIndex} тиражей назад'}\`\n    : 'нет в архиве';\n\n  $('tripleComboTable').innerHTML = tripleCodes.map(code => {\n    const digit = Number(code[0]);\n    const lastIndex = draws.findIndex(d => d.a === digit && d.b === digit && d.c === digit);\n    const last = lastIndex >= 0 ? draws[lastIndex] : null;\n    return \`<div class=\"triple-item\">\n      <strong>${'${code}'}</strong>\n      <span>период: <b>${'${periodTriple.get(code) || 0}'}</b></span>\n      <span>вся база: <b>${'${allTriple.get(code) || 0}'}</b></span>\n      <small>${'${last ? `последняя: ${last.date} ${last.time} · ${lastIndex} тиражей назад` : \'ещё не было\'}'}</small>\n    </div>\`;\n  }).join('');`;

if (!app.includes("$('tripleComboTable').innerHTML")) {
  app = replaceRequired(app, oldComboBlock, newComboBlock, 'расширенной статистики тройных комбинаций');
}
await write('app.js', app);

// index.html
let index = await read('index.html');
index = index.replace(/Yulia TOP-3 v1\.0\.29/g, `Yulia TOP-3 v${VERSION}`);
index = index.replace(/v1\.0\.29-fix1/g, `v=${VERSION}`);
index = index.replace("window.TOP3_BUILD = '1.0.29';", `window.TOP3_BUILD = '${VERSION}';`);
index = index.replace('<span class="version">v1.0.29</span>', `<span class="version">v${VERSION}</span>`);
index = index.replace('app.js?v=1.0.30-idb', `app.js?v=${VERSION}`);
index = index.replace('top3-data.js?v=1.0.21', `top3-data.js?v=${VERSION}`);
index = index.replace('11 АРХИВОВ', 'ПОЛНЫЙ АРХИВ · ВСЕ РАСПИСАНИЯ');
index = index.replace('Все 10 времён', 'Все времена');
index = index.replace('ОБЩАЯ МОДЕЛЬ И 10 МОДЕЛЕЙ ПО ВРЕМЕНИ', 'ОБЩАЯ МОДЕЛЬ И 48 МОДЕЛЕЙ ПО ВРЕМЕНИ');
index = index.replace('например, 13:40 сравнивается с предыдущими 13:40 по дням', 'например, 13:25 сравнивается с предыдущими 13:25 по дням');
index = index.replace('02:40 · 04:40 · 06:40 · 07:40 · 09:40 · 11:40 · 13:40 · 16:25 · 21:25 · 22:40', '48 тиражей в сутки · каждые 30 минут: 00:25 · 00:55 · 01:25 · 01:55 · … · 23:25 · 23:55');

const oldTriplePanel = `      <section class="panel">\n        <div class="section-head"><div><span class="eyebrow">КОМБИНАЦИИ</span><h3>Частые точные тройки</h3></div></div>\n        <div id="comboTable" class="combo-list"></div>\n      </section>`;
const newTriplePanel = `      <section class="panel triple-combo-panel">\n        <div class="section-head"><div><span class="eyebrow">КОМБИНАЦИИ</span><h3>Тройные комбинации</h3></div></div>\n        <p class="panel-note">Сверху — 20 самых частых точных комбинаций выбранного периода. Ниже отдельно ведётся фактическая статистика XXX: 000, 111, 222 … 999 по периоду и по всей базе.</p>\n        <div class="triple-summary-grid">\n          <div><span>Лидер XXX · последние 20</span><strong id="tripleLeader20">—</strong></div>\n          <div><span>Последняя выпавшая XXX</span><strong id="tripleLast">—</strong></div>\n        </div>\n        <h4 class="analysis-subtitle">Частые точные комбинации</h4>\n        <div id="comboTable" class="combo-list"></div>\n        <h4 class="analysis-subtitle">Все XXX · 000–999</h4>\n        <div id="tripleComboTable" class="triple-combo-list"></div>\n      </section>`;
if (!index.includes('id="tripleComboTable"')) {
  index = replaceRequired(index, oldTriplePanel, newTriplePanel, 'панели тройных комбинаций');
}
await write('index.html', index);

// styles.css
let styles = await read('styles.css');
if (!styles.includes('/* v1.1.0 triple analytics */')) {
  styles += `\n\n/* v1.1.0 triple analytics */\n.triple-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0 18px}.triple-summary-grid>div{padding:13px;border:1px solid rgba(117,161,255,.24);border-radius:14px;background:rgba(10,30,72,.45);display:flex;flex-direction:column;gap:6px}.triple-summary-grid span{font-size:.76rem;opacity:.72}.triple-summary-grid strong{font-size:1rem}.analysis-subtitle{margin:18px 0 9px;font-size:.9rem}.triple-combo-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.triple-item{border:1px solid rgba(117,161,255,.2);border-radius:12px;padding:11px;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;align-items:center}.triple-item>strong{grid-row:1/4;font-size:1.25rem}.triple-item span,.triple-item small{font-size:.75rem}.triple-item small{opacity:.66}@media(max-width:560px){.triple-summary-grid,.triple-combo-list{grid-template-columns:1fr}}\n`;
}
await write('styles.css', styles);

// sw.js
let sw = await read('sw.js');
sw = sw.replace(/const CACHE_NAME = '[^']+';/, "const CACHE_NAME = 'yulia-top3-v1-1-0';");
sw = sw.replace("const LIVE_FILE = './top3-live.json';", "const LIVE_FILE = './top3-history.json';");
sw = sw.replace("const isLive = url.pathname.endsWith('/top3-live.json');", "const isLive = url.pathname.endsWith('/top3-history.json');");
sw = sw.replace(/styles\.css\?v=[^']+/g, `styles.css?v=${VERSION}`);
sw = sw.replace(/app\.js\?v=[^']+/g, `app.js?v=${VERSION}`);
sw = sw.replace(/top3-data\.js\?v=[^']+/g, `top3-data.js?v=${VERSION}`);
sw = sw.replace(/mirror-method\.css\?v=[^']+/g, `mirror-method.css?v=${VERSION}`);
sw = sw.replace(/mirror-method\.js\?v=[^']+/g, `mirror-method.js?v=${VERSION}`);
await write('sw.js', sw);

// update-top3.mjs: current official schedule is 48 draws/day, :25 and :55.
let updater = await read('update-top3.mjs');
updater = replaceRegexRequired(
  updater,
  /const REGULAR_DRAW_TIMES = new Set\(\[[\s\S]*?\]\);/,
  `const REGULAR_DRAW_TIMES = new Set(Array.from({ length: 48 }, (_, index) => {\n  const totalMinutes = 25 + index * 30;\n  const hour = Math.floor(totalMinutes / 60) % 24;\n  const minute = totalMinutes % 60;\n  return \`${'${String(hour).padStart(2, \'0\')}:${String(minute).padStart(2, \'0\')}'}\`;\n}));`,
  '48-тиражного расписания в серверном обновлении'
);
await write('update-top3.mjs', updater);

// persist-top3-history.mjs: merge the entire embedded archive + permanent history + recent live data.
const persist = `import fs from 'node:fs/promises';\n\nconst LIVE_FILE = new URL('./top3-live.json', import.meta.url);\nconst HISTORY_FILE = new URL('./top3-history.json', import.meta.url);\nconst SEED_FILE = new URL('./top3-data.js', import.meta.url);\n\nfunction validDraw(draw) {\n  return Number.isInteger(draw?.id)\n    && draw.id > 0\n    && /^\\d{2}\\.\\d{2}\\.\\d{2}$/.test(String(draw.date || ''))\n    && /^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(String(draw.time || ''))\n    && [draw.a, draw.b, draw.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9);\n}\n\nfunction normalizeDraw(draw) {\n  const item = {\n    id: Number(draw?.id), date: String(draw?.date || ''), time: String(draw?.time || ''),\n    a: Number(draw?.a), b: Number(draw?.b), c: Number(draw?.c)\n  };\n  return validDraw(item) ? item : null;\n}\n\nfunction dedupe(draws) {\n  const map = new Map();\n  for (const raw of draws) {\n    const draw = normalizeDraw(raw);\n    if (draw) map.set(draw.id, draw);\n  }\n  return [...map.values()].sort((a,b) => b.id - a.id);\n}\n\nasync function readJson(file, fallback) {\n  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }\n}\n\nasync function readSeed() {\n  const source = await fs.readFile(SEED_FILE, 'utf8');\n  const match = source.match(/window\\.TOP3_SEED\\s*=\\s*(\\[[\\s\\S]*\\])\\s*;?\\s*$/);\n  if (!match) throw new Error('Не удалось прочитать window.TOP3_SEED');\n  const tuples = JSON.parse(match[1]);\n  return tuples.map(row => ({ id:Number(row[0]), date:String(row[1]), time:String(row[2]), a:Number(row[3]), b:Number(row[4]), c:Number(row[5]) }));\n}\n\nconst live = await readJson(LIVE_FILE, { draws: [], forecasts: [] });\nconst historyFile = await readJson(HISTORY_FILE, { draws: [] });\nconst seed = await readSeed();\nconst history = Array.isArray(historyFile.draws) ? historyFile.draws : [];\nconst liveDraws = Array.isArray(live.draws) ? live.draws : [];\nconst merged = dedupe([...seed, ...history, ...liveDraws]);\n\nconst persistent = {\n  schema: 4,\n  fullArchive: true,\n  source: String(live.source || historyFile.source || 'Официальный Столото · OAuth · двойная проверка'),\n  updatedAt: new Date().toISOString(),\n  latest: merged[0]?.id ?? null,\n  archiveFrom: merged.at(-1)?.id ?? null,\n  archiveTo: merged[0]?.id ?? null,\n  regularTimes: Array.isArray(live.regularTimes) ? live.regularTimes : [],\n  forecasts: Array.isArray(live.forecasts) ? live.forecasts : (Array.isArray(historyFile.forecasts) ? historyFile.forecasts : []),\n  draws: merged\n};\n\nawait fs.writeFile(HISTORY_FILE, JSON.stringify(persistent, null, 2) + '\\n', 'utf8');\nconsole.log('full archive persisted: ' + merged.length + ' draws · ' + (persistent.archiveFrom ?? '—') + ' → ' + (persistent.archiveTo ?? '—'));\n`;
await write('persist-top3-history.mjs', persist);

console.log(`Yulia TOP-3 v${VERSION} migration applied`);
