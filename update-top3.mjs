import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const TARGET_URL = 'https://lucky-numbers.ru/lottery/ru/top3';
const DRAW_TIMES = new Set(['02:40','04:40','06:40','07:40','09:40','11:40','13:40','16:25','21:25','22:40']);

function normalizeDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return '';
  return `${m[1].padStart(2,'0')}.${m[2].padStart(2,'0')}.${m[3].slice(-2)}`;
}

function normalizeTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
}

function validDraw(d) {
  return Number.isInteger(d.id) && d.id > 0
    && /^\d{2}\.\d{2}\.\d{2}$/.test(d.date)
    && DRAW_TIMES.has(d.time)
    && [d.a,d.b,d.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9);
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitsBeforeId(line, idStart) {
  const before = line.slice(0, idStart);
  const buttons = [...before.matchAll(/\[Button:\s*([0-9])\]/gi)].map(m => Number(m[1]));
  if (buttons.length >= 3) return buttons.slice(-3);

  const cells = before.split('|').map(stripMarkdown).filter(Boolean);
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (cell.includes('+')) continue;
    const spaced = cell.match(/(?:^|\D)([0-9])\D+([0-9])\D+([0-9])(?:\D|$)/);
    if (spaced) return [Number(spaced[1]), Number(spaced[2]), Number(spaced[3])];
    const compact = cell.replace(/\D/g,'');
    if (/^[0-9]{3}$/.test(compact)) return [...compact].map(Number);
  }

  const singles = cells.filter(c => /^[0-9]$/.test(c));
  if (singles.length >= 3) return singles.slice(-3).map(Number);
  return null;
}

export function parseLuckyText(text) {
  const normalized = String(text || '').replace(/\u00a0/g,' ');
  const found = new Map();

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    const dateTime = line.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    if (!dateTime) continue;
    const idMatch = line.match(/(?:^|\D)(\d{3})[\s\u00a0]?(\d{3})(?:\D|$)/);
    if (!idMatch) continue;
    const idStart = idMatch.index + (idMatch[0].match(/^\D/) ? 1 : 0);
    const digits = digitsBeforeId(line, idStart);
    if (!digits) continue;
    const draw = {
      id: Number(idMatch[1] + idMatch[2]),
      date: normalizeDate(dateTime[1]),
      time: normalizeTime(dateTime[2]),
      a: digits[0], b: digits[1], c: digits[2]
    };
    if (validDraw(draw)) found.set(draw.id, draw);
  }

  // Запасной разбор HTML-строк, если источник вернул не markdown.
  if (found.size < 3 && /<tr[\s>]/i.test(normalized)) {
    for (const rowMatch of normalized.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = rowMatch[1];
      const textRow = stripMarkdown(row);
      const dateTime = textRow.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
      const idMatch = textRow.match(/(?:^|\D)(\d{3})\s?(\d{3})(?:\D|$)/);
      if (!dateTime || !idMatch) continue;
      let digits = [...row.matchAll(/<button\b[^>]*>\s*([0-9])\s*<\/button>/gi)].map(m => Number(m[1]));
      if (digits.length !== 3) {
        const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripMarkdown(m[1]));
        const idCell = cells.findIndex(c => c.replace(/\s/g,'') === idMatch[1] + idMatch[2]);
        if (idCell >= 0) digits = digitsBeforeId(cells.slice(0,idCell+1).join('|'), cells.slice(0,idCell).join('|').length);
      }
      if (!digits || digits.length !== 3) continue;
      const draw = {
        id:Number(idMatch[1]+idMatch[2]), date:normalizeDate(dateTime[1]), time:normalizeTime(dateTime[2]),
        a:digits[0], b:digits[1], c:digits[2]
      };
      if (validDraw(draw)) found.set(draw.id, draw);
    }
  }

  return [...found.values()].sort((a,b) => b.id - a.id);
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':'Yulia-TOP3-GitHub-Action/1.0',
        'Accept':'text/plain,text/markdown,text/html;q=0.9,*/*;q=0.8',
        ...headers
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLatest() {
  const stamp = Date.now();
  const sources = [
    {
      name:'Lucky Numbers через Jina Reader',
      url:`https://r.jina.ai/${TARGET_URL}?top3_action=${stamp}`,
      headers:{'X-No-Cache':'true','X-Return-Format':'markdown'}
    },
    {
      name:'Lucky Numbers напрямую',
      url:`${TARGET_URL}?top3_action=${stamp}`,
      headers:{'Accept':'text/html,*/*;q=0.8'}
    }
  ];
  const errors=[];
  for (const source of sources) {
    try {
      const text = await fetchText(source.url, source.headers);
      const draws = parseLuckyText(text);
      if (draws.length < 3) throw new Error(`распознано только ${draws.length} строк`);
      return {draws, source:source.name};
    } catch (error) {
      errors.push(`${source.name}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(LIVE_FILE,'utf8'));
  } catch {
    return {schema:1,source:'',updatedAt:null,latest:0,draws:[]};
  }
}

function sameDraws(a,b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const existing = await readExisting();
  const result = await fetchLatest();
  const map = new Map();
  for (const d of [...result.draws, ...(Array.isArray(existing.draws) ? existing.draws : [])]) {
    if (validDraw(d) && !map.has(d.id)) map.set(d.id,d);
  }
  const draws = [...map.values()].sort((a,b)=>b.id-a.id).slice(0,100);
  if (draws.length < 3) throw new Error('после объединения осталось слишком мало тиражей');

  if (sameDraws(draws, existing.draws || [])) {
    console.log(`Новых тиражей нет. Последний №${draws[0].id}. Файл не изменён.`);
    return;
  }

  const payload = {
    schema:1,
    source:result.source,
    updatedAt:new Date().toISOString(),
    latest:draws[0].id,
    draws
  };
  await fs.writeFile(LIVE_FILE, JSON.stringify(payload,null,2)+'\n','utf8');
  console.log(`Обновлён top3-live.json. Последний №${draws[0].id}; строк: ${draws.length}.`);
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isMain) main().catch(error => { console.error(error); process.exit(1); });
