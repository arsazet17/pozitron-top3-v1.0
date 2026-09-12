import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const API_ROOTS = [
  'https://www.stoloto.ru/p/api/mobile/api/v35/service',
  'https://m.stoloto.ru/p/api/mobile/api/v35/service'
];
const INFO_URLS = API_ROOTS.map(root => `${root}/games/info-new`);
const ARCHIVE_GAMES = ['top-3', 'top3'];
const PAGE_SIZE = 30;
const MAX_PAGES = 20;
const KEEP_LIVE = 200;
const REQUEST_TIMEOUT_MS = 12000;

const REGULAR_DRAW_TIMES = new Set(Array.from({ length: 48 }, (_, index) => {
  const totalMinutes = 25 + index * 30;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}));

const HEADERS = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (compatible; Yulia-TOP3-Updater/1.3)'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  return { date: `${m[3]}.${m[2]}.${String(m[1]).slice(-2)}`, time: `${m[4]}:${m[5]}` };
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

async function getJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      headers: HEADERS,
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : (error?.message || String(error));
    throw new Error(`${reason}: ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialLatest() {
  const settled = await Promise.allSettled(INFO_URLS.map(url => getJson(url)));
  const rows = [];
  const errors = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === 'rejected') {
      errors.push(result.reason?.message || String(result.reason));
      continue;
    }
    const game = (result.value?.games || []).find(x => x?.name === 'top-3');
    const row = completedToRow(game?.completedDraw);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new Error(`games/info-new недоступен на обоих хостах: ${errors.join(' | ') || 'нет корректного completedDraw'}`);
  return rows.sort((a, b) => b.id - a.id)[0];
}

async function fetchArchivePage(page) {
  const requests = [];
  for (const root of API_ROOTS) {
    for (const game of ARCHIVE_GAMES) {
      const url = `${root}/draws/archive?game=${encodeURIComponent(game)}&count=${PAGE_SIZE}&page=${page}`;
      requests.push({ url, promise: getJson(url) });
    }
  }

  const settled = await Promise.allSettled(requests.map(x => x.promise));
  const candidates = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status !== 'fulfilled') continue;
    const rows = dedupe((result.value?.draws || []).map(apiDrawToRow).filter(Boolean));
    if (rows.length) candidates.push({ rows, url: requests[i].url });
  }
  if (!candidates.length) throw new Error(`официальный архив недоступен/пуст на странице ${page}`);
  candidates.sort((a, b) => (b.rows[0]?.id || 0) - (a.rows[0]?.id || 0) || b.rows.length - a.rows.length);
  return candidates[0];
}

async function fetchArchiveSince(localLatest) {
  const out = [];
  let sourceUrl = '';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageResult = await fetchArchivePage(page);
    sourceUrl = pageResult.url;
    const rows = pageResult.rows;
    out.push(...rows);
    const oldest = rows[rows.length - 1]?.id ?? Infinity;
    if (oldest <= localLatest || rows.length < PAGE_SIZE) break;
  }
  return { rows: dedupe(out), sourceUrl };
}

async function confirmInfoNew(expected) {
  await sleep(1200);
  const again = await fetchOfficialLatest();
  if (!sameDraw(expected, again)) {
    throw new Error(`games/info-new изменился между проверками: first=${JSON.stringify(expected)} second=${JSON.stringify(again)}`);
  }
  return again;
}

async function confirmArchive(localLatest, initialRows) {
  let previous = initialRows;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1200);
    const next = (await fetchArchiveSince(localLatest)).rows;
    if (previous[0] && next[0] && sameDraw(previous[0], next[0])) return next;
    previous = next;
  }
  throw new Error('свежая вершина архива не подтвердилась повторным чтением');
}

async function verifySources(officialLatest, archiveRows, localLatest) {
  const archiveLatest = archiveRows[0] || null;

  if (!officialLatest) {
    if (!archiveLatest) throw new Error('оба официальных источника временно недоступны');
    const confirmedRows = await confirmArchive(localLatest, archiveRows);
    return { sourceRows: confirmedRows, mode: 'archive-double+info-unavailable' };
  }

  if (!archiveLatest) {
    const confirmed = await confirmInfoNew(officialLatest);
    return { sourceRows: [confirmed], mode: 'info-new-double+archive-unavailable' };
  }

  if (sameDraw(officialLatest, archiveLatest)) {
    return { sourceRows: archiveRows, mode: 'archive+info-new' };
  }

  if (archiveLatest.id > officialLatest.id) {
    const common = archiveRows.find(d => d.id === officialLatest.id);
    if (!sameDraw(common, officialLatest)) {
      throw new Error(`источники разошлись на общем тираже: info-new=${JSON.stringify(officialLatest)} archive-common=${JSON.stringify(common)}`);
    }
    const confirmedRows = await confirmArchive(localLatest, archiveRows);
    return { sourceRows: confirmedRows, mode: 'archive-double+info-common' };
  }

  const confirmedInfo = await confirmInfoNew(officialLatest);
  let confirmRows = archiveRows;
  try {
    confirmRows = (await fetchArchiveSince(localLatest)).rows;
  } catch (error) {
    console.log(`ARCHIVE RETRY WARNING: ${error?.message || error}`);
  }

  const confirmLatest = confirmRows[0] || null;
  if (confirmLatest && confirmLatest.id >= confirmedInfo.id) {
    const common = confirmRows.find(d => d.id === confirmedInfo.id);
    if (!sameDraw(common, confirmedInfo)) {
      throw new Error(`архив догнал/обогнал info-new, но общий тираж не совпал`);
    }
    return { sourceRows: confirmRows, mode: 'archive-caught-up+info-new' };
  }

  return { sourceRows: dedupe([confirmedInfo, ...confirmRows]), mode: 'info-new-double+archive-backfill' };
}

const live = JSON.parse(await fs.readFile(LIVE_FILE, 'utf8'));
const existing = dedupe(live?.draws || []);
const localLatest = Math.max(Number(live?.latest || 0), existing[0]?.id || 0);

const [infoResult, archiveResult] = await Promise.allSettled([
  fetchOfficialLatest(),
  fetchArchiveSince(localLatest)
]);

const officialLatest = infoResult.status === 'fulfilled' ? infoResult.value : null;
const firstArchiveRows = archiveResult.status === 'fulfilled' ? archiveResult.value.rows : [];
if (infoResult.status === 'rejected') console.log(`INFO WARNING: ${infoResult.reason?.message || infoResult.reason}`);
if (archiveResult.status === 'rejected') console.log(`ARCHIVE WARNING: ${archiveResult.reason?.message || archiveResult.reason}`);

const verified = await verifySources(officialLatest, firstArchiveRows, localLatest);
const sourceRows = verified.sourceRows;
const sourceLatest = sourceRows[0] || officialLatest;

const newRows = sourceRows.filter(d => d.id > localLatest);
if (newRows.length) {
  const expected = localLatest + 1;
  const oldestNew = newRows[newRows.length - 1].id;
  if (localLatest && oldestNew !== expected) {
    throw new Error(`обнаружен разрыв архива: было №${localLatest}, первый новый №${oldestNew}; свежий тираж не записываю до дозаполнения пропуска`);
  }
  for (let i = newRows.length - 1; i > 0; i -= 1) {
    if (newRows[i - 1].id !== newRows[i].id + 1) {
      throw new Error(`разрыв внутри новых тиражей: №${newRows[i].id} → №${newRows[i - 1].id}`);
    }
  }
}

const merged = dedupe([...sourceRows, ...existing]).slice(0, KEEP_LIVE);
const nextLatest = merged[0]?.id || localLatest;
const payload = {
  schema: 4,
  source: `Полный архив TOP-3 · официальный API Столото (${verified.mode})`,
  updatedAt: new Date().toISOString(),
  latest: nextLatest,
  regularTimes: [...REGULAR_DRAW_TIMES],
  forecasts: Array.isArray(live?.forecasts) ? live.forecasts : [],
  draws: merged
};

if (newRows.length === 0) {
  console.log(`TOP3 без новых строк: локально №${localLatest}; источник №${sourceLatest?.id ?? '—'} ${sourceLatest?.date ?? ''} ${sourceLatest?.time ?? ''}`);
} else {
  console.log(`TOP3 добавлено ${newRows.length}: №${newRows[newRows.length - 1].id}…№${newRows[0].id}; последний ${newRows[0].date} ${newRows[0].time}=${newRows[0].a}${newRows[0].b}${newRows[0].c}`);
}

await fs.writeFile(LIVE_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
