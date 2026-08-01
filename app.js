'use strict';

const APP_VERSION = '1.0.23';
const DB_NAME = 'yulia-top3-db';
const DB_VERSION = 1;
const STORE = 'draws';
const DRAW_TIMES = ['02:40','04:40','06:40','07:40','09:40','11:40','13:40','16:25','21:25','22:40'];
const AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_STATUS_KEY = 'yulia-top3-auto-status-v1';
const ARCHIVE_MODE_KEY = 'yulia-top3-archive-mode-v1';
const ARCHIVE_TIME_KEY = 'yulia-top3-archive-time-v1';
const ARCHIVE_SCOPE_KEY = 'yulia-top3-archive-scope-v1';
const AI_TIME_KEY = 'yulia-top3-ai-time-v1';
const FORECAST_ARCHIVE_KEY = 'yulia-top3-forecast-archive-v2-auto';
const LUCKY_ARCHIVE_URL = 'https://lucky-numbers.ru/lottery/ru/top3';
const LIVE_DATA_URL = './top3-live.json';

let db;
let draws = [];
let archiveShown = 50;
let toastTimer;
let syncInProgress = false;
let autoCheckTimer = null;
let syncStatus = loadSyncStatus();
let storageReady = false;
let eventsBound = false;
let archiveMode = 'normal';
let archiveTime = '13:40';
let archiveSearchScope = 'selected';
let aiSelectedTime = '13:40';
let aiCache = new Map();
let forecastArchive = loadForecastArchive();

const VERIFIED_CORRECTIONS = [
  // Эти строки уже есть во встроенном архиве и используются только для
  // точечного возврата записей, которые успел исказить старый общий файл.
  { id:267356, date:'30.07.26', time:'09:40', a:8, b:8, c:3 },
  { id:267355, date:'30.07.26', time:'07:40', a:6, b:3, c:8 },
  { id:267354, date:'30.07.26', time:'06:40', a:0, b:3, c:9 }
];

const $ = (id) => document.getElementById(id);
const qsa = (sel) => [...document.querySelectorAll(sel)];

function hideLoadingOverlay() {
  const loading = $('loading');
  if (!loading) return;
  loading.classList.add('hidden');
  loading.setAttribute('hidden', '');
  loading.style.display = 'none';
}

function setUpdateButtonsReady() {
  const busy = syncStatus.state === 'checking';
  const disabled = busy || !storageReady;
  for (const id of ['refreshBtn','onlineUpdateBtn','dataOnlineUpdateBtn']) {
    const button = $(id);
    if (button) {
      button.disabled = disabled;
      button.title = !storageReady ? 'Локальная база ещё загружается' : '';
    }
  }
}

function withTimeout(promise, ms, label='Операция') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: превышено время ожидания`)), ms))
  ]);
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB не поддерживается'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('Не удалось открыть базу'));
    request.onblocked = () => reject(new Error('База заблокирована другой вкладкой'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Транзакция отменена'));
  });
}

async function countDB() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function seedObjects() {
  const seed = Array.isArray(window.TOP3_SEED) ? window.TOP3_SEED : [];
  const map = new Map(seed.map(row => [Number(row[0]), {
    id:Number(row[0]), date:String(row[1]), time:String(row[2]),
    a:Number(row[3]), b:Number(row[4]), c:Number(row[5])
  }]));
  for (const item of VERIFIED_CORRECTIONS) map.set(item.id, { ...item });
  return [...map.values()].sort((a,b) => b.id-a.id);
}

async function seedDatabase(force = false) {
  if (!db) throw new Error('Локальная база не открыта');
  if (!Array.isArray(window.TOP3_SEED)) throw new Error('Встроенный архив не найден');
  const existing = await withTimeout(countDB(), 6000, 'Проверка базы');
  if (existing && !force) return;
  if (force) {
    const clearTx = db.transaction(STORE, 'readwrite');
    clearTx.objectStore(STORE).clear();
    await withTimeout(txDone(clearTx), 6000, 'Очистка базы');
  }
  const rows = seedObjects();
  const batchSize = 500;
  for (let offset=0; offset<rows.length; offset+=batchSize) {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows.slice(offset, offset+batchSize)) store.put(row);
    await withTimeout(txDone(tx), 12000, 'Сохранение архива');
  }
}

async function applyVerifiedCorrections() {
  if (!db) return;
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const row of VERIFIED_CORRECTIONS) store.put({ ...row });
  await withTimeout(txDone(tx), 6000, 'Исправление проверенных тиражей');
}

async function removeOnlyKnownCorruptedRows() {
  if (!db) return;
  const bad = new Map([
    [267359, {a:3,b:4,c:6}],
    [267358, {a:3,b:5,c:7}],
    [267357, {a:3,b:6,c:7}]
  ]);
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const [id, signature] of bad) {
    const current = await new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (current && current.a === signature.a && current.b === signature.b && current.c === signature.c) {
      store.delete(id);
    }
  }
  await withTimeout(txDone(tx), 6000, 'Очистка ошибочных строк старого обновления');
}

async function loadAllDraws() {
  if (!db) return;
  const result = await withTimeout(new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error('Не удалось прочитать базу'));
  }), 12000, 'Чтение архива');
  draws = result.sort((x, y) => y.id - x.id);
}

function isValidDraw(d) {
  return Number.isInteger(d.id)
    && d.id > 0
    && /^\d{2}\.\d{2}\.\d{2}$/.test(d.date)
    && /^\d{2}:\d{2}$/.test(d.time)
    && [d.a,d.b,d.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9);
}

async function addNewDrawsOnly(items) {
  const existingIds = new Set(draws.map(d => d.id));
  const unique = new Map();
  for (const raw of items) {
    const item = {
      id: Number(raw.id),
      date: normalizeDate(String(raw.date || '')),
      time: normalizeTime(String(raw.time || '')),
      a: Number(raw.a), b: Number(raw.b), c: Number(raw.c)
    };
    if (isValidDraw(item) && !existingIds.has(item.id) && !unique.has(item.id)) unique.set(item.id, item);
  }
  const fresh = [...unique.values()].sort((a,b) => a.id - b.id);
  if (!fresh.length) return { added: 0, skipped: items.length };
  if (!db || !storageReady) throw new Error('Локальная база ещё не готова. Повтори действие через несколько секунд.');
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const d of fresh) store.add(d);
  await txDone(tx);
  return { added: fresh.length, skipped: Math.max(0, items.length - fresh.length) };
}

function patternOf(d) {
  const set = new Set([d.a,d.b,d.c]);
  if (set.size === 1) return 'три одинаковые';
  if (set.size === 2) return 'пара';
  return 'три разные';
}

function mod10(value) {
  return ((Number(value) % 10) + 10) % 10;
}

function digitsOf(draw) {
  return draw ? [Number(draw.a), Number(draw.b), Number(draw.c)] : [0,0,0];
}

function codeOfDigits(values) {
  return values.map(mod10).join('');
}

function mirrorDigit(value) {
  return mod10(10 - Number(value));
}

function mirrorDigits(values) {
  return values.map(mirrorDigit);
}

function positronDifference(older, newer) {
  if (!older || !newer) return null;
  const from = digitsOf(older);
  const to = digitsOf(newer);
  return to.map((value, index) => mod10(value - from[index]));
}

function archiveModeMeta(mode = archiveMode) {
  const modes = {
    normal: {
      title: 'Обычный архив',
      help: 'Показываются фактические комбинации из трёх независимых полей 0–9.'
    },
    'normal-diff': {
      title: 'Обычный архив + разница',
      help: 'Разница +Δ показывает переход от предыдущего тиража этого же времени к текущему по модулю 10.'
    },
    mirror: {
      title: 'Зеркальный архив',
      help: 'Каждое поле зеркалится отдельно: 0↔0, 1↔9, 2↔8, 3↔7, 4↔6, 5↔5.'
    },
    'mirror-diff': {
      title: 'Зеркальный архив + разница',
      help: 'Показаны зеркальные комбинации и зеркальная разница между соседними днями этого же времени.'
    }
  };
  return modes[mode] || modes.normal;
}

function renderArchiveDigits(values, extraClass = '') {
  return `<div class="mini-digits ${extraClass}">${values.map(value => `<b>${mod10(value)}</b>`).join('')}</div>`;
}

function parseDrawDate(dateText) {
  const match = String(dateText || '').match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(2000 + Number(match[3]), Number(match[2]) - 1, Number(match[1])));
}

function formatDrawDate(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function nextDrawAfterLatest(latest) {
  if (!latest) return { date:'—', time:'—', weekday:0 };
  const currentMinutes = (() => {
    const [h,m] = String(latest.time).split(':').map(Number);
    return h * 60 + m;
  })();
  let nextTime = DRAW_TIMES.find(time => {
    const [h,m] = time.split(':').map(Number);
    return h * 60 + m > currentMinutes;
  });
  const date = parseDrawDate(latest.date) || new Date();
  if (!nextTime) {
    nextTime = DRAW_TIMES[0];
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return { date:formatDrawDate(date), time:nextTime, weekday:date.getUTCDay() };
}

function drawsForTime(time, sourceDraws = draws) {
  return sourceDraws
    .filter(draw => draw.time === time)
    .sort((a,b) => b.id - a.id);
}

function dateGapDays(older, newer) {
  const olderDate = parseDrawDate(older?.date);
  const newerDate = parseDrawDate(newer?.date);
  if (!olderDate || !newerDate) return 1;
  return Math.max(1, Math.round((newerDate - olderDate) / 86400000));
}

function nextSameTimeAfterLatest(latest, time) {
  if (!latest) return { date:'—', time, weekday:0, dayGap:1 };
  const date = parseDrawDate(latest.date) || new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return { date:formatDrawDate(date), time, weekday:date.getUTCDay(), dayGap:1 };
}

function buildPositronTransitionsForTime(time, sourceDraws = draws) {
  const ordered = drawsForTime(time, sourceDraws).reverse();
  const records = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const delta = positronDifference(previous, current);
    const date = parseDrawDate(current.date);
    records.push({
      previous,
      current,
      delta,
      time,
      weekday:date ? date.getUTCDay() : 0,
      dayGap:dateGapDays(previous, current)
    });
  }
  return records;
}

function emptyDigitCounts() {
  return Array(10).fill(0);
}

function incrementArray(array, digit) {
  array[mod10(digit)] += 1;
}

function incrementMap(map, key, digit) {
  const normalizedKey = String(key);
  if (!map.has(normalizedKey)) map.set(normalizedKey, emptyDigitCounts());
  incrementArray(map.get(normalizedKey), digit);
}

function createAiModel() {
  return Array.from({length:3}, () => ({
    global:emptyDigitCounts(),
    weekday:new Map(),
    source:new Map(),
    gap:new Map(),
    previousDelta:new Map(),
    previousFullDelta:new Map(),
    history2:new Map(),
    history3:new Map(),
    history5:new Map()
  }));
}

function historyKey(records, index, position, length) {
  if (index < length) return null;
  return records.slice(index - length, index).map(record => record.delta[position]).join('|');
}

function addAiRecord(model, records, index) {
  const record = records[index];
  if (!record) return;
  const previousRecord = records[index - 1] || null;
  for (let position = 0; position < 3; position++) {
    const target = record.delta[position];
    const sourceDigit = digitsOf(record.previous)[position];
    const bucket = model[position];
    incrementArray(bucket.global, target);
    incrementMap(bucket.weekday, record.weekday, target);
    incrementMap(bucket.source, sourceDigit, target);
    incrementMap(bucket.gap, Math.min(7, record.dayGap || 1), target);
    if (previousRecord) {
      incrementMap(bucket.previousDelta, previousRecord.delta[position], target);
      incrementMap(bucket.previousFullDelta, codeOfDigits(previousRecord.delta), target);
    }
    const key2 = historyKey(records, index, position, 2);
    const key3 = historyKey(records, index, position, 3);
    const key5 = historyKey(records, index, position, 5);
    if (key2 !== null) incrementMap(bucket.history2, key2, target);
    if (key3 !== null) incrementMap(bucket.history3, key3, target);
    if (key5 !== null) incrementMap(bucket.history5, key5, target);
  }
}

function countsSupport(counts) {
  return counts ? counts.reduce((sum, value) => sum + value, 0) : 0;
}

function smoothedProbability(counts, digit, alpha = 1) {
  const support = countsSupport(counts);
  return (Number(counts?.[digit] || 0) + alpha) / (support + alpha * 10);
}

function addEvidence(scores, counts, baseWeight, supportScale, alpha = 1) {
  const support = countsSupport(counts);
  if (!support) return;
  const adaptiveWeight = baseWeight * Math.min(1, Math.log1p(support) / Math.log1p(supportScale));
  for (let digit = 0; digit < 10; digit++) {
    scores[digit] += adaptiveWeight * Math.log(smoothedProbability(counts, digit, alpha));
  }
}

function recentCounts(records, position, count) {
  const result = emptyDigitCounts();
  records.slice(-count).forEach(record => incrementArray(result, record.delta[position]));
  return result;
}

function normalizeScores(scores) {
  const maximum = Math.max(...scores);
  const exponentials = scores.map(score => Math.exp(score - maximum));
  const sum = exponentials.reduce((total, value) => total + value, 0) || 1;
  return exponentials.map(value => value / sum);
}

function contextHistoryKey(records, position, length) {
  if (records.length < length) return null;
  return records.slice(-length).map(record => record.delta[position]).join('|');
}

function predictAiPosition(model, records, position, context) {
  const bucket = model[position];
  const scores = Array(10).fill(0);
  addEvidence(scores, bucket.global, 1.20, 1600, 1.25);
  addEvidence(scores, bucket.weekday.get(String(context.weekday)), 0.28, 260, 1.6);
  addEvidence(scores, bucket.source.get(String(context.sourceDigits[position])), 0.68, 180, 1.45);
  addEvidence(scores, bucket.gap.get(String(Math.min(7, context.dayGap || 1))), 0.20, 220, 1.8);
  if (context.previousRecord) {
    addEvidence(scores, bucket.previousDelta.get(String(context.previousRecord.delta[position])), 0.72, 180, 1.5);
    addEvidence(scores, bucket.previousFullDelta.get(codeOfDigits(context.previousRecord.delta)), 0.24, 25, 2.4);
  }
  const key2 = contextHistoryKey(records, position, 2);
  const key3 = contextHistoryKey(records, position, 3);
  const key5 = contextHistoryKey(records, position, 5);
  if (key2 !== null) addEvidence(scores, bucket.history2.get(key2), 0.50, 70, 2.1);
  if (key3 !== null) addEvidence(scores, bucket.history3.get(key3), 0.30, 35, 2.5);
  if (key5 !== null) addEvidence(scores, bucket.history5.get(key5), 0.18, 16, 3.0);
  addEvidence(scores, recentCounts(records, position, 10), 0.36, 10, 2.2);
  addEvidence(scores, recentCounts(records, position, 20), 0.34, 20, 2.0);
  addEvidence(scores, recentCounts(records, position, 50), 0.28, 50, 1.8);
  addEvidence(scores, recentCounts(records, position, 200), 0.18, 200, 1.5);
  const probabilities = normalizeScores(scores);
  return probabilities.map((probability, digit) => ({digit, probability}))
    .sort((a,b) => b.probability - a.probability || a.digit - b.digit);
}

function predictAiTransition(model, records, context) {
  return [0,1,2].map(position => predictAiPosition(model, records, position, context));
}

function aiContextForNext(records, latest, next) {
  return {
    weekday:next.weekday,
    dayGap:next.dayGap || 1,
    sourceDigits:digitsOf(latest),
    previousRecord:records.at(-1) || null
  };
}

function aiContextForRecord(records, index) {
  const record = records[index];
  return {
    weekday:record.weekday,
    dayGap:record.dayGap || 1,
    sourceDigits:digitsOf(record.previous),
    previousRecord:records[index - 1] || null
  };
}

function runAiBacktest(records, testSize = 250) {
  if (records.length < 350) return null;
  const start = Math.max(220, records.length - testSize);
  const model = createAiModel();
  for (let index = 0; index < start; index++) addAiRecord(model, records, index);
  const stats = {
    tested:0,
    fieldTop1:[0,0,0],
    fieldTop3:[0,0,0],
    atLeastOneTop1:0,
    atLeastTwoTop1:0,
    allThreeTop1:0,
    atLeastOneTop3:0,
    atLeastTwoTop3:0
  };
  for (let index = start; index < records.length; index++) {
    const recentHistory = records.slice(Math.max(0, index - 300), index);
    const predictions = predictAiTransition(model, recentHistory, aiContextForRecord(records, index));
    let hitsTop1 = 0;
    let hitsTop3 = 0;
    predictions.forEach((ranking, position) => {
      const target = records[index].delta[position];
      if (ranking[0]?.digit === target) {
        stats.fieldTop1[position] += 1;
        hitsTop1 += 1;
      }
      if (ranking.slice(0,3).some(item => item.digit === target)) {
        stats.fieldTop3[position] += 1;
        hitsTop3 += 1;
      }
    });
    if (hitsTop1 >= 1) stats.atLeastOneTop1 += 1;
    if (hitsTop1 >= 2) stats.atLeastTwoTop1 += 1;
    if (hitsTop1 === 3) stats.allThreeTop1 += 1;
    if (hitsTop3 >= 1) stats.atLeastOneTop3 += 1;
    if (hitsTop3 >= 2) stats.atLeastTwoTop3 += 1;
    stats.tested += 1;
    addAiRecord(model, records, index);
  }
  return stats;
}

function buildAiAnalysisForTime(time) {
  const timeDraws = drawsForTime(time);
  const latest = timeDraws[0] || null;
  const cacheKey = `${time}|${timeDraws.length}|${latest?.id || 0}|${latest ? drawCode(latest) : ''}`;
  if (aiCache.has(cacheKey)) return aiCache.get(cacheKey);
  const records = buildPositronTransitionsForTime(time);
  if (!records.length || !latest) return null;
  const model = createAiModel();
  records.forEach((_, index) => addAiRecord(model, records, index));
  const next = nextSameTimeAfterLatest(latest, time);
  const rankings = predictAiTransition(model, records, aiContextForNext(records, latest, next));
  const primaryDelta = rankings.map(ranking => ranking[0].digit);
  const predictedDigits = digitsOf(latest).map((digit, index) => mod10(digit + primaryDelta[index]));
  const backtestSize = Math.min(300, Math.max(150, Math.floor(records.length * 0.18)));
  const backtest = runAiBacktest(records, backtestSize);
  const value = {time, timeDraws, latest, records, next, rankings, primaryDelta, predictedDigits, backtest};
  aiCache.set(cacheKey, value);
  return value;
}

function pct(value, total, digits = 1) {
  return total ? `${(value / total * 100).toFixed(digits)}%` : '—';
}

function aiSignalInfo(analysis) {
  const probabilities = analysis.rankings.map(ranking => ranking[0]?.probability || 0);
  const gaps = analysis.rankings.map(ranking => (ranking[0]?.probability || 0) - (ranking[1]?.probability || 0));
  const averageProbability = probabilities.reduce((sum, value) => sum + value, 0) / 3;
  const averageGap = gaps.reduce((sum, value) => sum + value, 0) / 3;
  const tested = analysis.backtest?.tested || 0;
  const top1 = tested ? analysis.backtest.atLeastOneTop1 / tested : 0;
  if (averageProbability >= 0.17 && averageGap >= 0.035 && top1 >= 0.285) return {label:'Повышенный сигнал',className:'strong'};
  if (averageProbability >= 0.135 && averageGap >= 0.018 && top1 >= 0.275) return {label:'Средний сигнал',className:'medium'};
  return {label:'Слабый сигнал',className:'weak'};
}

function renderTimeChips(containerId, selectedTime, attributeName) {
  const container = $(containerId);
  if (!container) return;
  const includeAllArchive = attributeName === 'archive-time';
  const allButton = includeAllArchive
    ? `<button class="time-chip all-times ${selectedTime === 'all' ? 'active' : ''}" type="button" data-${attributeName}="all"><strong>ВСЕ</strong><small>${draws.length.toLocaleString('ru-RU')}</small></button>`
    : '';
  const timeButtons = DRAW_TIMES.map(time => {
    const count = drawsForTime(time).length;
    return `<button class="time-chip ${time === selectedTime ? 'active' : ''}" type="button" data-${attributeName}="${time}"><strong>${time}</strong><small>${count.toLocaleString('ru-RU')}</small></button>`;
  }).join('');
  container.innerHTML = allButton + timeButtons;
}

function renderAiInto(ids, time) {
  const contextNode = $(ids.context);
  if (!contextNode) return;
  const analysis = buildAiAnalysisForTime(time);
  if (ids.title && $(ids.title)) $(ids.title).textContent = `ИИ Позитрон · ${time}`;
  if (!analysis) {
    contextNode.textContent = `Недостаточно переходов в архиве ${time}.`;
    $(ids.main).innerHTML = '';
    $(ids.columns).innerHTML = '';
    $(ids.backtest).innerHTML = '';
    return;
  }
  const signal = aiSignalInfo(analysis);
  const badge = $(ids.badge);
  badge.textContent = signal.label;
  badge.className = `ai-signal ${signal.className}`;
  contextNode.innerHTML = `<div><span>Последний факт ${time}</span><strong>№${analysis.latest.id} · ${drawCode(analysis.latest)}</strong><small>${analysis.latest.date}</small></div><div><span>Следующая цель</span><strong>${analysis.next.date} · ${time}</strong><small>${analysis.records.length.toLocaleString('ru-RU')} переходов в обучении</small></div>`;
  const mirrorDelta = mirrorDigits(analysis.primaryDelta);
  $(ids.main).innerHTML = `
    <div class="ai-main-block"><span>Основной переход ${time}</span><strong>+${codeOfDigits(analysis.primaryDelta)}</strong><small>зеркальный +${codeOfDigits(mirrorDelta)}</small></div>
    <div class="ai-main-arrow">→</div>
    <div class="ai-main-block result"><span>Расчётная комбинация</span><strong>${codeOfDigits(analysis.predictedDigits)}</strong><small>${drawCode(analysis.latest)} + ${codeOfDigits(analysis.primaryDelta)} по модулю 10</small></div>`;
  $(ids.columns).innerHTML = analysis.rankings.map((ranking, position) => {
    const candidates = ranking.slice(0,3);
    return `<article class="ai-column-card">
      <span>ПОЛЕ ${position + 1}</span>
      <strong>${candidates[0].digit}</strong>
      <div class="ai-candidates">${candidates.map((item,index) => `<b class="ai-candidate ${index === 0 ? 'primary' : ''}"><span>${item.digit}</span><small>${(item.probability*100).toFixed(1)}%</small></b>`).join('')}</div>
    </article>`;
  }).join('');
  const test = analysis.backtest;
  if (!test) {
    $(ids.backtest).textContent = 'Для честного теста этого временного архива пока недостаточно истории.';
  } else {
    $(ids.backtest).innerHTML = `<div class="ai-backtest-title"><span>Проверка модели ${time}</span><strong>${test.tested} переходов</strong></div>
      <div class="ai-metrics">
        <div><span>Хотя бы 1 точное поле</span><b>${pct(test.atLeastOneTop1,test.tested)}</b></div>
        <div><span>Хотя бы 2 точных поля</span><b>${pct(test.atLeastTwoTop1,test.tested)}</b></div>
        <div><span>Все 3 точных поля</span><b>${pct(test.allThreeTop1,test.tested,2)}</b></div>
        <div><span>1 поле в тройке кандидатов</span><b>${pct(test.atLeastOneTop3,test.tested)}</b></div>
        <div><span>2 поля в тройке кандидатов</span><b>${pct(test.atLeastTwoTop3,test.tested)}</b></div>
      </div>
      <p class="ai-honesty">Результаты считаются только на прошлых фактах выбранного времени. Слабый сигнал означает, что модель не показала устойчивого преимущества.</p>`;
  }
}

function renderAiPanel() {
  const nextTime = nextDrawAfterLatest(draws[0]).time;
  renderAiInto({
    title:'aiTitle', badge:'aiSignalBadge', context:'aiContext', main:'aiMainPrediction',
    columns:'aiColumnPredictions', backtest:'aiBacktest'
  }, nextTime);
}

function renderAiTimeView() {
  renderTimeChips('aiTimeChips', aiSelectedTime, 'ai-time');
  const count = drawsForTime(aiSelectedTime).length;
  const summary = $('aiTimeSummary');
  if (summary) summary.textContent = `${aiSelectedTime} · ${count.toLocaleString('ru-RU')} тиражей · ${Math.max(0,count-1).toLocaleString('ru-RU')} переходов между днями`;
  renderAiInto({
    title:'aiTimePanelTitle', badge:'aiTimeSignalBadge', context:'aiTimeContext', main:'aiTimeMainPrediction',
    columns:'aiTimeColumnPredictions', backtest:'aiTimeBacktest'
  }, aiSelectedTime);
}


function drawCard(d, index) {
  if (!d) return '';
  const repeat = index > 0 && draws[index - 1]
    ? [d.a,d.b,d.c].filter((n,i) => n === [draws[index-1].a,draws[index-1].b,draws[index-1].c][i]).length
    : 0;
  return `<article class="draw-card ${index === 0 ? 'primary' : ''}">
    <div class="draw-head"><div><span class="eyebrow">${index === 0 ? 'ПОСЛЕДНИЙ' : index === 1 ? 'ПРЕДЫДУЩИЙ' : 'ПРЕДПРЕДЫДУЩИЙ'}</span><h3>Тираж № ${d.id}</h3><p>${d.date} · ${d.time}</p></div><span class="draw-tag">${patternOf(d)}</span></div>
    <div class="draw-digits"><div class="ball">${d.a}</div><div class="ball">${d.b}</div><div class="ball">${d.c}</div></div>
    <div class="draw-meta"><span>Сумма: ${d.a+d.b+d.c}</span><span>Чётных: ${[d.a,d.b,d.c].filter(n=>n%2===0).length}</span>${index>0?`<span>На тех же местах: ${repeat}</span>`:''}</div>
  </article>`;
}

function quickStatsData(list) {
  if (!list.length) return [];
  let pair = 0, triple = 0, exactRepeat = 0;
  for (let i=0;i<list.length;i++) {
    const s = new Set([list[i].a,list[i].b,list[i].c]).size;
    if (s===2) pair++;
    if (s===1) triple++;
    if (i>0 && list[i].a===list[i-1].a && list[i].b===list[i-1].b && list[i].c===list[i-1].c) exactRepeat++;
  }
  const avg = list.reduce((sum,d)=>sum+d.a+d.b+d.c,0)/list.length;
  return [
    ['Пар с повтором', pair],
    ['Троек одинаковых', triple],
    ['Средняя сумма', avg.toFixed(1)],
    ['Точных повторов подряд', exactRepeat]
  ];
}


function automaticForecastVariants(analysis) {
  if (!analysis) return null;
  const deltaVariants = [0,1,2].map(rankIndex => analysis.rankings.map(ranking => ranking[rankIndex]?.digit ?? ranking[0]?.digit ?? 0));
  const combinations = deltaVariants.map(deltaDigits => analysis.latest
    ? digitsOf(analysis.latest).map((digit,index)=>mod10(digit + deltaDigits[index]))
    : []);
  return {
    targetId: Number(draws[0]?.id || 0) + 1,
    targetTime: analysis.next?.time || nextDrawAfterLatest(draws[0]).time,
    targetDate: analysis.next?.date || '',
    baseId: analysis.latest?.id || null,
    baseCode: analysis.latest ? drawCode(analysis.latest) : '',
    delta: codeOfDigits(deltaVariants[0]),
    deltaVariants: deltaVariants.map(codeOfDigits),
    variants: combinations.map(codeOfDigits)
  };
}

function ensureAutomaticForecast() {
  if (!draws[0]) return null;
  const targetId = Number(draws[0].id) + 1;
  let item = forecastArchive.find(entry => Number(entry.targetId) === targetId && entry.automatic);
  if (item) return item;
  const nextTime = nextDrawAfterLatest(draws[0]).time;
  const analysis = buildAiAnalysisForTime(nextTime);
  const generated = automaticForecastVariants(analysis);
  if (!generated || generated.variants.some(code => !/^\d{3}$/.test(code))) return null;
  item = {
    id:`auto-${targetId}`,
    automatic:true,
    createdAt:new Date().toISOString(),
    targetId:generated.targetId,
    targetDate:generated.targetDate,
    targetTime:generated.targetTime,
    baseId:generated.baseId,
    baseCode:generated.baseCode,
    delta:generated.delta,
    deltaVariants:generated.deltaVariants,
    variants:generated.variants
  };
  forecastArchive.push(item);
  forecastArchive = forecastArchive
    .sort((a,b)=>Number(a.targetId)-Number(b.targetId))
    .slice(-120);
  saveForecastArchive();
  return item;
}

function forecastVariantTile(code, index) {
  const labels=['Вариант 1','Вариант 2','Вариант 3'];
  return `<div class="home-forecast-variant variant-${index+1}"><span>${labels[index]}</span><strong>${code}</strong></div>`;
}

function compactForecastChain(item, maxLength=5) {
  const ordered=[...draws].sort((a,b)=>Number(a.id)-Number(b.id));
  const start=ordered.findIndex(draw=>Number(draw.id)===Number(item.targetId));
  if (start<0) return '<p class="home-forecast-waiting">Прогнозный тираж ещё не вышел. Проверка появится автоматически после факта.</p>';
  const variants=(item.variants||[]).filter(Boolean);
  const predictedDeltas=[item.delta,...(item.deltaVariants||[])].filter(Boolean);
  const realFacts=ordered.slice(start,Math.min(ordered.length,start+maxLength));
  return realFacts.map((draw,index)=>{
    const actual=drawCode(draw);
    const previous=index===0 ? previousOverallDraw(draw.id) : realFacts[index-1];
    const actualDelta=previous ? codeOfDigits(positronDifference(previous,draw)) : '';
    const deltaHit=actualDelta && predictedDeltas.includes(actualDelta);
    const infos=variants.map(v=>forecastHitInfo(v,actual));
    const full=infos.some(info=>info.full);
    const exact=Math.max(0,...infos.map(info=>info.exactCount));
    const present=Math.max(0,...infos.map(info=>info.presentCount));
    const pairs=[...new Set(infos.flatMap(info=>info.pairs))];
    let result='нет совпадений';
    if(full) result='полное совпадение';
    else if(exact>=2) result=`${exact} поля по месту`;
    else if(pairs.length) result=`пара ${pairs.join(', ')}`;
    else if(present) result=`совпало цифр: ${present}`;
    return `<div class="home-forecast-chain-row ${full?'full-hit':pairs.length?'pair-hit':''}">
      <div><strong>${index===0?'Факт':`Через ${index}`}</strong><small>№${draw.id} · ${draw.date} · ${draw.time}</small></div>
      ${highlightedActualDigits(actual,variants)}
      <div class="home-forecast-chain-result"><span>${result}</span>${actualDelta?`<small class="${deltaHit?'delta-hit':''}">Δ +${actualDelta}${deltaHit?' — совпала':''}</small>`:''}</div>
    </div>`;
  }).join('');
}

function renderHomeForecast() {
  const panel=$('homeForecastPanel');
  if(!panel) return;
  const current=ensureAutomaticForecast();
  const latestFactId=Number(draws[0]?.id || 0);
  const checked=[...forecastArchive]
    .filter(item=>item.automatic && Number(item.targetId)===latestFactId && drawById(item.targetId))
    .sort((a,b)=>Number(b.targetId)-Number(a.targetId))[0] || null;
  if(!current){
    panel.innerHTML='<span class="eyebrow">ПРОГНОЗ НА СЛЕДУЮЩИЙ ТИРАЖ</span><p class="panel-note">Недостаточно данных для автоматического расчёта.</p>';
    return;
  }
  const variants=(current.variants||[]).slice(0,3);
  panel.innerHTML=`
    <div class="home-forecast-head">
      <div><span class="eyebrow">ПРОГНОЗ НА СЛЕДУЮЩИЙ ТИРАЖ</span><h3>Тираж №${current.targetId}</h3><p>${current.targetDate||''}${current.targetTime?` · ${current.targetTime}`:''}</p></div>
      <div class="home-forecast-delta"><span>Предполагаемая разница</span><strong>+${current.delta}</strong></div>
    </div>
    <div class="home-forecast-variants">${variants.map(forecastVariantTile).join('')}</div>
    ${checked?`<details class="home-forecast-details"><summary>Проверка прогноза по прошедшим тиражам №${checked.targetId}</summary><p class="home-forecast-facts-note">Ниже показаны только тиражи, которые уже есть в архиве.</p><div class="home-forecast-chain">${compactForecastChain(checked,5)}</div></details>`:'<p class="home-forecast-waiting">Проверка появится здесь после выхода тиража, на который был сделан текущий прогноз.</p>'}
  `;
}

function renderHome() {
  $('latestCards').innerHTML = draws.slice(0,3).map((d,i)=>drawCard(d,i)).join('');
  renderHomeForecast();
  $('quickStats').innerHTML = quickStatsData(draws.slice(0,100)).map(([k,v])=>`<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
  if (draws[0]) {
    $('manualId').value = draws[0].id + 1;
    const now = new Date();
    $('manualDate').value = new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'2-digit'}).format(now);
  }
  $('nextDraw').textContent = nextMoscowDraw();
  renderSyncStatus();
  renderAiPanel();
}

function parseArchiveSearch(rawValue) {
  const text = String(rawValue || '').trim().toLowerCase();
  if (!text) return null;
  const compact = text.replace(/\s+/g, '');

  // +106 means one thing only: the exact displayed Positron difference.
  if (/^\+\d{3}$/.test(compact)) return { type: 'delta', value: compact.slice(1) };

  // №267106 or #267106 means the exact draw number.
  if (/^[№#]\d+$/.test(compact)) return { type: 'id', value: Number(compact.slice(1)) };

  // A bare three-digit value is an exact displayed combination, never part of a draw ID.
  if (/^\d{3}$/.test(compact)) return { type: 'combination', value: compact };

  // Long bare numbers are treated as draw numbers for the familiar 267354-style search.
  if (/^\d{4,}$/.test(compact)) return { type: 'id', value: Number(compact) };

  return { type: 'text', value: text };
}

function buildSameTimeOlderMap() {
  const map = new Map();
  for (const time of DRAW_TIMES) {
    const list = drawsForTime(time);
    list.forEach((draw,index) => map.set(draw.id, list[index + 1] || null));
  }
  return map;
}

function buildAllArchiveOlderMap() {
  const map = new Map();
  const ordered = [...draws].sort((a,b) => b.id - a.id);
  ordered.forEach((draw,index) => map.set(draw.id, ordered[index + 1] || null));
  return map;
}

function archiveEquationHtml(olderDigits, deltaDigits, currentDigits) {
  return `<div class="positron-equation">
    <div><span>Предыдущая</span>${renderArchiveDigits(olderDigits)}</div>
    <b class="equation-sign">+</b>
    <div><span>Разница</span>${renderArchiveDigits(deltaDigits, 'delta-digits')}</div>
    <b class="equation-sign">=</b>
    <div><span>Результат</span>${renderArchiveDigits(currentDigits)}</div>
  </div>`;
}

function renderArchive(reset = false) {
  if (reset) archiveShown = Number($('archiveLimit').value) || 50;
  renderTimeChips('archiveTimeChips', archiveTime, 'archive-time');
  const allArchiveSelected = archiveTime === 'all';
  const selectedDraws = allArchiveSelected
    ? [...draws].sort((a,b) => b.id - a.id)
    : drawsForTime(archiveTime);
  $('archiveTimeSummary').textContent = allArchiveSelected
    ? `ВСЕ ВРЕМЕНА · ${selectedDraws.length.toLocaleString('ru-RU')} тиражей · разницы считаются между соседними комбинациями`
    : `${archiveTime} · ${selectedDraws.length.toLocaleString('ru-RU')} тиражей · ${Math.max(0, selectedDraws.length - 1).toLocaleString('ru-RU')} переходов между днями`;
  if ($('archiveSearchScope')) $('archiveSearchScope').value = archiveSearchScope;

  const query = parseArchiveSearch($('archiveSearch').value);
  const sameTimeOlderById = buildSameTimeOlderMap();
  const allArchiveOlderById = buildAllArchiveOlderMap();
  const olderById = allArchiveSelected ? allArchiveOlderById : sameTimeOlderById;
  const mirrorMode = archiveMode.startsWith('mirror');
  const searchAllTimes = allArchiveSelected || (Boolean(query) && archiveSearchScope === 'all');
  const source = searchAllTimes ? draws : selectedDraws;

  const searchable = draw => {
    const older = olderById.get(draw.id) || null;
    const normal = digitsOf(draw);
    const displayedDigits = mirrorMode ? mirrorDigits(normal) : normal;
    const delta = positronDifference(older, draw);
    const displayedDelta = delta ? (mirrorMode ? mirrorDigits(delta) : delta) : null;
    if (query.type === 'delta') return Boolean(displayedDelta) && codeOfDigits(displayedDelta) === query.value;
    if (query.type === 'combination') return codeOfDigits(displayedDigits) === query.value;
    if (query.type === 'id') return draw.id === query.value;
    return [draw.date, draw.time, patternOf(draw)]
      .some(value => String(value).toLowerCase().includes(query.value));
  };

  const filtered = query ? source.filter(searchable) : source;
  const visible = filtered.slice(0, archiveShown);
  const meta = archiveModeMeta();
  const scopeLabel = allArchiveSelected ? 'весь архив' : (searchAllTimes ? 'все 10 времён' : archiveTime);
  $('archiveInfo').textContent = `${filtered.length.toLocaleString('ru-RU')} тиражей · ${scopeLabel} · ${meta.title}`;
  $('archiveModeHelp').textContent = meta.help;
  qsa('.archive-mode-btn').forEach(button => button.classList.toggle('active', button.dataset.archiveMode === archiveMode));

  $('archiveList').innerHTML = visible.map(draw => {
    const older = olderById.get(draw.id) || null;
    const normal = digitsOf(draw);
    const delta = positronDifference(older, draw);
    const isMirror = archiveMode.startsWith('mirror');
    const showDifference = archiveMode.endsWith('diff') || query?.type === 'delta';
    const displayedDigits = isMirror ? mirrorDigits(normal) : normal;
    const displayedOlder = older ? (isMirror ? mirrorDigits(digitsOf(older)) : digitsOf(older)) : null;
    const displayedDelta = delta ? (isMirror ? mirrorDigits(delta) : delta) : null;
    const gap = older ? dateGapDays(older, draw) : null;
    const gapBadge = gap && gap > 1 ? `<span class="gap-badge">Интервал ${gap} дня</span>` : '';
    const sourceText = older
      ? (allArchiveSelected
        ? `переход от соседнего тиража №${older.id} · ${older.date} · ${older.time}`
        : `переход от №${older.id} · ${older.date} · ${draw.time}`)
      : (allArchiveSelected ? 'первый тираж общего архива' : 'первый тираж этой временной цепочки');

    let expanded = '';
    if (showDifference && older && displayedDelta) {
      expanded = `${archiveEquationHtml(displayedOlder, displayedDelta, displayedDigits)}
        <p class="archive-formula"><strong>${codeOfDigits(displayedOlder)} + ${codeOfDigits(displayedDelta)} = ${codeOfDigits(displayedDigits)}</strong> · три независимых поля, модуль 10</p>`;
    } else if (isMirror) {
      expanded = `<div class="mirror-explanation"><span>Обычная комбинация</span>${renderArchiveDigits(normal)}<b>→</b><span>Зеркальная</span>${renderArchiveDigits(displayedDigits, 'mirror-digits')}</div>`;
    } else {
      expanded = `<p class="archive-formula">Фактическая комбинация из трёх независимых полей: <strong>${codeOfDigits(normal)}</strong>.</p>`;
    }

    return `<details class="archive-row archive-detail-row ${showDifference ? 'with-difference' : ''}">
      <summary>
        <div class="archive-row-info"><h4>№ ${draw.id}</h4><p>${draw.date} · ${draw.time} · ${sourceText}</p>${gapBadge}</div>
        <div class="archive-values">
          ${renderArchiveDigits(displayedDigits, isMirror ? 'mirror-digits' : '')}
          ${showDifference ? `<div class="positron-difference ${displayedDelta ? '' : 'empty'}"><span>Δ</span><strong>${displayedDelta ? `+${codeOfDigits(displayedDelta)}` : '—'}</strong></div>` : ''}
          <span class="details-chevron">⌄</span>
        </div>
      </summary>
      <div class="archive-expanded">${expanded}</div>
    </details>`;
  }).join('') || '<div class="empty-result">По выбранным условиям ничего не найдено.</div>';
  $('loadMoreBtn').hidden = visible.length >= filtered.length;
}


function frequency(list, key) {
  const counts = Array(10).fill(0);
  list.forEach(d => counts[d[key]]++);
  return counts;
}

function renderFrequencyGroup(list, key, title) {
  const counts = frequency(list,key);
  const max = Math.max(...counts,1);
  return `<div class="freq-group"><h4>${title}</h4><div class="freq-list">${counts.map((n,d)=>`<div class="freq-row"><b>${d}</b><span class="bar"><i style="width:${(n/max*100).toFixed(1)}%"></i></span><em>${n}</em></div>`).join('')}</div></div>`;
}

function transitionPrediction(list, key, current) {
  const ordered = [...list].sort((a,b)=>a.id-b.id);
  const counts = Array(10).fill(0);
  let total = 0;
  for (let i=0;i<ordered.length-1;i++) {
    if (ordered[i][key] === current) { counts[ordered[i+1][key]]++; total++; }
  }
  const ranked = counts.map((n,d)=>({d,n})).sort((x,y)=>y.n-x.n || x.d-y.d);
  return { top: ranked[0], total };
}


function drawCode(d) {
  return d ? `${d.a}${d.b}${d.c}` : '—';
}

function getAnalysisList() {
  const value = $('analysisRange').value;
  return value === 'all' ? draws : draws.slice(0, Number(value));
}

function digitScopeOptions(length) {
  if (length === 1) return [
    ['any','В любом из трёх столбцов'],
    ['1','Только 1-й столбец'],
    ['2','Только 2-й столбец'],
    ['3','Только 3-й столбец']
  ];
  if (length === 2) return [
    ['12','Точно в столбцах 1–2'],
    ['23','Точно в столбцах 2–3'],
    ['13','Точно в столбцах 1–3'],
    ['any','В любых двух столбцах, порядок точный'],
    ['unordered','В любых двух столбцах, порядок не важен']
  ];
  return [
    ['exact','Точная тройка 1–2–3'],
    ['unordered','Те же три цифры в любом порядке']
  ];
}

function updateDigitSearchControls({ keepValues = true } = {}) {
  const length = Number($('digitSearchLength').value) || 1;
  const oldScope = $('digitSearchScope').value;
  $('digitSearchScope').innerHTML = digitScopeOptions(length).map(([value,label])=>`<option value="${value}">${label}</option>`).join('');
  if ([...$('digitSearchScope').options].some(o=>o.value===oldScope)) $('digitSearchScope').value=oldScope;
  ['digitSearchA','digitSearchB','digitSearchC'].forEach((id,index)=>{
    const input=$(id);
    const label=input.closest('label');
    const visible=index<length;
    label.classList.toggle('hidden',!visible);
    input.required=visible;
    if (!visible && !keepValues) input.value='';
  });
}

function readDigitQuery() {
  const length=Number($('digitSearchLength').value)||1;
  const ids=['digitSearchA','digitSearchB','digitSearchC'];
  const digits=ids.slice(0,length).map(id=>Number($(id).value));
  if (digits.some(n=>!Number.isInteger(n)||n<0||n>9)) return null;
  return {length,scope:$('digitSearchScope').value,digits};
}

function matchesDigitQuery(draw, query) {
  const values=[draw.a,draw.b,draw.c];
  const {length,scope,digits}=query;
  if (length===1) {
    if (scope==='1') return values[0]===digits[0];
    if (scope==='2') return values[1]===digits[0];
    if (scope==='3') return values[2]===digits[0];
    return values.includes(digits[0]);
  }
  if (length===2) {
    const pairs=scope==='12' ? [[values[0],values[1]]]
      : scope==='23' ? [[values[1],values[2]]]
      : scope==='13' ? [[values[0],values[2]]]
      : [[values[0],values[1]],[values[0],values[2]],[values[1],values[2]]];
    if (scope==='unordered') {
      const wanted=[...digits].sort((a,b)=>a-b).join('');
      return pairs.some(pair=>[...pair].sort((a,b)=>a-b).join('')===wanted);
    }
    return pairs.some(pair=>pair[0]===digits[0]&&pair[1]===digits[1]);
  }
  if (scope==='unordered') return [...values].sort((a,b)=>a-b).join('')===[...digits].sort((a,b)=>a-b).join('');
  return values.every((value,index)=>value===digits[index]);
}

function contextNode(draw, className='') {
  if (!draw) return '<span class="context-node"><b>—</b><small>нет тиража</small></span>';
  return `<span class="context-node ${className}"><b>${drawCode(draw)}</b><small>№${draw.id}</small></span>`;
}

function renderDigitSearch() {
  const query=readDigitQuery();
  if (!query) {
    $('digitSearchSummary').textContent='Введи цифры от 0 до 9.';
    $('digitSearchResults').innerHTML='';
    return;
  }
  const list=getAnalysisList();
  const matches=list.filter(d=>matchesDigitQuery(d,query));
  const digitsText=query.digits.join('–');
  $('digitSearchSummary').innerHTML=`Запрос: <strong>${digitsText}</strong>. Найдено <strong>${matches.length.toLocaleString('ru-RU')}</strong> совпадений среди ${list.length.toLocaleString('ru-RU')} тиражей. Показаны последние ${Math.min(matches.length,50)}.`;
  if (!matches.length) {
    $('digitSearchResults').innerHTML='<div class="empty-result">Совпадений в выбранном периоде нет.</div>';
    return;
  }
  const indexById=new Map(draws.map((d,index)=>[d.id,index]));
  $('digitSearchResults').innerHTML=matches.slice(0,50).map(d=>{
    const index=indexById.get(d.id);
    const previous=Number.isInteger(index)?draws[index+1]:null;
    const next=Number.isInteger(index)?draws[index-1]:null;
    return `<article class="search-result-row">
      <div class="search-result-head"><strong>№ ${d.id} · ${drawCode(d)}</strong><span>${d.date} · ${d.time}</span></div>
      <div class="context-chain">${contextNode(previous)}<span class="context-arrow">→</span>${contextNode(d,'match')}<span class="context-arrow">→</span>${contextNode(next)}</div>
    </article>`;
  }).join('');
}

function renderRecentChain() {
  const latest=[...draws.slice(0,10)].reverse();
  $('recentChain').innerHTML=latest.map((d,index)=>`${index?'<span class="recent-chain-arrow">→</span>':''}<span class="recent-chain-item"><b>${drawCode(d)}</b><small>№${d.id}</small></span>`).join('');
}

function sequenceMatchAt(ordered,start,sequence,getValue) {
  for (let offset=0;offset<sequence.length;offset++) {
    if (getValue(ordered[start+offset])!==sequence[offset]) return false;
  }
  return true;
}

function findContinuations(sourceDraws, chainLength, getValue) {
  const ordered=[...sourceDraws].sort((a,b)=>a.id-b.id);
  const latest=ordered.slice(-chainLength);
  const sequence=latest.map(getValue);
  const occurrences=[];
  const counts=new Map();
  const lastPossible=ordered.length-chainLength-1;
  for (let start=0;start<=lastPossible;start++) {
    if (!sequenceMatchAt(ordered,start,sequence,getValue)) continue;
    const end=start+chainLength-1;
    const next=ordered[end+1];
    const value=getValue(next);
    counts.set(String(value),(counts.get(String(value))||0)+1);
    occurrences.push({start:ordered[start],end:ordered[end],next,value});
  }
  const ranked=[...counts.entries()].map(([value,count])=>({value,count})).sort((a,b)=>b.count-a.count||String(a.value).localeCompare(String(b.value),'ru',{numeric:true}));
  return {sequence,occurrences:occurrences.reverse(),ranked,total:occurrences.length};
}

function continuationRows(result, maxItems=5) {
  if (!result.total) return '<div class="empty-result">В архиве ещё не найдено такого продолжения.</div>';
  const max=result.ranked[0]?.count||1;
  return `<div class="continuation-list">${result.ranked.slice(0,maxItems).map(item=>{
    const pct=Math.round(item.count/result.total*100);
    return `<div class="continuation-item"><b>${item.value}</b><span class="continuation-bar"><i style="width:${(item.count/max*100).toFixed(1)}%"></i></span><small>${item.count} · ${pct}%</small></div>`;
  }).join('')}</div>`;
}

function chainExamples(result) {
  if (!result.total) return '';
  return `<div class="chain-examples">Последние примеры: ${result.occurrences.slice(0,5).map(o=>`№${o.start.id}${o.end.id!==o.start.id?`–№${o.end.id}`:''} → №${o.next.id} (${o.value})`).join(' · ')}</div>`;
}

function renderChainSearch() {
  const chainLength=Math.min(3,Math.max(1,Number($('chainLength').value)||1));
  if (draws.length<=chainLength) {
    $('chainSearchSummary').textContent='В базе пока недостаточно тиражей для поиска.';
    $('chainSearchResults').innerHTML='';
    return;
  }
  const configs=[
    {title:'1-я позиция',get:d=>d.a},
    {title:'2-я позиция',get:d=>d.b},
    {title:'3-я позиция',get:d=>d.c},
    {title:'Полная тройка',get:drawCode,full:true}
  ];
  const results=configs.map(config=>({...config,result:findContinuations(draws,chainLength,config.get)}));
  const totalMatches=results.reduce((sum,item)=>sum+item.result.total,0);
  $('chainSearchSummary').innerHTML=`Проверены последние <strong>${chainLength}</strong> тираж${chainLength===1?'':'а'} по всей базе. Всего найденных исторических продолжений: <strong>${totalMatches.toLocaleString('ru-RU')}</strong>.`;
  $('chainSearchResults').innerHTML=results.map(({title,result,full})=>{
    const seed=result.sequence.join(' → ');
    return `<article class="chain-result-card">
      <div class="chain-result-head"><h4>${title}</h4><span>${result.total} совпадений<br>с продолжением</span></div>
      <div class="chain-seed">${seed}</div>
      ${continuationRows(result,full?6:10)}
      ${chainExamples(result)}
    </article>`;
  }).join('');
}

function initializeAnalysisTools() {
  updateDigitSearchControls();
  const latest=draws[0];
  if (latest) {
    $('digitSearchA').value=latest.a;
    $('digitSearchB').value=latest.b;
    $('digitSearchC').value=latest.c;
  }
  renderRecentChain();
  renderChainSearch();
}

function renderAnalysis() {
  const list = getAnalysisList();
  $('frequencyCharts').innerHTML = renderFrequencyGroup(list,'a','1-й столбец') + renderFrequencyGroup(list,'b','2-й столбец') + renderFrequencyGroup(list,'c','3-й столбец');
  const latest = draws[0];
  if (latest) {
    $('transitionCards').innerHTML = [['a',latest.a,1],['b',latest.b,2],['c',latest.c,3]].map(([key,current,pos])=>{
      const p=transitionPrediction(list,key,current);
      const pct=p.total ? Math.round(p.top.n/p.total*100) : 0;
      return `<div class="transition-card"><span>${pos}-я позиция после ${current}</span><strong>${p.top.d}</strong><small>${p.top.n} из ${p.total} случаев · ${pct}%</small></div>`;
    }).join('');
  }
  const combos = new Map();
  list.forEach(d=>{ const k=`${d.a}${d.b}${d.c}`; combos.set(k,(combos.get(k)||0)+1); });
  const top=[...combos.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,10);
  $('comboTable').innerHTML = top.map(([k,n],i)=>`<div class="combo-item"><b>${i+1}. ${k}</b><span>${n} раз</span></div>`).join('');
  renderRecentChain();
  renderChainSearch();
  if ($('digitSearchA').value !== '') renderDigitSearch();
}


function normalizeForecastCode(value) {
  const compact = String(value || '').replace(/\D/g, '').slice(0,3);
  return compact.length === 3 ? compact : '';
}

function loadForecastArchive() {
  try {
    const value = JSON.parse(localStorage.getItem(FORECAST_ARCHIVE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function saveForecastArchive() {
  try { localStorage.setItem(FORECAST_ARCHIVE_KEY, JSON.stringify(forecastArchive)); } catch {}
}

function drawById(id) {
  return draws.find(draw => Number(draw.id) === Number(id)) || null;
}

function previousOverallDraw(targetId) {
  return [...draws].filter(draw => Number(draw.id) < Number(targetId)).sort((a,b)=>b.id-a.id)[0] || null;
}

function addCodes(baseCode, deltaCode) {
  if (!/^\d{3}$/.test(baseCode) || !/^\d{3}$/.test(deltaCode)) return '';
  return baseCode.split('').map((digit,index)=>mod10(Number(digit)+Number(deltaCode[index]))).join('');
}

function forecastHitInfo(predictedCode, actualCode) {
  const predicted = String(predictedCode || '').split('');
  const actual = String(actualCode || '').split('');
  const used = new Set();
  const exact = predicted.map((digit,index)=>digit === actual[index]);
  const moved = predicted.map((digit,index)=>{
    if (exact[index]) { used.add(index); return false; }
    const found = actual.findIndex((value,pos)=>value===digit && !used.has(pos) && !exact[pos]);
    if (found >= 0) { used.add(found); return true; }
    return false;
  });
  const exactCount = exact.filter(Boolean).length;
  const presentCount = exactCount + moved.filter(Boolean).length;
  const pairs = [];
  for (let i=0;i<2;i++) {
    const pair = predicted.slice(i,i+2).join('');
    if (actualCode.includes(pair)) pairs.push(pair);
  }
  return { exact, moved, exactCount, presentCount, pairs, full: predictedCode === actualCode };
}

function highlightedActualDigits(actualCode, variants) {
  const primary = variants[0] || '';
  const info = forecastHitInfo(primary, actualCode);
  return `<div class="forecast-actual-digits">${actualCode.split('').map((digit,index)=>{
    let cls='';
    if (info.exact[index]) cls='exact-place';
    else if (primary.includes(digit)) cls='digit-present';
    return `<span class="${cls}">${digit}</span>`;
  }).join('')}</div>`;
}

function variantResultHtml(variant, actualCode) {
  if (!variant) return '';
  const info = forecastHitInfo(variant, actualCode);
  const label = info.full ? 'полное совпадение' : info.exactCount >= 2 ? `${info.exactCount} поля по месту` : info.presentCount >= 2 ? `${info.presentCount} цифры` : info.presentCount === 1 ? '1 цифра' : 'нет совпадений';
  return `<div class="forecast-variant-result ${info.full ? 'full' : ''}"><strong>${variant}</strong><span>${label}</span>${info.pairs.length ? `<em>пара ${info.pairs.join(', ')}</em>` : ''}</div>`;
}

function updateForecastBasePreview() {
  const targetId = Number($('forecastTargetId')?.value || 0);
  const deltaCode = normalizeForecastCode($('forecastDelta')?.value);
  const previous = previousOverallDraw(targetId);
  if (!previous) {
    $('forecastBasePreview').textContent = 'Предыдущий тираж пока не найден в базе.';
    return;
  }
  const baseCode = drawCode(previous);
  const result = addCodes(baseCode, deltaCode);
  $('forecastBasePreview').innerHTML = `Предыдущий факт: <strong>№${previous.id} · ${baseCode}</strong>${result ? ` + Δ${deltaCode} = <strong>${result}</strong>` : ''}`;
  if (result && !$('forecastVariant1').dataset.manual) $('forecastVariant1').value = result;
}

function renderForecastArchive() {
  if (!$('forecastArchiveList')) return;
  const filter = $('forecastStatusFilter')?.value || 'all';
  const chainLength = Number($('forecastChainLength')?.value || 10);
  const orderedFacts = [...draws].sort((a,b)=>a.id-b.id);
  const visible = [...forecastArchive].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).filter(item=>{
    const checked = Boolean(drawById(item.targetId));
    return filter==='all' || (filter==='checked' ? checked : !checked);
  });

  $('forecastArchiveList').innerHTML = visible.map(item=>{
    const target = drawById(item.targetId);
    const previous = previousOverallDraw(item.targetId);
    const variants = item.variants.filter(Boolean);
    const targetIndex = orderedFacts.findIndex(draw=>draw.id===item.targetId);
    const chain = targetIndex >= 0 ? orderedFacts.slice(targetIndex, targetIndex + chainLength) : [];
    const targetCode = target ? drawCode(target) : '';
    const targetDelta = target && previous ? codeOfDigits(positronDifference(previous,target)) : '';
    const primaryInfo = target ? forecastHitInfo(variants[0], targetCode) : null;
    const status = !target ? 'Ожидает факт' : primaryInfo.full ? 'Точное попадание' : primaryInfo.presentCount ? `Совпало цифр: ${primaryInfo.presentCount}` : 'Не совпало';

    const chainHtml = chain.length ? chain.map((draw,index)=>{
      const actualCode = drawCode(draw);
      const results = variants.map(v=>variantResultHtml(v,actualCode)).join('');
      const anyFull = variants.some(v=>v===actualCode);
      const anyPair = variants.some(v=>forecastHitInfo(v,actualCode).pairs.length);
      return `<div class="forecast-chain-row ${anyFull ? 'full-hit' : anyPair ? 'pair-hit' : ''}">
        <div class="forecast-chain-step"><strong>${index===0 ? 'Факт' : `Через ${index}`}</strong><span>№${draw.id} · ${draw.date} · ${draw.time}</span></div>
        ${highlightedActualDigits(actualCode, variants)}
        <div class="forecast-chain-results">${results}</div>
      </div>`;
    }).join('') : '<div class="forecast-waiting">Фактический тираж ещё не появился. Прогноз сохранён и будет проверен автоматически.</div>';

    return `<article class="forecast-card">
      <div class="forecast-card-head">
        <div><span class="eyebrow">ПРОГНОЗ НА №${item.targetId}</span><h3>${item.method || 'Без названия метода'}</h3><p>${new Date(item.createdAt).toLocaleString('ru-RU')}</p></div>
        <span class="forecast-status ${!target ? 'waiting' : primaryInfo.full ? 'success' : 'checked'}">${status}</span>
      </div>
      <div class="forecast-core">
        <div><span>Предыдущая</span><strong>${item.baseCode || (previous ? drawCode(previous) : '—')}</strong></div>
        <div><span>Прогноз Δ</span><strong>+${item.delta}</strong></div>
        <div><span>Варианты</span><strong>${variants.join(' / ')}</strong></div>
        <div><span>Факт</span><strong>${targetCode || 'ожидается'}</strong>${targetDelta ? `<small>Δ${targetDelta}</small>` : ''}</div>
      </div>
      <details class="forecast-chain" open>
        <summary>Цепочка после прогноза и подсветка совпадений</summary>
        <div class="forecast-legend"><span class="legend-exact">точное место</span><span class="legend-present">цифра вышла в другом месте</span><span class="legend-pair">пара</span></div>
        ${chainHtml}
      </details>
      <button class="danger-btn forecast-delete-btn" data-forecast-delete="${item.id}" type="button">Удалить только этот прогноз</button>
    </article>`;
  }).join('') || '<div class="empty-result">Прогнозов пока нет. Запиши первый прогноз до выхода тиража.</div>';
}

function renderForecastCheck() {
  if (!$('forecastTargetId')) return;
  if (!$('forecastTargetId').value && draws[0]) $('forecastTargetId').value = draws[0].id + 1;
  updateForecastBasePreview();
  renderForecastArchive();
}

function renderData() {
  $('dataCount').textContent = draws.length.toLocaleString('ru-RU');
  $('dataFirst').textContent = draws.at(-1) ? `№ ${draws.at(-1).id}` : '—';
  $('dataLast').textContent = draws[0] ? `№ ${draws[0].id}` : '—';
  $('dbBadge').textContent = `${draws.length.toLocaleString('ru-RU')} тиражей`;
  $('dataSyncSummary').textContent = syncStatus.lastSuccess
    ? `Последняя успешная проверка: ${formatDateTime(syncStatus.lastSuccess)}. Источник: ${syncStatus.source || 'Lucky Numbers'}. Сохранённые тиражи не заменяются.`
    : 'При открытии приложения и каждые 15 минут выполняется безопасная проверка. Уже сохранённые тиражи не заменяются.';
}

function renderAll() {
  renderHome();
  renderArchive(true);
  renderAiTimeView();
  renderAnalysis();
  renderForecastCheck();
  renderData();
}

function nextMoscowDraw() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const nowMin = (Number(parts.hour)%24)*60+Number(parts.minute);
  for (const t of DRAW_TIMES) {
    const [h,m]=t.split(':').map(Number);
    if (h*60+m > nowMin) return `сегодня ${t}`;
  }
  return `завтра ${DRAW_TIMES[0]}`;
}

function parseCSV(text) {
  const rows=[];
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  for (const raw of lines) {
    const line=raw.trim();
    if (!line || /номер\s*тиража/i.test(line) || /lucky-numbers/i.test(line)) continue;
    const p=line.split(/[;,]/).map(x=>x.trim().replace(/^"|"$/g,''));
    let id,date,time,a,b,c;
    if (p.length>=8 && p[4]==='+' && p[6]==='+') {
      [id,date,time,a,b,c]=[p[0],p[1],p[2],p[3],p[5],p[7]];
    } else if (p.length>=6) {
      [id,date,time,a,b,c]=p.slice(0,6);
    } else continue;
    const item={id:Number(id),date:normalizeDate(date),time:normalizeTime(time),a:Number(a),b:Number(b),c:Number(c)};
    if (isValidDraw(item)) rows.push(item);
  }
  return rows;
}

function normalizeDate(s) {
  const p=s.trim().split('.');
  if (p.length!==3) return s.trim();
  const y=p[2].length===4?p[2].slice(-2):p[2].padStart(2,'0');
  return `${p[0].padStart(2,'0')}.${p[1].padStart(2,'0')}.${y}`;
}

function normalizeTime(s) {
  const m=s.trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : s.trim();
}

function download(name, text, type) {
  const blob=new Blob([text],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function exportCSV() {
  const lines=['Номер тиража,Дата,Время,Цифра 1,Цифра 2,Цифра 3'];
  [...draws].reverse().forEach(d=>lines.push(`${d.id},${d.date},${d.time},${d.a},${d.b},${d.c}`));
  download(`yulia-top3-backup-${new Date().toISOString().slice(0,10)}.csv`,'\uFEFF'+lines.join('\n'),'text/csv;charset=utf-8');
}

function showToast(message) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.add('show');
  toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3600);
}

async function refreshFromDB(message) {
  await loadAllDraws();
  aiCache.clear();
  renderAll();
  if (message) showToast(message);
}

function loadSyncStatus() {
  try {
    return { state:'idle', message:'', source:'GitHub TOP-3 Live', ...JSON.parse(localStorage.getItem(AUTO_STATUS_KEY) || '{}') };
  } catch {
    return { state:'idle', message:'', source:'GitHub TOP-3 Live' };
  }
}

function saveSyncStatus(patch) {
  syncStatus = { ...syncStatus, ...patch };
  try { localStorage.setItem(AUTO_STATUS_KEY, JSON.stringify(syncStatus)); } catch {}
  renderSyncStatus();
  if ($('dataSyncSummary')) renderData();
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date) + ' мск';
}

function renderSyncStatus() {
  if (!$('syncState')) return;
  const labels = { idle:'Ожидание', checking:'Проверяю…', success:'Готово', error:'Нет связи' };
  $('syncState').textContent = labels[syncStatus.state] || labels.idle;
  $('syncState').className = `sync-badge ${syncStatus.state || 'idle'}`;
  $('syncLastCheck').textContent = syncStatus.lastAttempt ? formatDateTime(syncStatus.lastAttempt) : 'Ещё не выполнялась';
  $('syncLastSuccess').textContent = syncStatus.lastSuccess ? formatDateTime(syncStatus.lastSuccess) : '—';
  $('syncSource').textContent = syncStatus.source || 'GitHub TOP-3 Live';
  $('syncMessage').textContent = syncStatus.message || 'Свежие тиражи берутся из общего файла GitHub. Проверка — при открытии и каждые 5 минут.';
  const busy = syncStatus.state === 'checking';
  setUpdateButtonsReady();
  $('refreshBtn').classList.toggle('spinning', busy);
}

function digitsFromLuckyCells(cells, idIndex) {
  const beforeId = cells.slice(0, idIndex);

  // Формат Jina Reader: [Button: 8][Button: 8][Button: 3]
  for (const cell of beforeId) {
    const buttons = [...cell.matchAll(/\[Button:\s*([0-9])\]/gi)].map(match => Number(match[1]));
    if (buttons.length === 3) return buttons;
  }

  // Другой формат конвертера: три цифры находятся в одной ячейке —
  // «8 8 3», «883» или markdown-ссылки. Ячейки статистики вида
  // «1 + 1 + 1» намеренно исключаются.
  for (const cell of beforeId) {
    if (cell.includes('+')) continue;
    const cleaned = cell
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ');
    const spaced = cleaned.match(/(?:^|\D)([0-9])\D+([0-9])\D+([0-9])(?:\D|$)/);
    if (spaced) return [Number(spaced[1]), Number(spaced[2]), Number(spaced[3])];
    const compact = cleaned.replace(/\D/g, '');
    if (/^[0-9]{3}$/.test(compact)) return [...compact].map(Number);
  }

  // Иногда каждая цифра становится отдельной ячейкой таблицы.
  // Первую служебную ячейку с порядковым номером строки не берём.
  const singleDigitCells = beforeId
    .map((cell, index) => ({ cell: cell.trim(), index }))
    .filter(({ cell }) => !cell.includes('+') && /^[0-9]$/.test(cell));
  for (let i = 0; i <= singleDigitCells.length - 3; i++) {
    const part = singleDigitCells.slice(i, i + 3);
    if (part[1].index === part[0].index + 1 && part[2].index === part[1].index + 1) {
      return part.map(item => Number(item.cell));
    }
  }

  return null;
}

function parseLuckyArchive(text) {
  const normalized = String(text || '').replace(/\u00a0/g,' ');
  const found = new Map();

  // Строка принимается только тогда, когда одновременно найдены:
  // три цифры комбинации, шестизначный номер, дата и разрешённое время.
  // Поддерживаются разные варианты markdown, которые выдаёт Jina Reader.
  for (const line of normalized.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(cell => cell.trim());
    const dateTime = line.match(/(\d{2}\.\d{2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    if (!dateTime) continue;

    const idIndex = cells.findIndex(cell => {
      const compact = cell.replace(/\s/g, '');
      return /^[0-9]{6}$/.test(compact);
    });
    if (idIndex < 0) continue;

    const digits = digitsFromLuckyCells(cells, idIndex);
    if (!digits || digits.length !== 3) continue;

    const item = {
      id: Number(cells[idIndex].replace(/\s/g,'')),
      date: normalizeDate(dateTime[1]),
      time: normalizeTime(dateTime[2]),
      a: digits[0], b: digits[1], c: digits[2]
    };
    if (isValidDraw(item) && DRAW_TIMES.includes(item.time)) found.set(item.id,item);
  }

  // Запасной разбор сырой HTML-таблицы. Берём цифры только из строки,
  // где находятся номер тиража и дата, чтобы не захватить кнопки генератора.
  if (!found.size && /<html|<table|<tr/i.test(normalized)) {
    try {
      const doc = new DOMParser().parseFromString(normalized,'text/html');
      for (const row of doc.querySelectorAll('tr')) {
        const txt = row.textContent.replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
        const dateTime = txt.match(/(\d{2}\.\d{2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
        const idMatch = txt.match(/(?:^|\s)(\d{3}\s?\d{3})(?:\s|$)/);
        if (!dateTime || !idMatch) continue;

        let digits = [...row.querySelectorAll('button')]
          .map(button => button.textContent.trim())
          .filter(value => /^[0-9]$/.test(value))
          .map(Number);

        if (digits.length !== 3) {
          const cells = [...row.querySelectorAll('td,th')].map(cell => cell.textContent.trim());
          const idIndex = cells.findIndex(cell => /^[0-9]{6}$/.test(cell.replace(/\s/g,'')));
          digits = idIndex >= 0 ? digitsFromLuckyCells(cells, idIndex) : null;
        }
        if (!digits || digits.length !== 3) continue;

        const item = {
          id: Number(idMatch[1].replace(/\s/g,'')),
          date: normalizeDate(dateTime[1]),
          time: normalizeTime(dateTime[2]),
          a: digits[0], b: digits[1], c: digits[2]
        };
        if (isValidDraw(item) && DRAW_TIMES.includes(item.time)) found.set(item.id,item);
      }
    } catch (error) {
      console.warn('Не удалось разобрать HTML Lucky Numbers', error);
    }
  }

  return [...found.values()].sort((a,b)=>b.id-a.id);
}

async function fetchTextWithTimeout(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache:'no-store', signal:controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLuckyDraws() {
  const url = `${LIVE_DATA_URL}?t=${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      cache:'no-store',
      signal:controller.signal,
      headers:{'Accept':'application/json'}
    });
    if (!response.ok) throw new Error(`общий файл GitHub: HTTP ${response.status}`);
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : payload?.draws;
    if (!Array.isArray(items) || !items.length) throw new Error('общий файл GitHub не содержит тиражей');
    return {
      items,
      source: payload?.source || 'GitHub TOP-3 Live',
      generatedAt: payload?.updatedAt || null
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('общий файл GitHub не ответил за 20 секунд');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sameDraw(a,b) {
  return a && b
    && a.id === b.id
    && a.date === b.date
    && a.time === b.time
    && a.a === b.a
    && a.b === b.b
    && a.c === b.c;
}

function validateOnlineBatch(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('пустой ответ источника');
  const valid = items.filter(draw => isValidDraw(draw) && DRAW_TIMES.includes(draw.time));
  if (valid.length < 3) throw new Error('источник вернул слишком мало проверяемых строк');

  const ids = new Set(valid.map(draw => draw.id));
  if (ids.size !== valid.length) throw new Error('источник вернул дубли');

  // Перед добавлением сверяем не менее трёх старых тиражей с локальной базой.
  // При любом несовпадении новые данные не сохраняются.
  const localById = new Map(draws.map(draw => [draw.id, draw]));
  const overlap = valid.filter(draw => localById.has(draw.id));
  if (overlap.length < 3) throw new Error('недостаточно контрольных совпадений с локальным архивом');

  const mismatch = overlap.find(draw => !sameDraw(draw, localById.get(draw.id)));
  if (mismatch) throw new Error(`контрольная сверка не пройдена на тираже №${mismatch.id}`);

  const localLatest = draws[0]?.id || 0;
  const sourceLatest = Math.max(...valid.map(draw => draw.id));
  // Общий файл может на несколько минут отставать, пока cron-job запускает GitHub Action.
  // Это не ошибка: локальная база не откатывается и сохранённые тиражи не заменяются.
  return valid;
}

async function checkOnlineDraws({ manual=false, silent=false }={}) {
  hideLoadingOverlay();
  if (!storageReady || !db) {
    const message = 'Локальная база ещё загружается. Подожди несколько секунд — обновление запустится автоматически.';
    if (manual) showToast(message);
    return;
  }
  if (syncInProgress) {
    if (manual) showToast('Проверка уже выполняется');
    return;
  }
  syncInProgress=true;
  const attempt=new Date().toISOString();
  saveSyncStatus({state:'checking',lastAttempt:attempt,message:'Соединяюсь с Lucky Numbers и проверяю последние тиражи…'});
  try {
    if (!navigator.onLine) throw new Error('телефон сейчас без интернета');
    const result=await fetchLuckyDraws();
    const items=validateOnlineBatch(result.items);
    const sourceLatest=Math.max(...items.map(d=>d.id));
    const {added}=await addNewDrawsOnly(items);
    if (added) await refreshFromDB();
    const success=new Date().toISOString();
    const localLatest=draws[0]?.id || 0;
    const message=added
      ? `Добавлено новых тиражей: ${added}. Последний найденный — №${sourceLatest}.`
      : sourceLatest < localLatest
        ? `Локальная база уже новее общего файла: №${localLatest}. Жду следующего запуска cron-job.`
        : `Новых тиражей нет. Последний найденный — №${sourceLatest}.`;
    saveSyncStatus({state:'success',lastSuccess:success,source:result.source,lastAdded:added,sourceLatest,message});
    if (!silent || added) showToast(message);
  } catch (error) {
    const message=`Общий файл обновлений временно недоступен: ${error?.message || 'неизвестная ошибка'}. Локальная база сохранена.`;
    saveSyncStatus({state:'error',message});
    if (!silent || manual) showToast(message);
    console.warn(message,error);
  } finally {
    syncInProgress=false;
    renderSyncStatus();
  }
}

function startAutoChecks() {
  clearInterval(autoCheckTimer);
  autoCheckTimer=setInterval(()=>{
    if (document.visibilityState === 'visible') checkOnlineDraws({silent:true});
  },AUTO_CHECK_INTERVAL_MS);
  window.addEventListener('online',()=>checkOnlineDraws({silent:true}));
  document.addEventListener('visibilitychange',()=>{
    if (document.visibilityState !== 'visible') return;
    const last = syncStatus.lastAttempt ? new Date(syncStatus.lastAttempt).getTime() : 0;
    if (!last || Date.now()-last >= AUTO_CHECK_INTERVAL_MS) checkOnlineDraws({silent:true});
  });
}

function openView(name) {
  qsa('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  qsa('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  if (name === 'archive') renderArchive(true);
  if (name === 'ai') renderAiTimeView();
  if (name === 'analysis') renderAnalysis();
  if (name === 'forecast-check') renderForecastCheck();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindQuickSummary() {
  const panel = document.querySelector('.quick-panel');
  if (!panel) return;

  panel.setAttribute('role', 'button');
  panel.setAttribute('tabindex', '0');
  panel.setAttribute('aria-label', 'Открыть анализ последних 100 тиражей');
  panel.title = 'Открыть анализ последних 100 тиражей';
  panel.style.cursor = 'pointer';

  const openHundred = () => {
    if ($('analysisRange')) $('analysisRange').value = '100';
    openView('analysis');
  };

  panel.addEventListener('click', openHundred);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openHundred();
    }
  });
}

function selectArchiveTime(time) {
  if (time !== 'all' && !DRAW_TIMES.includes(time)) return;
  archiveTime = time;
  try { localStorage.setItem(ARCHIVE_TIME_KEY, archiveTime); } catch {}
  renderArchive(true);
}

function selectAiTime(time) {
  if (!DRAW_TIMES.includes(time)) return;
  aiSelectedTime = time;
  try { localStorage.setItem(AI_TIME_KEY, aiSelectedTime); } catch {}
  renderAiTimeView();
}

function bindEvents() {
  qsa('.nav-btn').forEach(btn => btn.addEventListener('click', () => openView(btn.dataset.view)));
  bindQuickSummary();

  $('refreshBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('onlineUpdateBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('dataOnlineUpdateBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('archiveSearch').addEventListener('input',()=>renderArchive(true));
  $('archiveSearchScope').addEventListener('change',()=>{
    archiveSearchScope = $('archiveSearchScope').value === 'all' ? 'all' : 'selected';
    try { localStorage.setItem(ARCHIVE_SCOPE_KEY, archiveSearchScope); } catch {}
    renderArchive(true);
  });
  $('archiveLimit').addEventListener('change',()=>renderArchive(true));
  $('archiveTimeChips').addEventListener('click', event => {
    const button = event.target.closest('[data-archive-time]');
    if (button) selectArchiveTime(button.dataset.archiveTime);
  });
  $('aiTimeChips').addEventListener('click', event => {
    const button = event.target.closest('[data-ai-time]');
    if (button) selectAiTime(button.dataset.aiTime);
  });
  qsa('.archive-mode-btn').forEach(button => button.addEventListener('click', () => {
    archiveMode = button.dataset.archiveMode || 'normal';
    try { localStorage.setItem(ARCHIVE_MODE_KEY, archiveMode); } catch {}
    renderArchive(true);
  }));
  $('loadMoreBtn').addEventListener('click',()=>{ archiveShown+=Number($('archiveLimit').value)||50; renderArchive(); });
  $('aiRecalcBtn').addEventListener('click',()=>{ aiCache.clear(); renderAiPanel(); showToast('ИИ-модель пересчитана по архиву времени'); });
  $('openAiViewBtn').addEventListener('click',()=>openView('ai'));
  $('aiTimeRecalcBtn').addEventListener('click',()=>{ aiCache.clear(); renderAiTimeView(); showToast(`Модель ${aiSelectedTime} пересчитана`); });
  $('analysisRange').addEventListener('change',renderAnalysis);
  $('digitSearchLength').addEventListener('change',()=>updateDigitSearchControls({keepValues:true}));
  $('digitSearchForm').addEventListener('submit',e=>{e.preventDefault();renderDigitSearch();});
  $('chainLength').addEventListener('change',renderChainSearch);
  $('chainSearchBtn').addEventListener('click',renderChainSearch);
  if ($('openForecastCheckBtn')) $('openForecastCheckBtn').addEventListener('click',()=>openView('forecast-check'));
  $('forecastBackBtn').addEventListener('click',()=>openView('analysis'));
  $('forecastTargetId').addEventListener('input',updateForecastBasePreview);
  $('forecastDelta').addEventListener('input',()=>{
    $('forecastDelta').value = String($('forecastDelta').value || '').replace(/\D/g,'').slice(0,3);
    updateForecastBasePreview();
  });
  $('forecastVariant1').addEventListener('input',()=>{
    $('forecastVariant1').dataset.manual = $('forecastVariant1').value ? '1' : '';
    $('forecastVariant1').value = String($('forecastVariant1').value || '').replace(/\D/g,'').slice(0,3);
  });
  ['forecastVariant2','forecastVariant3'].forEach(id=>$(id).addEventListener('input',()=>{$(id).value=String($(id).value||'').replace(/\D/g,'').slice(0,3);}));
  $('forecastStatusFilter').addEventListener('change',renderForecastArchive);
  $('forecastChainLength').addEventListener('change',renderForecastArchive);
  $('forecastForm').addEventListener('submit',event=>{
    event.preventDefault();
    const targetId = Number($('forecastTargetId').value);
    const delta = normalizeForecastCode($('forecastDelta').value);
    const variants = ['forecastVariant1','forecastVariant2','forecastVariant3'].map(id=>normalizeForecastCode($(id).value)).filter(Boolean);
    if (!targetId || !delta || !variants.length) return showToast('Укажи номер тиража, разницу и хотя бы одну комбинацию');
    const previous = previousOverallDraw(targetId);
    forecastArchive.push({
      id:`forecast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      targetId,
      method:String($('forecastMethod').value || '').trim(),
      delta,
      variants,
      baseDrawId:previous?.id || null,
      baseCode:previous ? drawCode(previous) : '',
      createdAt:new Date().toISOString()
    });
    saveForecastArchive();
    event.target.reset();
    $('forecastVariant1').dataset.manual='';
    if (draws[0]) $('forecastTargetId').value = draws[0].id + 1;
    renderForecastCheck();
    showToast(`Прогноз на №${targetId} сохранён`);
  });
  $('forecastArchiveList').addEventListener('click',event=>{
    const button=event.target.closest('[data-forecast-delete]');
    if (!button) return;
    forecastArchive=forecastArchive.filter(item=>item.id!==button.dataset.forecastDelete);
    saveForecastArchive();
    renderForecastArchive();
    showToast('Прогноз удалён. База тиражей не изменена.');
  });

  $('manualForm').addEventListener('submit',async(e)=>{
    e.preventDefault();
    const d={id:Number($('manualId').value),date:normalizeDate($('manualDate').value),time:normalizeTime($('manualTime').value),a:Number($('manualA').value),b:Number($('manualB').value),c:Number($('manualC').value)};
    if (!isValidDraw(d)) return showToast('Проверь номер тиража, дату, время и три цифры');
    if (draws.some(x=>x.id===d.id)) return showToast(`Тираж № ${d.id} уже есть. Он не был заменён.`);
    const {added}=await addNewDrawsOnly([d]);
    if (!added) return showToast('Тираж не добавлен');
    e.target.reset(); await refreshFromDB(`Тираж № ${d.id} сохранён`);
  });

  $('csvInput').addEventListener('change',async(e)=>{
    const file=e.target.files[0]; if(!file) return;
    const items=parseCSV(await file.text());
    if(!items.length) return showToast('В CSV не найдено подходящих тиражей');
    const result=await addNewDrawsOnly(items);
    await refreshFromDB(`Добавлено ${result.added.toLocaleString('ru-RU')} новых тиражей. Дубли не заменялись.`);
    e.target.value='';
  });
  $('exportCsvBtn').addEventListener('click',exportCSV);
  $('exportJsonBtn').addEventListener('click',()=>download(`yulia-top3-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({app:'Yulia TOP-3',version:APP_VERSION,exportedAt:new Date().toISOString(),draws},null,2),'application/json'));
  $('jsonInput').addEventListener('change',async(e)=>{
    const file=e.target.files[0]; if(!file) return;
    try {
      const parsed=JSON.parse(await file.text()); const items=Array.isArray(parsed)?parsed:parsed.draws;
      if(!Array.isArray(items)) throw new Error();
      const result=await addNewDrawsOnly(items);
      await refreshFromDB(`Добавлено из копии: ${result.added.toLocaleString('ru-RU')}. Существующие не заменены.`);
    } catch { showToast('Не удалось прочитать резервную копию JSON'); }
    e.target.value='';
  });
  $('resetSeedBtn').addEventListener('click',async()=>{
    if(!confirm('Удалить текущую локальную базу и восстановить встроенный архив?')) return;
    $('loading').classList.remove('hidden'); $('loadingText').textContent='Восстанавливаю встроенный архив…';
    await seedDatabase(true); await refreshFromDB('Встроенный архив восстановлен'); $('loading').classList.add('hidden');
    setTimeout(()=>checkOnlineDraws({silent:true}),600);
  });
}

async function initializeStorage() {
  try {
    db = await withTimeout(openDB(), 6000, 'Открытие базы');
    const existing = await withTimeout(countDB(), 6000, 'Проверка базы');
    if (!existing) await seedDatabase(false);
    await removeOnlyKnownCorruptedRows();
    await applyVerifiedCorrections();
    await loadAllDraws();
    storageReady = true;
    hideLoadingOverlay();
    renderAll();
    setUpdateButtonsReady();
    startAutoChecks();
    setTimeout(() => checkOnlineDraws({silent:true}), 1000);
  } catch (error) {
    storageReady = false;
    hideLoadingOverlay();
    renderAll();
    setUpdateButtonsReady();
    console.error('Ошибка локальной базы:', error);
    saveSyncStatus({
      state:'error',
      source:'Встроенный архив',
      message:`Приложение открыто на встроенном архиве. Локальная база временно недоступна: ${error?.message || 'ошибка'}.`
    });
  }
}

function start() {
  try {
    const savedMode = localStorage.getItem(ARCHIVE_MODE_KEY);
    const savedArchiveTime = localStorage.getItem(ARCHIVE_TIME_KEY);
    const savedArchiveScope = localStorage.getItem(ARCHIVE_SCOPE_KEY);
    const savedAiTime = localStorage.getItem(AI_TIME_KEY);
    if (['normal','normal-diff','mirror','mirror-diff'].includes(savedMode)) archiveMode = savedMode;
    if (savedArchiveTime === 'all' || DRAW_TIMES.includes(savedArchiveTime)) archiveTime = savedArchiveTime;
    if (['selected','all'].includes(savedArchiveScope)) archiveSearchScope = savedArchiveScope;
    if (DRAW_TIMES.includes(savedAiTime)) aiSelectedTime = savedAiTime;
  } catch {}
  const versionNode = document.querySelector('.version');
  if (versionNode) versionNode.textContent = `v${APP_VERSION}`;

  // Главное правило запуска: интерфейс показывается сразу из встроенного архива.
  // IndexedDB и интернет никогда не должны удерживать бесконечную заставку.
  draws = seedObjects();
  if (!eventsBound) {
    bindEvents();
    initializeAnalysisTools();
    eventsBound = true;
  }
  renderAll();
  hideLoadingOverlay();
  setUpdateButtonsReady();

  initializeStorage();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache:'none' })
      .then(async reg => {
        await reg.update();
        if (reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
      })
      .catch(error => console.warn('Service Worker не зарегистрирован:', error));
  }
}

document.addEventListener('DOMContentLoaded',start);
