import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const ARCHIVE_API = 'https://m.stoloto.ru/p/api/mobile/api/v35/service/draws/archive';
const INFO_API = 'https://m.stoloto.ru/p/api/mobile/api/v35/service/games/info-new';
const PAGE_SIZE = 30;
const MAX_PAGES = 20;
const KEEP_LIVE = 200;

const REGULAR_DRAW_TIMES = new Set(Array.from({ length: 48 }, (_, index) => {
  const totalMinutes = 25 + index * 30;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}));

const HEADERS = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0'
};

function validDate(s) {
  const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return d.getUTCFullYear() === 2000 + Number(m[3])
    && d.getUTCMonth() === Number(m[2]) - 1
    && d.getUTCDate() === Number(m[1]);
}

function normalizeDraw(d) {
  const x = {
    id: Number(d?.id),
    date: String(d?.date ?? ''),
    time: String(d?.time ?? ''),
    a: Number(d?.a),
    b: Number(d?.b),
    c: Number(d?.c)
  };
  if (!Number.isInteger(x.id) || x.id < 100000 || x.id > 999999) return null;
  if (!validDate(x.date) || !REGULAR_DRAW_TIMES.has(x.time)) return null;
  if (![x.a, x.b, x.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9)) return null;
  return x;
}

function parseOfficialDate(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    date: `${m[3]}.${m[2]}.${String(m[1]).slice(-2)}`,
    time: `${m[4]}:${m[5]}`
  };
}

function parseEpochMoscow(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(Number(seconds) * 1000));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.day}.${p.month}.${p.year}`, time: `${p.hour}:${p.minute}` };
}

function apiDrawToRow(raw) {
  const dt = parseOfficialDate(raw?.date);
  const nums = raw?.combination?.structured ?? raw?.winningCombination ?? [];
  if (!dt || !Array.isArray(nums) || nums.length < 3) return null;
  return normalizeDraw({ id: raw.number, date: dt.date, time: dt.time, a: nums[0], b: nums[1], c: nums[2] });
}

function completedToRow(raw) {
  const dt = parseEpochMoscow(raw?.date);
  const nums = raw?.combination?.structured ?? raw?.combination?.serialized ?? [];
  if (!dt || !Array.isArray(nums) || nums.length < 3) return null;
  return normalizeDraw({ id: raw.number, date: dt.date, time: dt.time, a: nums[0], b: nums[1], c: nums[2] });
}

function sameDraw(a, b) {
  return !!a && !!b && a.id === b.id && a.date === b.date && a.time === b.time
    && a.a === b.a && a.b === b.b && a.c === b.c;
}

function dedupe(draws) {
  const map = new Map();
  for (const raw of draws) {
    const d = normalizeDraw(raw);
    if (d) map.set(d.id, d);
  }
  return [...map.values()].sort((a, b) => b.id - a.id);
}

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json();
}

async function fetchOfficialLatest() {
  const j = await getJson(INFO_API);
  const game = (j?.games || []).find(x => x?.name === 'top-3');
  const row = completedToRow(game?.completedDraw);
  if (!row) throw new Error('games/info-new не вернул корректный completedDraw TOP-3');
  return row;
}

async function fetchArchiveSince(localLatest) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${ARCHIVE_API}?game=top3&count=${PAGE_SIZE}&page=${page}`;
    const j = await getJson(url);
    const rows = (j?.draws || []).map(apiDrawToRow).filter(Boolean);
    if (!rows.length) break;
    out.push(...rows);
    const oldest = rows[rows.length - 1]?.id ?? Infinity;
    if (oldest <= localLatest) break;
    if (rows.length < PAGE_SIZE) break;
  }
  return dedupe(out);
}

const live = JSON.parse(await fs.readFile(LIVE_FILE, 'utf8'));
const existing = dedupe(live?.draws || []);
const localLatest = Math.max(Number(live?.latest || 0), existing[0]?.id || 0);

const [officialLatest, archiveRows] = await Promise.all([
  fetchOfficialLatest(),
  fetchArchiveSince(localLatest)
]);

const archiveLatest = archiveRows[0];
if (!archiveLatest) throw new Error('официальный архив TOP-3 вернул пустой список');
if (!sameDraw(officialLatest, archiveLatest)) {
  throw new Error(`двойная проверка не совпала: info-new=${JSON.stringify(officialLatest)} archive=${JSON.stringify(archiveLatest)}`);
}

const newRows = archiveRows.filter(d => d.id > localLatest);
if (newRows.length) {
  const expected = localLatest + 1;
  const oldestNew = newRows[newRows.length - 1].id;
  if (localLatest && oldestNew !== expected) {
    throw new Error(`обнаружен разрыв архива: было №${localLatest}, первый новый №${oldestNew}`);
  }
  for (let i = newRows.length - 1; i > 0; i -= 1) {
    if (newRows[i - 1].id !== newRows[i].id + 1) {
      throw new Error(`разрыв внутри новых тиражей: №${newRows[i].id} → №${newRows[i - 1].id}`);
    }
  }
}

const merged = dedupe([...archiveRows, ...existing]).slice(0, KEEP_LIVE);
const nextLatest = merged[0]?.id || localLatest;
const payload = {
  schema: 3,
  source: 'Полный архив TOP-3 · официальный API Столото (archive + info-new, двойная проверка)',
  updatedAt: new Date().toISOString(),
  latest: nextLatest,
  regularTimes: [...REGULAR_DRAW_TIMES],
  forecasts: Array.isArray(live?.forecasts) ? live.forecasts : [],
  draws: merged
};

if (newRows.length === 0) {
  console.log(`TOP3 актуален: №${localLatest}; официальный последний №${officialLatest.id} ${officialLatest.date} ${officialLatest.time}=${officialLatest.a}${officialLatest.b}${officialLatest.c}`);
} else {
  console.log(`TOP3 добавлено ${newRows.length}: №${newRows[newRows.length - 1].id}…№${newRows[0].id}; последний ${newRows[0].date} ${newRows[0].time}=${newRows[0].a}${newRows[0].b}${newRows[0].c}`);
}

await fs.writeFile(LIVE_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
