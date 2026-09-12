import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const HISTORY_FILE = new URL('./top3-history.json', import.meta.url);
const SEED_FILE = new URL('./top3-data.js', import.meta.url);

function validDraw(draw) {
  return Number.isInteger(draw?.id)
    && draw.id > 0
    && /^\d{2}\.\d{2}\.\d{2}$/.test(String(draw.date || ''))
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(draw.time || ''))
    && [draw.a, draw.b, draw.c].every(n => Number.isInteger(n) && n >= 0 && n <= 9);
}

function normalizeDraw(draw) {
  const item = {
    id: Number(draw?.id), date: String(draw?.date || ''), time: String(draw?.time || ''),
    a: Number(draw?.a), b: Number(draw?.b), c: Number(draw?.c)
  };
  return validDraw(item) ? item : null;
}

function dedupe(draws) {
  const map = new Map();
  for (const raw of draws) {
    const draw = normalizeDraw(raw);
    if (draw) map.set(draw.id, draw);
  }
  return [...map.values()].sort((a,b) => b.id - a.id);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function readSeed() {
  const source = await fs.readFile(SEED_FILE, 'utf8');
  const match = source.match(/window\.TOP3_SEED\s*=\s*(\[[\s\S]*\])\s*;?\s*$/);
  if (!match) throw new Error('Не удалось прочитать window.TOP3_SEED');
  const tuples = JSON.parse(match[1]);
  return tuples.map(row => ({ id:Number(row[0]), date:String(row[1]), time:String(row[2]), a:Number(row[3]), b:Number(row[4]), c:Number(row[5]) }));
}

const live = await readJson(LIVE_FILE, { draws: [], forecasts: [] });
const historyFile = await readJson(HISTORY_FILE, { draws: [] });
const seed = await readSeed();
const history = Array.isArray(historyFile.draws) ? historyFile.draws : [];
const liveDraws = Array.isArray(live.draws) ? live.draws : [];
const merged = dedupe([...seed, ...history, ...liveDraws]);

const persistent = {
  schema: 4,
  fullArchive: true,
  source: String(live.source || historyFile.source || 'Официальный Столото · OAuth · двойная проверка'),
  updatedAt: new Date().toISOString(),
  latest: merged[0]?.id ?? null,
  archiveFrom: merged.at(-1)?.id ?? null,
  archiveTo: merged[0]?.id ?? null,
  regularTimes: Array.isArray(live.regularTimes) ? live.regularTimes : [],
  forecasts: Array.isArray(live.forecasts) ? live.forecasts : (Array.isArray(historyFile.forecasts) ? historyFile.forecasts : []),
  draws: merged
};

await fs.writeFile(HISTORY_FILE, JSON.stringify(persistent, null, 2) + '\n', 'utf8');
console.log('full archive persisted: ' + merged.length + ' draws · ' + (persistent.archiveFrom ?? '—') + ' → ' + (persistent.archiveTo ?? '—'));
