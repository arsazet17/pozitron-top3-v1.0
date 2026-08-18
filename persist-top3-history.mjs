import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const HISTORY_FILE = new URL('./top3-history.json', import.meta.url);
const MAX_HISTORY = 5000;
const ANCHOR_ID = 267354;

const REGULAR_DRAW_TIMES = new Set([
  '02:40','04:40','06:40','07:40','09:40',
  '11:40','13:40','16:25','21:25','22:40'
]);

function validDate(value) {
  const m = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return false;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = 2000 + Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function normalizeDraw(raw) {
  const d = {
    id: Number(raw?.id),
    date: String(raw?.date || ''),
    time: String(raw?.time || ''),
    a: Number(raw?.a),
    b: Number(raw?.b),
    c: Number(raw?.c)
  };
  if (!Number.isInteger(d.id) || d.id < 100000 || d.id > 999999) return null;
  if (!validDate(d.date) || !REGULAR_DRAW_TIMES.has(d.time)) return null;
  if (![d.a,d.b,d.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9)) return null;
  return d;
}

function sameDraw(a, b) {
  return a.id === b.id
    && a.date === b.date
    && a.time === b.time
    && a.a === b.a
    && a.b === b.b
    && a.c === b.c;
}

function normalizeList(items) {
  return (Array.isArray(items) ? items : [])
    .map(normalizeDraw)
    .filter(Boolean);
}

const live = JSON.parse(await fs.readFile(LIVE_FILE, 'utf8'));
const history = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8'));

const historyDraws = normalizeList(history.draws);
const liveDraws = normalizeList(live.draws);

if (!liveDraws.length) throw new Error('top3-live.json не содержит корректных тиражей');
if (!historyDraws.length) throw new Error('top3-history.json не содержит контрольного моста');

const byId = new Map();
for (const d of historyDraws) byId.set(d.id, d);

for (const d of liveDraws) {
  const old = byId.get(d.id);
  if (old && !sameDraw(old, d)) {
    throw new Error(
      `Конфликт истории на тираже №${d.id}: history=${old.a}${old.b}${old.c}, live=${d.a}${d.b}${d.c}`
    );
  }
  byId.set(d.id, d);
}

const merged = [...byId.values()]
  .sort((a, b) => b.id - a.id)
  .slice(0, MAX_HISTORY);

const latestId = merged[0]?.id || 0;
const ids = new Set(merged.map(d => d.id));

if (!ids.has(ANCHOR_ID)) {
  throw new Error(`Контрольный якорь №${ANCHOR_ID} потерян`);
}

// С момента якоря ID в архиве TOP-3 идут последовательно.
// Любая дыра означает, что общий файл нельзя публиковать.
for (let id = ANCHOR_ID; id <= latestId; id += 1) {
  if (!ids.has(id)) throw new Error(`Обнаружен разрыв истории: отсутствует тираж №${id}`);
}

const historyOut = {
  schema: 2,
  source: 'TOP-3 permanent verified history',
  updatedAt: new Date().toISOString(),
  latest: latestId,
  anchorFrom: ANCHOR_ID,
  draws: merged
};

const liveOut = {
  ...live,
  latest: latestId,
  draws: merged
};

await fs.writeFile(HISTORY_FILE, JSON.stringify(historyOut, null, 2) + '\n', 'utf8');
await fs.writeFile(LIVE_FILE, JSON.stringify(liveOut, null, 2) + '\n', 'utf8');

console.log(
  `TOP3 HISTORY OK: ${merged.length} draws, №${merged.at(-1)?.id}…№${latestId}; live file restored without gaps`
);
