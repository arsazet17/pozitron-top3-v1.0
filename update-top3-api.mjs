import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const HISTORY_FILE = new URL('./top3-history.json', import.meta.url);
const API_ROOTS = [
  'https://m.stoloto.ru/p/api/mobile/api/v35/service',
  'https://www.stoloto.ru/p/api/mobile/api/v35/service'
];
const INFO_URLS = API_ROOTS.map(root => `${root}/games/info-new`);
const ARCHIVE_GAMES = ['top-3', 'top3'];
const PAGE_SIZE = 30;
const MAX_PAGES = 20;
const KEEP_LIVE = 200;
const REQUEST_TIMEOUT_MS = 15000;

const REGULAR_DRAW_TIMES = new Set(Array.from({ length: 48 }, (_, index) => {
  const totalMinutes = 25 + index * 30;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}));

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
  referer: 'https://www.stoloto.ru/',
  'content-type': 'application/x-www-form-urlencoded',
  'device-type': 'STOLOTO',
  'device-platform': 'DESKTOP',
  'gosloto-partner': 'bXMjXFRXZ3coWXh6R3s1NTdUX3dnWlBMLUxmdg',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
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
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : (error?.message || String(error));
      lastError = new Error(`${reason}: ${url}`);
      if (attempt < 3) await sleep(900 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`не удалось получить ${url}`);
}

async function fetchOfficialLatest() {
  const rows = [];
  const errors = [];
  for (const url of INFO_URLS) {
    try {
      const j = await getJson(url);
      const game = (j?.games || []).find(x => x?.name === 'top-3');
      const row = completedToRow(game?.completedDraw);
      if (row) rows.push(row);
      else errors.push(`${url}: нет корректного completedDraw top-3`);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  if (!rows.length) throw new Error(`games/info-new недоступен: ${errors.join(' | ')}`);
  return rows.sort((a, b) => b.id - a.id)[0];
}

async function fetchArchivePage(page) {
  const candidates = [];
  const errors = [];
  for (const root of API_ROOTS) {
    for (const game of ARCHIVE_GAMES) {
      const url = `${root}/draws/archive?game=${encodeURIComponent(game)}&count=${PAGE_SIZE}&page=${page}`;
      try {
        const j = await getJson(url);
        const rows = dedupe((j?.draws || []).map(apiDrawToRow).filter(Boolean));
        if (rows.length) candidates.push({ rows, url });
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }
  }
  if (!candidates.length) throw new Error(`официальный архив недоступен/пуст на странице ${page}: ${errors.join(' | ')}`);
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
  await sleep(1400);
  const again = await fetchOfficialLatest();
  if (!sameDraw(expected, again)) {
    throw new Error(`games/info-new изменился между проверками: first=${JSON.stringify(expected)} second=${JSON.stringify(again)}`);
  }
  return again;
}

async function confirmArchive(localLatest, initialRows) {
  let previous = initialRows;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(1400);
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
      throw new Error('архив догнал/обогнал info-new, но общий тираж не совпал');
    }
    return { sourceRows: confirmRows, mode: 'archive-caught-up+info-new' };
  }

  return { sourceRows: dedupe([confirmedInfo, ...confirmRows]), mode: 'info-new-double+archive-backfill' };
}

// ===== СЕРВЕРНЫЙ ПРОГНОЗ: СОХРАНЕНА ЛОГИКА Yulia TOP-3 =====

function serverMod10(value) {
  return ((Number(value) % 10) + 10) % 10;
}

function serverDigitsOf(draw) {
  return draw ? [Number(draw.a), Number(draw.b), Number(draw.c)] : [0, 0, 0];
}

function serverCodeOfDigits(values) {
  return values.map(serverMod10).join('');
}

function serverDifference(older, newer) {
  if (!older || !newer) return null;
  const from = serverDigitsOf(older);
  const to = serverDigitsOf(newer);
  return to.map((value, index) => serverMod10(value - from[index]));
}

function serverParseDrawDate(dateText) {
  const match = String(dateText || '').match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(2000 + Number(match[3]), Number(match[2]) - 1, Number(match[1])));
}

function serverFormatDrawDate(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function serverNextDrawAfterLatest(latest) {
  const times = [...REGULAR_DRAW_TIMES];
  if (!latest) return { date: '', time: '' };
  const [currentHour, currentMinute] = String(latest.time).split(':').map(Number);
  const currentMinutes = currentHour * 60 + currentMinute;

  let nextTime = times.find(time => {
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute > currentMinutes;
  });

  const date = serverParseDrawDate(latest.date) || new Date();

  if (!nextTime) {
    nextTime = times[0];
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return {
    date: serverFormatDrawDate(date),
    time: nextTime,
    weekday: date.getUTCDay(),
    dayGap: 1
  };
}

function serverDrawsForTime(time, sourceDraws) {
  return sourceDraws
    .filter(draw => draw.time === time)
    .sort((a, b) => b.id - a.id);
}

function serverDateGapDays(older, newer) {
  const olderDate = serverParseDrawDate(older?.date);
  const newerDate = serverParseDrawDate(newer?.date);
  if (!olderDate || !newerDate) return 1;
  return Math.max(1, Math.round((newerDate - olderDate) / 86400000));
}

function serverNextSameTime(latest, time) {
  if (!latest) return { date: '', time, weekday: 0, dayGap: 1 };
  const date = serverParseDrawDate(latest.date) || new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return { date: serverFormatDrawDate(date), time, weekday: date.getUTCDay(), dayGap: 1 };
}

function serverBuildTransitions(time, sourceDraws) {
  const ordered = serverDrawsForTime(time, sourceDraws).reverse();
  const records = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const date = serverParseDrawDate(current.date);

    records.push({
      previous,
      current,
      delta: serverDifference(previous, current),
      weekday: date ? date.getUTCDay() : 0,
      dayGap: serverDateGapDays(previous, current)
    });
  }

  return records;
}

function serverEmptyCounts() {
  return Array(10).fill(0);
}

function serverIncrementArray(array, digit) {
  array[serverMod10(digit)] += 1;
}

function serverIncrementMap(map, key, digit) {
  const normalizedKey = String(key);
  if (!map.has(normalizedKey)) map.set(normalizedKey, serverEmptyCounts());
  serverIncrementArray(map.get(normalizedKey), digit);
}

function serverCreateAiModel() {
  return Array.from({ length: 3 }, () => ({
    global: serverEmptyCounts(),
    weekday: new Map(),
    source: new Map(),
    gap: new Map(),
    previousDelta: new Map(),
    previousFullDelta: new Map(),
    history2: new Map(),
    history3: new Map(),
    history5: new Map()
  }));
}

function serverHistoryKey(records, index, position, length) {
  if (index < length) return null;
  return records.slice(index - length, index).map(record => record.delta[position]).join('|');
}

function serverAddAiRecord(model, records, index) {
  const record = records[index];
  if (!record) return;

  const previousRecord = records[index - 1] || null;

  for (let position = 0; position < 3; position += 1) {
    const target = record.delta[position];
    const sourceDigit = serverDigitsOf(record.previous)[position];
    const bucket = model[position];

    serverIncrementArray(bucket.global, target);
    serverIncrementMap(bucket.weekday, record.weekday, target);
    serverIncrementMap(bucket.source, sourceDigit, target);
    serverIncrementMap(bucket.gap, Math.min(7, record.dayGap || 1), target);

    if (previousRecord) {
      serverIncrementMap(bucket.previousDelta, previousRecord.delta[position], target);
      serverIncrementMap(bucket.previousFullDelta, serverCodeOfDigits(previousRecord.delta), target);
    }

    const key2 = serverHistoryKey(records, index, position, 2);
    const key3 = serverHistoryKey(records, index, position, 3);
    const key5 = serverHistoryKey(records, index, position, 5);

    if (key2 !== null) serverIncrementMap(bucket.history2, key2, target);
    if (key3 !== null) serverIncrementMap(bucket.history3, key3, target);
    if (key5 !== null) serverIncrementMap(bucket.history5, key5, target);
  }
}

function serverCountsSupport(counts) {
  return counts ? counts.reduce((sum, value) => sum + value, 0) : 0;
}

function serverSmoothedProbability(counts, digit, alpha = 1) {
  const support = serverCountsSupport(counts);
  return (Number(counts?.[digit] || 0) + alpha) / (support + alpha * 10);
}

function serverAddEvidence(scores, counts, baseWeight, supportScale, alpha = 1) {
  const support = serverCountsSupport(counts);
  if (!support) return;

  const adaptiveWeight = baseWeight * Math.min(1, Math.log1p(support) / Math.log1p(supportScale));

  for (let digit = 0; digit < 10; digit += 1) {
    scores[digit] += adaptiveWeight * Math.log(serverSmoothedProbability(counts, digit, alpha));
  }
}

function serverRecentCounts(records, position, count) {
  const result = serverEmptyCounts();
  records.slice(-count).forEach(record => serverIncrementArray(result, record.delta[position]));
  return result;
}

function serverNormalizeScores(scores) {
  const maximum = Math.max(...scores);
  const exponentials = scores.map(score => Math.exp(score - maximum));
  const sum = exponentials.reduce((total, value) => total + value, 0) || 1;
  return exponentials.map(value => value / sum);
}

function serverContextHistoryKey(records, position, length) {
  if (records.length < length) return null;
  return records.slice(-length).map(record => record.delta[position]).join('|');
}

function serverPredictPosition(model, records, position, context) {
  const bucket = model[position];
  const scores = Array(10).fill(0);

  serverAddEvidence(scores, bucket.global, 1.20, 1600, 1.25);
  serverAddEvidence(scores, bucket.weekday.get(String(context.weekday)), 0.28, 260, 1.6);
  serverAddEvidence(scores, bucket.source.get(String(context.sourceDigits[position])), 0.68, 180, 1.45);
  serverAddEvidence(scores, bucket.gap.get(String(Math.min(7, context.dayGap || 1))), 0.20, 220, 1.8);

  if (context.previousRecord) {
    serverAddEvidence(scores, bucket.previousDelta.get(String(context.previousRecord.delta[position])), 0.72, 180, 1.5);
    serverAddEvidence(scores, bucket.previousFullDelta.get(serverCodeOfDigits(context.previousRecord.delta)), 0.24, 25, 2.4);
  }

  const key2 = serverContextHistoryKey(records, position, 2);
  const key3 = serverContextHistoryKey(records, position, 3);
  const key5 = serverContextHistoryKey(records, position, 5);

  if (key2 !== null) serverAddEvidence(scores, bucket.history2.get(key2), 0.50, 70, 2.1);
  if (key3 !== null) serverAddEvidence(scores, bucket.history3.get(key3), 0.30, 35, 2.5);
  if (key5 !== null) serverAddEvidence(scores, bucket.history5.get(key5), 0.18, 16, 3.0);

  serverAddEvidence(scores, serverRecentCounts(records, position, 10), 0.36, 10, 2.2);
  serverAddEvidence(scores, serverRecentCounts(records, position, 20), 0.34, 20, 2.0);
  serverAddEvidence(scores, serverRecentCounts(records, position, 50), 0.28, 50, 1.8);
  serverAddEvidence(scores, serverRecentCounts(records, position, 200), 0.18, 200, 1.5);

  const probabilities = serverNormalizeScores(scores);

  return probabilities
    .map((probability, digit) => ({ digit, probability }))
    .sort((first, second) => second.probability - first.probability || first.digit - second.digit);
}

function normalizeStoredForecast(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const targetId = Number(raw.targetId);
  const variants = Array.isArray(raw.variants)
    ? raw.variants.map(value => String(value || '')).filter(value => /^\d{3}$/.test(value)).slice(0, 3)
    : [];

  const delta = String(raw.delta || '');
  const deltaVariants = Array.isArray(raw.deltaVariants)
    ? raw.deltaVariants.map(value => String(value || '')).filter(value => /^\d{3}$/.test(value)).slice(0, 3)
    : [];

  if (!Number.isInteger(targetId) || targetId <= 0 || variants.length !== 3 || !/^\d{3}$/.test(delta)) {
    return null;
  }

  return {
    id: String(raw.id || `server-auto-${targetId}`),
    automatic: true,
    server: true,
    createdAt: String(raw.createdAt || new Date(0).toISOString()),
    targetId,
    targetDate: String(raw.targetDate || ''),
    targetTime: String(raw.targetTime || ''),
    baseId: Number(raw.baseId) || null,
    baseCode: /^\d{3}$/.test(String(raw.baseCode || '')) ? String(raw.baseCode) : '',
    delta,
    deltaVariants: deltaVariants.length ? deltaVariants : [delta],
    variants
  };
}

function buildServerForecast(sourceDraws, createdAt = new Date().toISOString()) {
  const history = dedupe(sourceDraws);
  const latestOverall = history[0] || null;
  if (!latestOverall) return null;

  const target = serverNextDrawAfterLatest(latestOverall);
  const timeDraws = serverDrawsForTime(target.time, history);
  const latestAtTime = timeDraws[0] || null;
  const records = serverBuildTransitions(target.time, history);

  if (!latestAtTime || records.length < 10) return null;

  const model = serverCreateAiModel();
  records.forEach((_, index) => serverAddAiRecord(model, records, index));

  const next = serverNextSameTime(latestAtTime, target.time);
  const context = {
    weekday: next.weekday,
    dayGap: next.dayGap || 1,
    sourceDigits: serverDigitsOf(latestAtTime),
    previousRecord: records.at(-1) || null
  };

  const rankings = [0, 1, 2].map(position => serverPredictPosition(model, records, position, context));

  const deltaVariants = [0, 1, 2].map(rankIndex =>
    rankings.map(ranking => ranking[rankIndex]?.digit ?? ranking[0]?.digit ?? 0)
  );

  const variants = deltaVariants.map(deltaDigits =>
    serverDigitsOf(latestAtTime).map((digit, index) => serverMod10(digit + deltaDigits[index]))
  );

  const targetId = Number(latestOverall.id) + 1;

  return {
    id: `server-auto-${targetId}`,
    automatic: true,
    server: true,
    createdAt,
    targetId,
    targetDate: next.date || target.date,
    targetTime: target.time,
    baseId: latestAtTime.id,
    baseCode: serverCodeOfDigits(serverDigitsOf(latestAtTime)),
    delta: serverCodeOfDigits(deltaVariants[0]),
    deltaVariants: deltaVariants.map(serverCodeOfDigits),
    variants: variants.map(serverCodeOfDigits)
  };
}

function ensureServerForecast(existingForecasts, historyDraws) {
  const forecasts = Array.isArray(existingForecasts)
    ? existingForecasts.map(normalizeStoredForecast).filter(Boolean)
    : [];

  const generated = buildServerForecast(historyDraws);

  if (generated && !forecasts.some(item => Number(item.targetId) === generated.targetId)) {
    forecasts.push(generated);
  }

  return forecasts
    .sort((first, second) => Number(first.targetId) - Number(second.targetId));
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

// Для прогноза нужна полная история по каждому времени, а не только live-хвост.
let permanentDraws = [];
try {
  const permanent = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8'));
  permanentDraws = dedupe(Array.isArray(permanent) ? permanent : (permanent?.draws || []));
} catch (error) {
  console.log(`FORECAST HISTORY WARNING: ${error?.message || error}`);
}
const forecastHistory = dedupe([...permanentDraws, ...merged]);
const forecasts = ensureServerForecast(live?.forecasts || [], forecastHistory);
const payload = {
  schema: 4,
  source: `Полный архив TOP-3 · официальный API Столото (${verified.mode})`,
  updatedAt: new Date().toISOString(),
  latest: nextLatest,
  regularTimes: [...REGULAR_DRAW_TIMES],
  forecasts,
  draws: merged
};

if (newRows.length === 0) {
  console.log(`TOP3 без новых строк: локально №${localLatest}; источник №${sourceLatest?.id ?? '—'} ${sourceLatest?.date ?? ''} ${sourceLatest?.time ?? ''}`);
} else {
  console.log(`TOP3 добавлено ${newRows.length}: №${newRows[newRows.length - 1].id}…№${newRows[0].id}; последний ${newRows[0].date} ${newRows[0].time}=${newRows[0].a}${newRows[0].b}${newRows[0].c}`);
}

await fs.writeFile(LIVE_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
