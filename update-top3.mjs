import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const EMAIL = process.env.STOLOTO_EMAIL || '';
const PASSWORD = process.env.STOLOTO_PASSWORD || '';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const LOGIN_URL = 'https://oauth.stoloto.ru/login';
const ARCHIVE_URL = 'https://m.stoloto.ru/top3/archive';

const REGULAR_DRAW_TIMES = new Set([
  '02:40','04:40','06:40','07:40','09:40',
  '11:40','13:40','16:25','21:25','22:40'
]);

function clean(s) {
  return String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function moscowDateParts(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

function formatDate(d) {
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCFullYear()).slice(-2)}`;
}

function validDate(s) {
  const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return false;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = 2000 + Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function validDraw(d) {
  return Number.isInteger(d?.id)
    && d.id >= 100000 && d.id <= 999999
    && validDate(d.date)
    && REGULAR_DRAW_TIMES.has(d.time)
    && [d.a, d.b, d.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9);
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
  return validDraw(x) ? x : null;
}

function dedupe(draws) {
  const map = new Map();
  for (const raw of draws) {
    const d = normalizeDraw(raw);
    if (d) map.set(d.id, d);
  }
  return [...map.values()].sort((a, b) => b.id - a.id);
}

function drawKey(d) {
  return `${d.id}|${d.date}|${d.time}|${d.a}${d.b}${d.c}`;
}

function parseArchiveText(rawText) {
  const lines = String(rawText ?? '')
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);

  const months = {
    'января':1, 'февраля':2, 'марта':3, 'апреля':4, 'мая':5, 'июня':6,
    'июля':7, 'августа':8, 'сентября':9, 'октября':10, 'ноября':11, 'декабря':12
  };

  const currentYear = Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Moscow',
    year: 'numeric'
  }).format(new Date()));

  const found = [];
  let currentDate = '';

  function setExplicitDate(line) {
    if (/^Сегодня$/i.test(line)) {
      currentDate = formatDate(moscowDateParts(0));
      return true;
    }

    if (/^Вчера$/i.test(line)) {
      currentDate = formatDate(moscowDateParts(-1));
      return true;
    }

    let m = line.toLowerCase().match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/i);
    if (m && months[m[2]]) {
      const day = Number(m[1]);
      const month = months[m[2]];
      const year = m[3] ? Number(m[3]) : currentYear;
      const d = new Date(Date.UTC(year, month - 1, day));
      const candidate = formatDate(d);
      if (validDate(candidate)) {
        currentDate = candidate;
        return true;
      }
    }

    m = line.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2}|\d{4})$/);
    if (m) {
      const year = String(m[3]).length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
      const candidate = formatDate(d);
      if (validDate(candidate)) {
        currentDate = candidate;
        return true;
      }
    }

    return false;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (setExplicitDate(line)) continue;

    const tm = line.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
    if (!tm || !currentDate) continue;

    const time = `${tm[1]}:${tm[2]}`;
    if (!REGULAR_DRAW_TIMES.has(time)) continue;

    const idLine = lines[i + 1] || '';
    const idm = idLine.match(/^№\s*(\d{6})$/i);
    if (!idm) continue;

    const digits = lines.slice(i + 2, i + 5);
    if (digits.length !== 3 || !digits.every(x => /^[0-9]$/.test(x))) continue;

    const d = {
      id: Number(idm[1]),
      date: currentDate,
      time,
      a: Number(digits[0]),
      b: Number(digits[1]),
      c: Number(digits[2])
    };

    if (validDraw(d)) found.push(d);
  }

  return dedupe(found);
}

async function firstVisible(candidates) {
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) return loc;
  }
  return null;
}

async function login(page) {
  if (!EMAIL || !PASSWORD) {
    throw new Error('не заданы Repository Secrets STOLOTO_EMAIL / STOLOTO_PASSWORD');
  }

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(900);

  const email = await firstVisible([
    page.getByLabel(/телефон или email/i).first(),
    page.getByLabel(/email/i).first(),
    page.locator('input[type="email"]').first(),
    page.locator('input[name*="email" i]').first(),
    page.locator('input[name*="login" i]').first(),
    page.locator('input[autocomplete="username"]').first(),
    page.locator('input[type="text"]').first()
  ]);

  const password = await firstVisible([
    page.getByLabel(/пароль/i).first(),
    page.locator('input[type="password"]').first(),
    page.locator('input[name*="password" i]').first(),
    page.locator('input[autocomplete="current-password"]').first()
  ]);

  if (!email || !password) throw new Error('OAuth-форма не отдала поля логин/пароль');

  await email.fill(EMAIL);
  await password.fill(PASSWORD);

  const submit = await firstVisible([
    page.getByRole('button', { name: /^войти$/i }).first(),
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first()
  ]);

  if (!submit) throw new Error('OAuth-форма не отдала кнопку "Войти"');
  if (!(await submit.isEnabled().catch(() => false))) throw new Error('кнопка "Войти" неактивна');

  await submit.click({ timeout: 5000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800);

  const body = clean(await page.locator('body').innerText().catch(() => ''));
  if (/неверн.*(парол|логин|почт)|пользователь.*не найден|ошибк.*вход/i.test(body)) {
    throw new Error('Столото отклонил авторизацию');
  }

  const stillPassword = await page.locator('input[type="password"]').first()
    .isVisible({ timeout: 300 }).catch(() => false);

  if (page.url().includes('/login') && stillPassword) {
    throw new Error('OAuth-вход не подтверждён');
  }
}

async function readArchivePass(browser, pass) {
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 412, height: 1800 },
    userAgent: 'Mozilla/5.0 (Linux; Android 10; VOG-L29) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36'
  });

  const page = await context.newPage();

  try {
    await login(page);
    await page.goto(ARCHIVE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2200);

    for (let i = 0; i < 7; i += 1) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(350);
    }

    await page.mouse.wheel(0, -9800);
    await page.waitForTimeout(500);

    const body = await page.locator('body').innerText();
    const draws = parseArchiveText(body);

    if (draws.length < 3) {
      const sample = body.split(/\r?\n/).map(clean).filter(Boolean).slice(0, 80);
      console.log('ARCHIVE TEXT SAMPLE:', JSON.stringify(sample));
      throw new Error(`распознано слишком мало тиражей: ${draws.length}`);
    }

    console.log(
      `PASS ${pass}: rows=${draws.length}; latest №${draws[0].id} ${draws[0].date} ${draws[0].time}=${draws[0].a}${draws[0].b}${draws[0].c}`
    );

    return draws;
  } finally {
    await context.close();
  }
}

function sameSnapshot(a, b) {
  return JSON.stringify(a.slice(0, 20)) === JSON.stringify(b.slice(0, 20));
}

function moscowStamp(d) {
  const [dd, mm, yy] = d.date.split('.').map(Number);
  const [hh, mi] = d.time.split(':').map(Number);
  return Date.UTC(2000 + yy, mm - 1, dd, hh - 3, mi);
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
    .sort((first, second) => Number(first.targetId) - Number(second.targetId))
    .slice(-240);
}

// ===== ОСНОВНАЯ БЕЗОПАСНАЯ ЗАПИСЬ =====

async function main() {
  const live = JSON.parse(await fs.readFile(LIVE_FILE, 'utf8'));
  const existing = dedupe(live.draws || []);

  if (!existing.length) {
    throw new Error('top3-live.json не содержит доверенных тиражей');
  }

  const anchor = existing[0];
  console.log(`Доверенный anchor: №${anchor.id} ${anchor.date} ${anchor.time}=${anchor.a}${anchor.b}${anchor.c}`);

  const browser = await chromium.launch({ headless: true });
  const passes = [];

  try {
    for (let i = 1; i <= 2; i += 1) {
      passes.push(await readArchivePass(browser, i));
    }
  } finally {
    await browser.close();
  }

  if (!sameSnapshot(passes[0], passes[1])) {
    throw new Error('два независимых чтения Столото не совпали — запись запрещена');
  }

  const source = passes[0];
  const sourceAnchor = source.find(d => d.id === anchor.id);

  if (!sourceAnchor) {
    throw new Error(`официальный архив не содержит доверенный anchor №${anchor.id}`);
  }

  if (drawKey(sourceAnchor) !== drawKey(anchor)) {
    throw new Error(`anchor №${anchor.id} не совпал: ожидалось ${drawKey(anchor)}, получено ${drawKey(sourceAnchor)}`);
  }

  const existingMap = new Map(existing.map(d => [d.id, d]));
  let overlap = 0;

  for (const d of source) {
    const old = existingMap.get(d.id);
    if (!old) continue;
    overlap += 1;

    if (drawKey(old) !== drawKey(d)) {
      throw new Error(`несовпадение сохранённого тиража №${d.id}`);
    }
  }

  if (overlap < 3) {
    throw new Error(`слишком мало подтверждённого пересечения с архивом: ${overlap}`);
  }

  const newer = source
    .filter(d => d.id > anchor.id)
    .sort((a, b) => a.id - b.id);

  for (let i = 0; i < newer.length; i += 1) {
    const expected = anchor.id + 1 + i;
    if (newer[i].id !== expected) {
      throw new Error(`разрыв номеров: ожидался №${expected}, получен №${newer[i].id}`);
    }
  }

  let prev = anchor;
  const slots = new Set(existing.slice(0, 40).map(d => `${d.date}|${d.time}`));

  for (const d of newer) {
    if (moscowStamp(d) <= moscowStamp(prev)) {
      throw new Error(`нарушена хронология №${prev.id} -> №${d.id}`);
    }

    const slot = `${d.date}|${d.time}`;
    if (slots.has(slot)) {
      throw new Error(`повтор даты/времени ${slot}`);
    }

    slots.add(slot);
    prev = d;
  }

  if (newer.length > 30) {
    throw new Error(`слишком большой скачок: ${newer.length}`);
  }

  const history = dedupe([...source, ...existing]);
  const merged = dedupe([...newer, ...existing]).slice(0, 150);
  const forecasts = ensureServerForecast(live.forecasts || [], history);

  const officialSource = 'Официальный Столото · OAuth · двойная проверка';
  const sourceChanged = String(live.source || '') !== officialSource;
  const drawsChanged = JSON.stringify(merged) !== JSON.stringify(existing);
  const forecastsChanged = JSON.stringify(forecasts) !== JSON.stringify(
    Array.isArray(live.forecasts)
      ? live.forecasts.map(normalizeStoredForecast).filter(Boolean)
      : []
  );

  if (!drawsChanged && !forecastsChanged && !sourceChanged) {
    console.log(`Новых подтверждённых тиражей нет. latest №${merged[0].id}.`);
    return;
  }

  const output = {
    ...live,
    schema: 3,
    source: officialSource,
    updatedAt: new Date().toISOString(),
    latest: merged[0].id,
    regularTimes: [...REGULAR_DRAW_TIMES],
    forecasts,
    draws: merged
  };

  await fs.writeFile(LIVE_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(
    `ГОТОВО: добавлено ${newer.length}; latest №${merged[0].id}; прогнозов ${forecasts.length}; источник: ${officialSource}`
  );

  for (const d of newer) {
    console.log(`№${d.id} ${d.date} ${d.time}=${d.a}${d.b}${d.c}`);
  }
}

main().catch(err => {
  console.error('SAFE STOLOTO UPDATER ERROR:', err?.message || err);
  process.exit(1);
});
