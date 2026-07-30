import fs from 'node:fs/promises';

const LIVE_FILE = new URL('./top3-live.json', import.meta.url);
const SEED_FILE = new URL('./top3-data.js', import.meta.url);
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
function stripMarkup(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function parseButtonDigits(fragment) {
  const buttons=[...String(fragment).matchAll(/(?:\[Button:\s*|<button\b[^>]*>\s*)([0-9])(?:\]|\s*<\/button>)/gi)].map(m=>Number(m[1]));
  return buttons.length === 3 ? buttons : null;
}
function parseLuckyText(text) {
  const normalized=String(text||'').replace(/\u00a0/g,' ');
  const found=new Map();

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line=rawLine.trim();
    if (!line.includes('|')) continue;
    const cells=line.split('|').map(c=>c.trim());
    const idIndex=cells.findIndex(c=>/^\d{6}$/.test(stripMarkup(c).replace(/\s/g,'')));
    if (idIndex<0) continue;
    const dateTime=line.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    if (!dateTime) continue;
    let digits=null;
    for (let i=0;i<idIndex;i++) {
      const candidate=parseButtonDigits(cells[i]);
      if (candidate) { digits=candidate; break; }
    }
    if (!digits) {
      for (let i=0;i<idIndex;i++) {
        const cell=stripMarkup(cells[i]);
        if (cell.includes('+')) continue;
        const spaced=cell.match(/^([0-9])\D+([0-9])\D+([0-9])$/);
        if (spaced) { digits=[+spaced[1],+spaced[2],+spaced[3]]; break; }
        const compact=cell.replace(/\D/g,'');
        if (/^[0-9]{3}$/.test(compact)) { digits=[...compact].map(Number); break; }
      }
    }
    if (!digits) continue;
    const draw={id:Number(stripMarkup(cells[idIndex]).replace(/\s/g,'')),date:normalizeDate(dateTime[1]),time:normalizeTime(dateTime[2]),a:digits[0],b:digits[1],c:digits[2]};
    if (validDraw(draw)) found.set(draw.id,draw);
  }

  for (const match of normalized.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row=match[1];
    const plain=stripMarkup(row);
    const dateTime=plain.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    const idMatch=plain.match(/(?:^|\D)(\d{3})\s?(\d{3})(?:\D|$)/);
    if (!dateTime||!idMatch) continue;
    const digits=[...row.matchAll(/<button\b[^>]*>\s*([0-9])\s*<\/button>/gi)].map(m=>Number(m[1]));
    if (digits.length!==3) continue;
    const draw={id:Number(idMatch[1]+idMatch[2]),date:normalizeDate(dateTime[1]),time:normalizeTime(dateTime[2]),a:digits[0],b:digits[1],c:digits[2]};
    if (validDraw(draw)) found.set(draw.id,draw);
  }
  return [...found.values()].sort((a,b)=>b.id-a.id);
}
async function fetchText(url, headers={}) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),45000);
  try {
    const response=await fetch(url,{signal:controller.signal,redirect:'follow',headers:{'User-Agent':'Yulia-TOP3-GitHub-Action/1.0.12','Accept':'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.8',...headers}});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timeout); }
}
async function readSeed() {
  const text=(await fs.readFile(SEED_FILE,'utf8')).trim();
  const json=text.replace(/^\s*window\.TOP3_SEED\s*=\s*/,'').replace(/;\s*$/,'');
  const rows=JSON.parse(json);
  return rows.map(r=>({id:+r[0],date:String(r[1]),time:String(r[2]),a:+r[3],b:+r[4],c:+r[5]})).filter(validDraw);
}
function sameDraw(a,b){return a&&b&&a.id===b.id&&a.date===b.date&&a.time===b.time&&a.a===b.a&&a.b===b.b&&a.c===b.c;}
function validateAgainstTrusted(draws, trusted) {
  if (draws.length<3) throw new Error(`распознано только ${draws.length} строк`);
  const trustedById=new Map(trusted.map(d=>[d.id,d]));
  const overlap=draws.filter(d=>trustedById.has(d.id));
  if (overlap.length<3) throw new Error('нет трёх контрольных строк из проверенного архива');
  const mismatch=overlap.find(d=>!sameDraw(d,trustedById.get(d.id)));
  if (mismatch) throw new Error(`контрольная строка №${mismatch.id} распознана неверно`);
  return draws;
}
async function fetchLatest(trusted) {
  const stamp=Date.now();
  const sources=[
    {name:'Lucky Numbers напрямую',url:`${TARGET_URL}?top3_action=${stamp}`,headers:{'Accept':'text/html,*/*;q=0.8'}},
    {name:'Lucky Numbers через Jina Reader',url:`https://r.jina.ai/${TARGET_URL}?top3_action=${stamp}`,headers:{'X-No-Cache':'true','X-Return-Format':'markdown'}}
  ];
  const errors=[];
  for (const source of sources) {
    try {
      const text=await fetchText(source.url,source.headers);
      const draws=validateAgainstTrusted(parseLuckyText(text),trusted);
      return {draws,source:source.name};
    } catch(error) { errors.push(`${source.name}: ${error?.message||error}`); }
  }
  throw new Error(errors.join('; '));
}
async function readExisting(){try{return JSON.parse(await fs.readFile(LIVE_FILE,'utf8'));}catch{return {schema:1,source:'',updatedAt:null,latest:0,draws:[]};}}
function sameDraws(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function main(){
  const trusted=await readSeed();
  const existing=await readExisting();
  const result=await fetchLatest(trusted);
  const trustedById=new Map(trusted.map(d=>[d.id,d]));
  const map=new Map();
  for (const d of trusted.slice(0,100)) map.set(d.id,d);
  for (const d of result.draws) if(validDraw(d)&&!trustedById.has(d.id)) map.set(d.id,d);
  const draws=[...map.values()].sort((a,b)=>b.id-a.id).slice(0,100);
  if (draws.length<3) throw new Error('после объединения осталось слишком мало тиражей');
  if (sameDraws(draws,existing.draws||[])) { console.log(`Новых тиражей нет. Последний №${draws[0].id}. Файл не изменён.`); return; }
  const payload={schema:1,source:result.source,updatedAt:new Date().toISOString(),latest:draws[0].id,draws};
  await fs.writeFile(LIVE_FILE,JSON.stringify(payload,null,2)+'\n','utf8');
  console.log(`Обновлён top3-live.json. Последний №${draws[0].id}; строк: ${draws.length}.`);
}
const isMain=process.argv[1]&&new URL(`file://${process.argv[1]}`).href===import.meta.url;
if(isMain)main().catch(error=>{console.error(error);process.exit(1);});
export {parseLuckyText,validateAgainstTrusted};
