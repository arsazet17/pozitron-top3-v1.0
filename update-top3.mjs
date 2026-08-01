import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const SEED_FILE = new URL('./top3-data.js', import.meta.url);

const LUCKY_URL = 'https://lucky-numbers.ru/lottery/ru/top3';
const STOLOTO_ARCHIVE_URL = 'https://www.stoloto.ru/top3/archive';
const STOLOTO_API_URLS = [
  'https://www.stoloto.ru/p/api/mobile/api/v36/service/draws/archive?count=100&game=top3&page=1',
  'https://www.stoloto.ru/p/api/mobile/api/v35/service/draws/archive?count=100&game=top3&page=1',
  'https://www.stoloto.ru/p/api/mobile/api/v34/service/draws/archive?count=100&game=top3&page=1'
];

// Обычное расписание TOP-3. Оно совпадает с десятью временными архивами приложения.
const REGULAR_DRAW_TIMES = new Set([
  '02:40','04:40','06:40','07:40','09:40',
  '11:40','13:40','16:25','21:25','22:40'
]);

const MONTHS_RU = new Map([
  ['января', 1], ['февраля', 2], ['марта', 3], ['апреля', 4],
  ['мая', 5], ['июня', 6], ['июля', 7], ['августа', 8],
  ['сентября', 9], ['октября', 10], ['ноября', 11], ['декабря', 12]
]);

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  let match = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2}|\d{4})$/);
  if (match) {
    return `${match[1].padStart(2, '0')}.${match[2].padStart(2, '0')}.${match[3].slice(-2)}`;
  }

  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return `${match[3].padStart(2, '0')}.${match[2].padStart(2, '0')}.${match[1].slice(-2)}`;
  }

  return '';
}

function normalizeTime(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatMoscowDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.day}.${values.month}.${values.year}`,
    time: `${values.hour}:${values.minute}`
  };
}

function parseDateTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return formatMoscowDateTime(new Date(milliseconds));
  }

  const text = String(value ?? '').replace(/\u00a0/g, ' ').trim();
  if (!text) return null;

  let match = text.match(/(?<!\d)(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2}|\d{4})[^\d]{0,12}(\d{1,2}:\d{2})(?::\d{2})?/);
  if (match) {
    return {
      date: normalizeDate(`${match[1]}.${match[2]}.${match[3]}`),
      time: normalizeTime(match[4])
    };
  }

  match = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?/);
  if (match) {
    // Если час указан вместе с часовым поясом, Date корректно переведёт его в Москву.
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
      const converted = formatMoscowDateTime(new Date(text));
      if (converted) return converted;
    }
    return {
      date: normalizeDate(`${match[1]}-${match[2]}-${match[3]}`),
      time: normalizeTime(match[4])
    };
  }

  match = text.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})[^\d]{0,20}(\d{1,2}:\d{2})/i);
  if (match && MONTHS_RU.has(match[2])) {
    return {
      date: normalizeDate(`${match[1]}.${MONTHS_RU.get(match[2])}.${match[3]}`),
      time: normalizeTime(match[4])
    };
  }

  // Дата без времени должна дождаться отдельного поля time/drawTime.
  const dateOnly = normalizeDate(text);
  if (dateOnly) return { date: dateOnly, time: '' };

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : formatMoscowDateTime(parsed);
}

function validDraw(draw) {
  return Number.isInteger(draw?.id)
    && draw.id >= 100_000
    && draw.id <= 999_999
    && /^\d{2}\.\d{2}\.\d{2}$/.test(draw.date)
    && REGULAR_DRAW_TIMES.has(draw.time)
    && [draw.a, draw.b, draw.c].every(number => Number.isInteger(number) && number >= 0 && number <= 9);
}

function normalizeDraw(draw) {
  const normalized = {
    id: Number(draw?.id),
    date: normalizeDate(draw?.date),
    time: normalizeTime(draw?.time),
    a: Number(draw?.a),
    b: Number(draw?.b),
    c: Number(draw?.c)
  };
  return validDraw(normalized) ? normalized : null;
}

function stripMarkup(value) {
  return String(value ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&thinsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseButtonDigits(fragment) {
  const buttons = [...String(fragment).matchAll(
    /(?:\[Button:\s*|<button\b[^>]*>\s*)([0-9])(?:\]|\s*<\/button>)/gi
  )].map(match => Number(match[1]));
  return buttons.length === 3 ? buttons : null;
}

function parseThreeDigits(value) {
  if (Array.isArray(value)) {
    const direct = [];
    for (const item of value) {
      if (typeof item === 'number' || typeof item === 'string') {
        const number = Number(String(item).trim());
        if (Number.isInteger(number) && number >= 0 && number <= 9) direct.push(number);
      } else if (item && typeof item === 'object') {
        const primitive = item.number ?? item.value ?? item.ball ?? item.num ?? item.result;
        const number = Number(primitive);
        if (Number.isInteger(number) && number >= 0 && number <= 9) direct.push(number);
      }
    }
    if (direct.length === 3) return direct;

    for (const item of value) {
      const nested = parseThreeDigits(item);
      if (nested) return nested;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    const preferred = [
      'numbers', 'values', 'balls', 'digits', 'winningNumbers',
      'winning_numbers', 'winningCombination', 'combination',
      'result', 'results', 'drawResult', 'draw_result'
    ];
    for (const key of preferred) {
      if (Object.hasOwn(value, key)) {
        const nested = parseThreeDigits(value[key]);
        if (nested) return nested;
      }
    }
    return null;
  }

  const text = stripMarkup(value);
  if (!text) return null;

  const compact = text.replace(/\D/g, '');
  if (/^\d{3}$/.test(compact)) return [...compact].map(Number);

  const tokens = text.match(/(?:^|\D)0?([0-9])(?=\D|$)/g) ?? [];
  const digits = tokens.map(token => Number(token.replace(/\D/g, '').slice(-1)));
  return digits.length === 3 ? digits : null;
}

function parseDrawId(value) {
  const compact = String(value ?? '').replace(/[^0-9]/g, '');
  if (!/^\d{6}$/.test(compact)) return null;
  const id = Number(compact);
  return id >= 100_000 && id <= 999_999 ? id : null;
}

function normalizeKey(key) {
  return String(key).replace(/[^a-zа-я0-9]/gi, '').toLowerCase();
}

const ID_KEYS = new Set([
  'number', 'drawnumber', 'drawnum', 'drawno', 'drawid', 'draw',
  'tirage', 'tiragenumber', 'circulation', 'circulationnumber'
]);
const DATE_KEYS = new Set([
  'drawdate', 'drawdatetime', 'datetime', 'date', 'drawat', 'drawtime',
  'startdate', 'startedat', 'plannedat', 'eventdate', 'timestamp'
]);
const TIME_KEYS = new Set(['time', 'drawtime', 'starttime', 'eventtime']);
const DIGIT_KEYS = new Set([
  'winningnumbers', 'winningnumber', 'winningcombination', 'numbers',
  'combination', 'balls', 'digits', 'result', 'results', 'drawresult',
  'winnumbers', 'numberstirage'
]);

function directDrawId(object) {
  for (const [key, value] of Object.entries(object)) {
    if (!ID_KEYS.has(normalizeKey(key))) continue;
    const id = parseDrawId(value);
    if (id) return id;
  }

  for (const [key, value] of Object.entries(object)) {
    if (!['drawinfo', 'drawdata', 'draw'].includes(normalizeKey(key))) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (!ID_KEYS.has(normalizeKey(nestedKey))) continue;
      const id = parseDrawId(nestedValue);
      if (id) return id;
    }
  }

  return null;
}

function findDigitsInObject(object, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 3) return null;

  for (const [key, value] of Object.entries(object)) {
    if (!DIGIT_KEYS.has(normalizeKey(key))) continue;
    const digits = parseThreeDigits(value);
    if (digits) return digits;
  }

  for (const [key, value] of Object.entries(object)) {
    if (!value || typeof value !== 'object') continue;
    const normalizedKey = normalizeKey(key);
    if (!/(win|result|combination|number|ball|draw)/.test(normalizedKey)) continue;
    const digits = findDigitsInObject(value, depth + 1);
    if (digits) return digits;
  }

  return null;
}

function findDateTimeInObject(object, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 3) return null;

  let separateDate = '';
  let separateTime = '';

  for (const [key, value] of Object.entries(object)) {
    const normalizedKey = normalizeKey(key);
    if (DATE_KEYS.has(normalizedKey)) {
      const combined = parseDateTime(value);
      if (combined?.date && combined?.time) return combined;
      const dateOnly = normalizeDate(value);
      if (dateOnly) separateDate = dateOnly;
    }
    if (TIME_KEYS.has(normalizedKey)) {
      const timeOnly = normalizeTime(value);
      if (timeOnly) separateTime = timeOnly;
    }
  }

  if (separateDate && separateTime) return { date: separateDate, time: separateTime };

  for (const [key, value] of Object.entries(object)) {
    if (!value || typeof value !== 'object') continue;
    if (!/(draw|date|time|event|start|plan)/.test(normalizeKey(key))) continue;
    const nested = findDateTimeInObject(value, depth + 1);
    if (!nested) continue;
    if (!separateDate && nested.date) separateDate = nested.date;
    if (!separateTime && nested.time) separateTime = nested.time;
    if (separateDate && separateTime) return { date: separateDate, time: separateTime };
  }

  return separateDate || separateTime ? { date: separateDate, time: separateTime } : null;
}

function parseStolotoJson(payload) {
  const root = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const found = new Map();
  const seen = new Set();

  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (!Array.isArray(value)) {
      const id = directDrawId(value);
      if (id) {
        const digits = findDigitsInObject(value);
        const dateTime = findDateTimeInObject(value);
        if (digits && dateTime) {
          const draw = normalizeDraw({
            id,
            date: dateTime.date,
            time: dateTime.time,
            a: digits[0],
            b: digits[1],
            c: digits[2]
          });
          if (draw) found.set(draw.id, draw);
        }
      }
    }

    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };

  visit(root);
  return [...found.values()].sort((a, b) => b.id - a.id);
}

function parseJsonScripts(text) {
  const found = new Map();
  const candidates = [];

  for (const match of String(text).matchAll(
    /<script\b[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    candidates.push(match[1].trim());
  }

  for (const candidate of candidates) {
    try {
      for (const draw of parseStolotoJson(candidate)) found.set(draw.id, draw);
    } catch {
      // На странице могут встречаться служебные JSON-блоки — пропускаем их.
    }
  }

  return [...found.values()].sort((a, b) => b.id - a.id);
}

function parseStolotoText(text, expectedId = null) {
  const source = String(text ?? '').replace(/\u00a0/g, ' ');
  const found = new Map(parseJsonScripts(source).map(draw => [draw.id, draw]));

  // Старый и резервный HTML Столото: <ul class="winning_numbers"><li>1</li>...</ul>
  const numberBlocks = [...source.matchAll(
    /<(?:ul|div)\b[^>]*class=["'][^"']*(?:winning[_-]?numbers|winningNumbers)[^"']*["'][^>]*>([\s\S]*?)<\/(?:ul|div)>/gi
  )];

  for (const block of numberBlocks) {
    const digits = [...block[1].matchAll(/<(?:li|span|b)\b[^>]*>\s*0?([0-9])\s*<\/(?:li|span|b)>/gi)]
      .map(match => Number(match[1]));
    if (digits.length < 3) continue;

    const nearbyStart = Math.max(0, block.index - 2500);
    const nearbyEnd = Math.min(source.length, block.index + block[0].length + 1500);
    const nearby = source.slice(nearbyStart, nearbyEnd);
    const plain = stripMarkup(nearby);
    const id = expectedId ?? parseDrawId(plain.match(/(?:№|тираж[^0-9]{0,20})(\d{6})/i)?.[1]);
    const dateTime = parseDateTime(plain);
    const draw = normalizeDraw({
      id,
      date: dateTime?.date,
      time: dateTime?.time,
      a: digits[0], b: digits[1], c: digits[2]
    });
    if (draw) found.set(draw.id, draw);
  }

  // Markdown/текстовая таблица официального архива: дата, время, № и три цифры.
  const plain = stripMarkup(source);
  const rowPatterns = [
    /(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})\s+(\d{1,2}:\d{2})(?:[:]\d{2})?[^\d]{0,40}(\d{6})[^\d]{0,80}0?([0-9])\D+0?([0-9])\D+0?([0-9])/g,
    /(?:№|тираж[^0-9]{0,12})(\d{6})[^\d]{0,80}(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})[^\d]{0,20}(\d{1,2}:\d{2})[^\d]{0,100}0?([0-9])\D+0?([0-9])\D+0?([0-9])/gi
  ];

  for (const match of plain.matchAll(rowPatterns[0])) {
    const draw = normalizeDraw({
      id: match[3], date: match[1], time: match[2],
      a: match[4], b: match[5], c: match[6]
    });
    if (draw) found.set(draw.id, draw);
  }
  for (const match of plain.matchAll(rowPatterns[1])) {
    const draw = normalizeDraw({
      id: match[1], date: match[2], time: match[3],
      a: match[4], b: match[5], c: match[6]
    });
    if (draw) found.set(draw.id, draw);
  }

  return [...found.values()].sort((a, b) => b.id - a.id);
}

function parseLuckyText(text) {
  const normalized = String(text ?? '').replace(/\u00a0/g, ' ');
  const found = new Map();

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(cell => cell.trim());
    const idIndex = cells.findIndex(cell => /^\d{6}$/.test(stripMarkup(cell).replace(/\s/g, '')));
    if (idIndex < 0) continue;

    const dateTime = line.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    if (!dateTime) continue;

    let digits = null;
    for (let index = 0; index < idIndex; index += 1) {
      const candidate = parseButtonDigits(cells[index]);
      if (candidate) {
        digits = candidate;
        break;
      }
    }

    if (!digits) {
      for (let index = 0; index < idIndex; index += 1) {
        const cell = stripMarkup(cells[index]);
        if (cell.includes('+')) continue;
        const candidate = parseThreeDigits(cell);
        if (candidate) {
          digits = candidate;
          break;
        }
      }
    }

    if (!digits) continue;
    const draw = normalizeDraw({
      id: stripMarkup(cells[idIndex]).replace(/\s/g, ''),
      date: dateTime[1],
      time: dateTime[2],
      a: digits[0], b: digits[1], c: digits[2]
    });
    if (draw) found.set(draw.id, draw);
  }

  for (const match of normalized.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const plain = stripMarkup(row);
    const dateTime = plain.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    const idMatch = plain.match(/(?:^|\D)(\d{3})\s?(\d{3})(?:\D|$)/);
    if (!dateTime || !idMatch) continue;

    const digits = [...row.matchAll(/<button\b[^>]*>\s*([0-9])\s*<\/button>/gi)]
      .map(button => Number(button[1]));
    if (digits.length !== 3) continue;

    const draw = normalizeDraw({
      id: idMatch[1] + idMatch[2],
      date: dateTime[1],
      time: dateTime[2],
      a: digits[0], b: digits[1], c: digits[2]
    });
    if (draw) found.set(draw.id, draw);
  }

  return [...found.values()].sort((a, b) => b.id - a.id);
}

async function fetchText(url, headers = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Yulia-TOP3-Updater/1.0.19',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
        ...headers
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`источник не ответил за ${Math.round(timeoutMs / 1000)} секунд`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readSeed() {
  const text = (await fs.readFile(SEED_FILE, 'utf8')).trim();
  const json = text.replace(/^\s*window\.TOP3_SEED\s*=\s*/, '').replace(/;\s*$/, '');
  const rows = JSON.parse(json);
  return rows
    .map(row => normalizeDraw({ id: row[0], date: row[1], time: row[2], a: row[3], b: row[4], c: row[5] }))
    .filter(Boolean)
    .sort((a, b) => b.id - a.id);
}

async function readExisting() {
  try {
    const payload = JSON.parse(await fs.readFile(LIVE_FILE, 'utf8'));
    const draws = (Array.isArray(payload) ? payload : payload?.draws ?? [])
      .map(normalizeDraw)
      .filter(Boolean)
      .sort((a, b) => b.id - a.id);
    return {
      schema: 1,
      source: payload?.source ?? '',
      updatedAt: payload?.updatedAt ?? null,
      latest: Number(payload?.latest) || draws[0]?.id || 0,
      draws
    };
  } catch {
    return { schema: 1, source: '', updatedAt: null, latest: 0, draws: [] };
  }
}

function sameDraw(first, second) {
  return Boolean(first && second)
    && first.id === second.id
    && first.date === second.date
    && first.time === second.time
    && first.a === second.a
    && first.b === second.b
    && first.c === second.c;
}

function uniqueDraws(draws) {
  const map = new Map();
  for (const rawDraw of draws) {
    const draw = normalizeDraw(rawDraw);
    if (draw) map.set(draw.id, draw);
  }
  return [...map.values()].sort((a, b) => b.id - a.id);
}

function validateAgainstTrusted(draws, trusted) {
  const valid = uniqueDraws(draws);
  if (valid.length < 3) throw new Error(`распознано только ${valid.length} строк`);

  const trustedById = new Map(uniqueDraws(trusted).map(draw => [draw.id, draw]));
  const overlap = valid.filter(draw => trustedById.has(draw.id));
  if (overlap.length < 3) throw new Error('нет трёх контрольных строк из проверенного архива');

  const mismatch = overlap.find(draw => !sameDraw(draw, trustedById.get(draw.id)));
  if (mismatch) throw new Error(`контрольная строка №${mismatch.id} распознана неверно`);

  return valid;
}

async function fetchOfficialApi(reference) {
  const stamp = Date.now();
  const settled = await Promise.allSettled(STOLOTO_API_URLS.map(async baseUrl => {
    const url = `${baseUrl}&_=${stamp}`;
    const text = await fetchText(url, {
      'Accept': 'application/json,text/plain,*/*',
      'Referer': `${STOLOTO_ARCHIVE_URL}/`
    });
    const draws = validateAgainstTrusted(parseStolotoJson(text), reference);
    return {
      draws,
      source: `Столото API v${baseUrl.match(/\/v(\d+)\//)?.[1] ?? '?'}`
    };
  }));

  const results = settled
    .filter(item => item.status === 'fulfilled')
    .map(item => item.value);
  if (!results.length) {
    const errors = settled
      .filter(item => item.status === 'rejected')
      .map(item => item.reason?.message ?? item.reason);
    throw new Error(errors.join('; '));
  }
  return results.sort((a, b) => b.draws[0].id - a.draws[0].id)[0];
}
async function fetchOfficialPages(reference) {
  const referenceDraws = uniqueDraws(reference);
  const latestKnown = referenceDraws[0]?.id || 0;
  if (!latestKnown) throw new Error('не найден последний известный тираж для проверки страниц Столото');

  const found = new Map();
  const errors = [];
  let consecutiveMisses = 0;

  // Три старых страницы нужны для контрольной сверки, затем ищем до 12 новых тиражей.
  for (let id = Math.max(100_000, latestKnown - 2); id <= latestKnown + 12; id += 1) {
    try {
      const text = await fetchText(`${STOLOTO_ARCHIVE_URL}/${id}?_=${Date.now()}`, {
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Referer': `${STOLOTO_ARCHIVE_URL}/`
      }, 25_000);
      const parsed = parseStolotoText(text, id).find(draw => draw.id === id);
      if (parsed) {
        found.set(parsed.id, parsed);
        consecutiveMisses = 0;
      } else if (id > latestKnown) {
        consecutiveMisses += 1;
      }
    } catch (error) {
      errors.push(`№${id}: ${error?.message ?? error}`);
      if (id > latestKnown) consecutiveMisses += 1;
    }

    // После двух будущих пустых страниц дальше тиражи ещё не состоялись.
    if (id > latestKnown && consecutiveMisses >= 2) break;
  }

  try {
    const draws = validateAgainstTrusted([...found.values()], reference);
    return { draws, source: 'Столото — страницы тиражей' };
  } catch (error) {
    throw new Error(`${error.message}${errors.length ? `; ${errors.slice(0, 3).join('; ')}` : ''}`);
  }
}

async function fetchLucky(reference) {
  const stamp = Date.now();
  const sources = [
    {
      name: 'Lucky Numbers напрямую',
      url: `${LUCKY_URL}?top3_action=${stamp}`,
      headers: { 'Accept': 'text/html,*/*;q=0.8' }
    },
    {
      name: 'Lucky Numbers через Jina Reader',
      url: `https://r.jina.ai/${LUCKY_URL}?top3_action=${stamp}`,
      headers: { 'Accept': 'text/markdown,text/plain,*/*', 'X-No-Cache': 'true', 'X-Return-Format': 'markdown' }
    }
  ];

  const settled = await Promise.allSettled(sources.map(async source => {
    const text = await fetchText(source.url, source.headers);
    const draws = validateAgainstTrusted(parseLuckyText(text), reference);
    return { draws, source: source.name };
  }));

  const results = settled
    .filter(item => item.status === 'fulfilled')
    .map(item => item.value);
  if (!results.length) {
    const errors = settled
      .filter(item => item.status === 'rejected')
      .map(item => item.reason?.message ?? item.reason);
    throw new Error(errors.join('; '));
  }
  return results.sort((a, b) => b.draws[0].id - a.draws[0].id)[0];
}
async function fetchLatest(reference) {
  const latestKnown = uniqueDraws(reference)[0]?.id || 0;
  const baseAttempts = [
    ['Столото API', () => fetchOfficialApi(reference)],
    ['Lucky Numbers', () => fetchLucky(reference)]
  ];

  const settled = await Promise.allSettled(baseAttempts.map(async ([label, load]) => {
    const result = await load();
    return { label, result };
  }));

  const successes = [];
  const errors = [];
  let officialApiSucceeded = false;

  settled.forEach((item, index) => {
    const label = baseAttempts[index][0];
    if (item.status === 'fulfilled') {
      const { result } = item.value;
      successes.push(result);
      if (label === 'Столото API') officialApiSucceeded = true;
      console.log(`${label}: последний распознанный тираж №${result.draws[0].id}; строк ${result.draws.length}.`);
    } else {
      const message = item.reason?.message ?? item.reason;
      errors.push(`${label}: ${message}`);
      console.warn(`${label} недоступен: ${message}`);
    }
  });

  const bestBaseLatest = successes.reduce((max, item) => Math.max(max, item.draws[0]?.id || 0), 0);

  // Если официальный API недоступен, а Lucky не дал ничего новее уже сохранённого
  // файла, проверяем персональные страницы следующих тиражей Столото.
  if (!officialApiSucceeded && bestBaseLatest <= latestKnown) {
    try {
      const pages = await fetchOfficialPages(reference);
      successes.push(pages);
      console.log(`Столото страницы: последний распознанный тираж №${pages.draws[0].id}; строк ${pages.draws.length}.`);
    } catch (error) {
      errors.push(`Столото страницы: ${error?.message ?? error}`);
      console.warn(`Столото страницы недоступны: ${error?.message ?? error}`);
    }
  }

  if (!successes.length) throw new Error(errors.join('; '));

  successes.sort((first, second) => {
    const latestDifference = second.draws[0].id - first.draws[0].id;
    return latestDifference || second.draws.length - first.draws.length;
  });
  return successes[0];
}
function sameDraws(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

async function main() {
  const trusted = await readSeed();
  const existing = await readExisting();
  const reference = uniqueDraws([...existing.draws, ...trusted]);
  const result = await fetchLatest(reference);

  const map = new Map();

  // Сначала кладём проверенную встроенную основу, затем существующий live-файл.
  // Это запрещает откат: даже если внешний сайт задержался, уже сохранённые новые тиражи не исчезнут.
  for (const draw of trusted.slice(0, 150)) map.set(draw.id, draw);
  for (const draw of existing.draws) map.set(draw.id, draw);
  for (const draw of result.draws) map.set(draw.id, draw);

  const draws = [...map.values()].sort((a, b) => b.id - a.id).slice(0, 150);
  if (draws.length < 3) throw new Error('после объединения осталось слишком мало тиражей');

  if (sameDraws(draws, existing.draws)) {
    console.log(`Новых тиражей нет. Последний №${draws[0].id}. Файл не изменён.`);
    return;
  }

  const payload = {
    schema: 2,
    source: result.source,
    updatedAt: new Date().toISOString(),
    latest: draws[0].id,
    regularTimes: [...REGULAR_DRAW_TIMES],
    draws
  };

  await fs.writeFile(LIVE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Обновлён top3-live.json. Последний №${draws[0].id}; строк: ${draws.length}; источник: ${result.source}.`);
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

export {
  normalizeDate,
  normalizeTime,
  parseDateTime,
  parseLuckyText,
  parseStolotoJson,
  parseStolotoText,
  validateAgainstTrusted,
  uniqueDraws
};
