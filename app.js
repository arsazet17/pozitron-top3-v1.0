'use strict';

const APP_VERSION = '1.0.14';
const DB_NAME = 'yulia-top3-db';
const DB_VERSION = 1;
const STORE = 'draws';
const DRAW_TIMES = ['02:40','04:40','06:40','07:40','09:40','11:40','13:40','16:25','21:25','22:40'];
const AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_STATUS_KEY = 'yulia-top3-auto-status-v1';
const ARCHIVE_MODE_KEY = 'yulia-top3-archive-mode-v1';
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
let aiCache = null;

const VERIFIED_CORRECTIONS = [
  // Эти строки уже есть во встроенном архиве и используются только для
  // точечного возврата записей, которые успел исказить старый общий файл.
  { id:267356, date:'30.07.26', time:'09:40', a:8, b:8, c:3 },
  { id:267355, date:'30.07.26', time:'07:40', a:6, b:3, c:8 },
  { id:267354, date:'30.07.26', time:'06:40', a:0, b:3, c:9 }
];

const $ = (id) => document.getElementById(id);
const qsa = (sel) => [...document.querySelectorAll(sel)];

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
      help: 'Разница +Δ показывает покоординатный переход от предыдущего тиража к текущему по модулю 10.'
    },
    mirror: {
      title: 'Зеркальный архив',
      help: 'Каждое поле зеркалится отдельно: 0↔0, 1↔9, 2↔8, 3↔7, 4↔6, 5↔5.'
    },
    'mirror-diff': {
      title: 'Зеркальный архив + разница',
      help: 'Показаны зеркальные комбинации и зеркальная разница Позитронов для каждого перехода.'
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

function buildPositronTransitions(sourceDraws = draws) {
  const ordered = [...sourceDraws].sort((a,b) => a.id - b.id);
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
      time:current.time,
      weekday:date ? date.getUTCDay() : 0
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
    time:new Map(),
    weekday:new Map(),
    source:new Map(),
    timeSource:new Map(),
    previousDelta:new Map(),
    previousPair:new Map(),
    previousFullDelta:new Map()
  }));
}

function addAiRecord(model, records, index) {
  const record = records[index];
  if (!record) return;
  const previousRecord = records[index - 1] || null;
  const previousPreviousRecord = records[index - 2] || null;
  for (let position = 0; position < 3; position++) {
    const target = record.delta[position];
    const sourceDigit = digitsOf(record.previous)[position];
    const bucket = model[position];
    incrementArray(bucket.global, target);
    incrementMap(bucket.time, record.time, target);
    incrementMap(bucket.weekday, record.weekday, target);
    incrementMap(bucket.source, sourceDigit, target);
    incrementMap(bucket.timeSource, `${record.time}|${sourceDigit}`, target);
    if (previousRecord) {
      incrementMap(bucket.previousDelta, previousRecord.delta[position], target);
      incrementMap(bucket.previousFullDelta, codeOfDigits(previousRecord.delta), target);
    }
    if (previousRecord && previousPreviousRecord) {
      incrementMap(bucket.previousPair, `${previousPreviousRecord.delta[position]}|${previousRecord.delta[position]}`, target);
    }
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

function predictAiPosition(model, records, position, context) {
  const bucket = model[position];
  const scores = Array(10).fill(0);
  addEvidence(scores, bucket.global, 1.25, 5000, 1.2);
  addEvidence(scores, bucket.time.get(String(context.time)), 0.65, 350, 1.4);
  addEvidence(scores, bucket.weekday.get(String(context.weekday)), 0.22, 1200, 1.5);
  addEvidence(scores, bucket.source.get(String(context.sourceDigits[position])), 0.70, 1800, 1.3);
  addEvidence(scores, bucket.timeSource.get(`${context.time}|${context.sourceDigits[position]}`), 0.70, 160, 1.7);
  if (context.previousRecord) {
    addEvidence(scores, bucket.previousDelta.get(String(context.previousRecord.delta[position])), 0.78, 1800, 1.4);
    addEvidence(scores, bucket.previousFullDelta.get(codeOfDigits(context.previousRecord.delta)), 0.34, 40, 2.2);
  }
  if (context.previousRecord && context.previousPreviousRecord) {
    addEvidence(scores, bucket.previousPair.get(`${context.previousPreviousRecord.delta[position]}|${context.previousRecord.delta[position]}`), 0.65, 180, 2.0);
  }
  addEvidence(scores, recentCounts(records, position, 50), 0.52, 50, 1.8);
  addEvidence(scores, recentCounts(records, position, 200), 0.38, 200, 1.5);
  addEvidence(scores, recentCounts(records, position, 1000), 0.20, 1000, 1.3);
  const probabilities = normalizeScores(scores);
  return probabilities.map((probability, digit) => ({digit, probability}))
    .sort((a,b) => b.probability - a.probability || a.digit - b.digit);
}

function predictAiTransition(model, records, context) {
  return [0,1,2].map(position => predictAiPosition(model, records, position, context));
}

function globalAiRanking(model, position) {
  const counts = model[position].global;
  const support = countsSupport(counts);
  return counts.map((count,digit) => ({
    digit,
    probability:(count + 1) / (support + 10)
  })).sort((a,b) => b.probability - a.probability || a.digit - b.digit);
}

function aiMethodScore(methodStats, method, position) {
  const seen = methodStats.seen[position] || 0;
  if (!seen) return method === 'global' ? 0.0001 : 0;
  return (methodStats[method].top1[position] + 0.22 * methodStats[method].top3[position]) / seen;
}

function chooseAiMethod(methodStats, position) {
  return aiMethodScore(methodStats,'ensemble',position) > aiMethodScore(methodStats,'global',position)
    ? 'ensemble'
    : 'global';
}

function aiContextForNext(records, latest, next) {
  return {
    time:next.time,
    weekday:next.weekday,
    sourceDigits:digitsOf(latest),
    previousRecord:records.at(-1) || null,
    previousPreviousRecord:records.at(-2) || null
  };
}

function aiContextForRecord(records, index) {
  const record = records[index];
  return {
    time:record.time,
    weekday:record.weekday,
    sourceDigits:digitsOf(record.previous),
    previousRecord:records[index - 1] || null,
    previousPreviousRecord:records[index - 2] || null
  };
}

function runAiBacktest(records, testSize = 600) {
  if (records.length < 1200) return null;
  const start = Math.max(700, records.length - testSize);
  const model = createAiModel();
  for (let index = 0; index < start; index++) addAiRecord(model, records, index);
  const stats = {
    tested:0,
    fieldTop1:[0,0,0],
    fieldTop3:[0,0,0],
    atLeastOneTop1:0,
    atLeastTwoTop1:0,
    atLeastOneTop3:0,
    atLeastTwoTop3:0
  };
  for (let index = start; index < records.length; index++) {
    const recentHistory = records.slice(Math.max(0, index - 1000), index);
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
    if (hitsTop3 >= 1) stats.atLeastOneTop3 += 1;
    if (hitsTop3 >= 2) stats.atLeastTwoTop3 += 1;
    stats.tested += 1;
    addAiRecord(model, records, index);
  }
  return stats;
}

function buildAiAnalysis() {
  const cacheKey = `${draws.length}|${draws[0]?.id || 0}|${drawCode(draws[0])}`;
  if (aiCache?.key === cacheKey) return aiCache.value;
  const records = buildPositronTransitions(draws);
  if (!records.length || !draws[0]) return null;
  const model = createAiModel();
  records.forEach((_, index) => addAiRecord(model, records, index));
  const next = nextDrawAfterLatest(draws[0]);
  const rankings = predictAiTransition(model, records, aiContextForNext(records, draws[0], next));
  const primaryDelta = rankings.map(ranking => ranking[0].digit);
  const predictedDigits = digitsOf(draws[0]).map((digit, index) => mod10(digit + primaryDelta[index]));
  const backtest = runAiBacktest(records, Math.min(600, Math.max(300, Math.floor(records.length * 0.04))));
  const value = {records, next, rankings, primaryDelta, predictedDigits, backtest};
  aiCache = {key:cacheKey, value};
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
  if (averageProbability >= 0.17 && averageGap >= 0.035) return {label:'Повышенный сигнал',className:'strong'};
  if (averageProbability >= 0.135 && averageGap >= 0.018) return {label:'Средний сигнал',className:'medium'};
  return {label:'Слабый сигнал',className:'weak'};
}

function renderAiPanel() {
  const contextNode = $('aiContext');
  if (!contextNode) return;
  const analysis = buildAiAnalysis();
  if (!analysis) {
    contextNode.textContent = 'Недостаточно данных для расчёта.';
    $('aiMainPrediction').innerHTML = '';
    $('aiColumnPredictions').innerHTML = '';
    $('aiBacktest').innerHTML = '';
    return;
  }
  const latest = draws[0];
  const signal = aiSignalInfo(analysis);
  const badge = $('aiSignalBadge');
  badge.textContent = signal.label;
  badge.className = `ai-signal ${signal.className}`;
  contextNode.innerHTML = `<div><span>Последний факт</span><strong>№${latest.id} · ${drawCode(latest)}</strong></div><div><span>Цель модели</span><strong>${analysis.next.date} · ${analysis.next.time}</strong></div>`;
  const mirrorDelta = mirrorDigits(analysis.primaryDelta);
  $('aiMainPrediction').innerHTML = `
    <div class="ai-main-block"><span>Основной переход</span><strong>+${codeOfDigits(analysis.primaryDelta)}</strong><small>зеркало +${codeOfDigits(mirrorDelta)}</small></div>
    <div class="ai-main-arrow">→</div>
    <div class="ai-main-block result"><span>Расчётная комбинация</span><strong>${codeOfDigits(analysis.predictedDigits)}</strong><small>${drawCode(latest)} + ${codeOfDigits(analysis.primaryDelta)} по модулю 10</small></div>`;
  $('aiColumnPredictions').innerHTML = analysis.rankings.map((ranking, position) => {
    const candidates = ranking.slice(0,3);
    const main = candidates[0];
    return `<article class="ai-column-card">
      <span>${position + 1}-е поле перехода</span>
      <strong>${main.digit}</strong>
      <div class="ai-candidates">${candidates.map((item,index) => `<b class="${index === 0 ? 'primary' : ''}">${item.digit}<small>${(item.probability*100).toFixed(1)}%</small></b>`).join('')}</div>
    </article>`;
  }).join('');
  const test = analysis.backtest;
  if (!test) {
    $('aiBacktest').textContent = 'Для честного теста пока недостаточно истории.';
  } else {
    $('aiBacktest').innerHTML = `<div class="ai-backtest-title"><span>Проверка без подглядывания</span><strong>${test.tested} последних переходов</strong></div>
      <div class="ai-metrics">
        <div><span>Хотя бы 1 точное поле</span><b>${pct(test.atLeastOneTop1,test.tested)}</b></div>
        <div><span>Хотя бы 2 точных поля</span><b>${pct(test.atLeastTwoTop1,test.tested)}</b></div>
        <div><span>1 поле в тройке кандидатов</span><b>${pct(test.atLeastOneTop3,test.tested)}</b></div>
        <div><span>2 поля в тройке кандидатов</span><b>${pct(test.atLeastTwoTop3,test.tested)}</b></div>
      </div>`;
  }
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

function renderHome() {
  $('latestCards').innerHTML = draws.slice(0,3).map((d,i)=>drawCard(d,i)).join('');
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

function renderArchive(reset = false) {
  if (reset) archiveShown = Number($('archiveLimit').value) || 50;
  const query = parseArchiveSearch($('archiveSearch').value);
  const indexById = new Map(draws.map((draw,index) => [draw.id,index]));
  const mirrorMode = archiveMode.startsWith('mirror');
  const searchable = draw => {
    const index = indexById.get(draw.id);
    const older = Number.isInteger(index) ? draws[index + 1] : null;
    const normal = digitsOf(draw);
    const displayedDigits = mirrorMode ? mirrorDigits(normal) : normal;
    const delta = positronDifference(older, draw);
    const displayedDelta = delta ? (mirrorMode ? mirrorDigits(delta) : delta) : null;

    if (query.type === 'delta') {
      return Boolean(displayedDelta) && codeOfDigits(displayedDelta) === query.value;
    }
    if (query.type === 'combination') {
      return codeOfDigits(displayedDigits) === query.value;
    }
    if (query.type === 'id') {
      return draw.id === query.value;
    }

    return [draw.date, draw.time, patternOf(draw)]
      .some(value => String(value).toLowerCase().includes(query.value));
  };
  const filtered = query ? draws.filter(searchable) : draws;
  const visible = filtered.slice(0, archiveShown);
  const meta = archiveModeMeta();
  $('archiveInfo').textContent = `${filtered.length.toLocaleString('ru-RU')} тиражей · ${meta.title}`;
  $('archiveModeHelp').textContent = meta.help;
  qsa('.archive-mode-btn').forEach(button => button.classList.toggle('active', button.dataset.archiveMode === archiveMode));
  $('archiveList').innerHTML = visible.map(draw => {
    const index = indexById.get(draw.id);
    const older = Number.isInteger(index) ? draws[index + 1] : null;
    const normal = digitsOf(draw);
    const delta = positronDifference(older, draw);
    const isMirror = archiveMode.startsWith('mirror');
    const showDifference = archiveMode.endsWith('diff') || query?.type === 'delta';
    const displayedDigits = isMirror ? mirrorDigits(normal) : normal;
    const displayedDelta = delta ? (isMirror ? mirrorDigits(delta) : delta) : null;
    const sourceText = showDifference && older
      ? `переход от №${older.id}`
      : patternOf(draw);
    return `<article class="archive-row ${showDifference ? 'with-difference' : ''}">
      <div class="archive-row-info"><h4>№ ${draw.id}</h4><p>${draw.date} · ${draw.time} · ${sourceText}</p></div>
      <div class="archive-values">
        ${renderArchiveDigits(displayedDigits, isMirror ? 'mirror-digits' : '')}
        ${showDifference ? `<div class="positron-difference ${displayedDelta ? '' : 'empty'}"><span>Δ</span><strong>${displayedDelta ? `+${codeOfDigits(displayedDelta)}` : '—'}</strong></div>` : ''}
      </div>
    </article>`;
  }).join('');
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
  renderAnalysis();
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
  await loadAllDraws(); renderAll(); if (message) showToast(message);
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
  for (const id of ['refreshBtn','onlineUpdateBtn','dataOnlineUpdateBtn']) {
    const button = $(id);
    if (button) button.disabled = busy;
  }
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
  if (name === 'analysis') renderAnalysis();
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

function bindEvents() {
  qsa('.nav-btn').forEach(btn => btn.addEventListener('click', () => openView(btn.dataset.view)));
  bindQuickSummary();

  $('refreshBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('onlineUpdateBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('dataOnlineUpdateBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('archiveSearch').addEventListener('input',()=>renderArchive(true));
  $('archiveLimit').addEventListener('change',()=>renderArchive(true));
  qsa('.archive-mode-btn').forEach(button => button.addEventListener('click', () => {
    archiveMode = button.dataset.archiveMode || 'normal';
    try { localStorage.setItem(ARCHIVE_MODE_KEY, archiveMode); } catch {}
    renderArchive(true);
  }));
  $('loadMoreBtn').addEventListener('click',()=>{ archiveShown+=Number($('archiveLimit').value)||50; renderArchive(); });
  $('aiRecalcBtn').addEventListener('click',()=>{ aiCache=null; renderAiPanel(); showToast('ИИ-модель пересчитана на текущем архиве'); });
  $('analysisRange').addEventListener('change',renderAnalysis);
  $('digitSearchLength').addEventListener('change',()=>updateDigitSearchControls({keepValues:true}));
  $('digitSearchForm').addEventListener('submit',e=>{e.preventDefault();renderDigitSearch();});
  $('chainLength').addEventListener('change',renderChainSearch);
  $('chainSearchBtn').addEventListener('click',renderChainSearch);

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
    renderAll();
    startAutoChecks();
    setTimeout(() => checkOnlineDraws({silent:true}), 1000);
  } catch (error) {
    storageReady = false;
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
    if (['normal','normal-diff','mirror','mirror-diff'].includes(savedMode)) archiveMode = savedMode;
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
  const loading = $('loading');
  if (loading) loading.classList.add('hidden');

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
