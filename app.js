'use strict';

const APP_VERSION = '1.0.4';
const DB_NAME = 'yulia-top3-db';
const DB_VERSION = 1;
const STORE = 'draws';
const DRAW_TIMES = ['02:40','04:40','06:40','07:40','09:40','11:40','13:40','16:25','21:25','22:40'];
const AUTO_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_STATUS_KEY = 'yulia-top3-auto-status-v1';
const LUCKY_ARCHIVE_URL = 'https://lucky-numbers.ru/lottery/ru/top3';
const BAD_LUCKY_REPAIR_KEY = 'yulia-top3-bad-lucky-rows-repaired-v1.0.4';

let db;
let draws = [];
let archiveShown = 50;
let toastTimer;
let syncInProgress = false;
let autoCheckTimer = null;
let syncStatus = loadSyncStatus();

const $ = (id) => document.getElementById(id);
const qsa = (sel) => [...document.querySelectorAll(sel)];

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

async function seedDatabase(force = false) {
  if (!Array.isArray(window.TOP3_SEED)) throw new Error('Встроенный архив не найден');
  const existing = await countDB();
  if (existing && !force) return;
  $('loadingText').textContent = `Сохраняю ${window.TOP3_SEED.length.toLocaleString('ru-RU')} тиражей…`;
  if (force) {
    const clearTx = db.transaction(STORE, 'readwrite');
    clearTx.objectStore(STORE).clear();
    await txDone(clearTx);
  }
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const row of window.TOP3_SEED) {
    store.put({ id: row[0], date: row[1], time: row[2], a: row[3], b: row[4], c: row[5] });
  }
  await txDone(tx);
}

async function loadAllDraws() {
  const result = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
}

function renderArchive(reset = false) {
  if (reset) archiveShown = Number($('archiveLimit').value) || 50;
  const term = $('archiveSearch').value.trim().toLowerCase();
  const filtered = term ? draws.filter(d => String(d.id).includes(term) || d.date.includes(term) || `${d.a}${d.b}${d.c}`.includes(term)) : draws;
  const visible = filtered.slice(0, archiveShown);
  $('archiveInfo').textContent = `${filtered.length.toLocaleString('ru-RU')} тиражей найдено`;
  $('archiveList').innerHTML = visible.map(d=>`<article class="archive-row"><div><h4>№ ${d.id}</h4><p>${d.date} · ${d.time} · ${patternOf(d)}</p></div><div class="mini-digits"><b>${d.a}</b><b>${d.b}</b><b>${d.c}</b></div></article>`).join('');
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
    return { state:'idle', message:'', source:'Lucky Numbers', ...JSON.parse(localStorage.getItem(AUTO_STATUS_KEY) || '{}') };
  } catch {
    return { state:'idle', message:'', source:'Lucky Numbers' };
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
  $('syncSource').textContent = syncStatus.source || 'Lucky Numbers';
  $('syncMessage').textContent = syncStatus.message || 'При открытии приложения проверю новые тиражи. Затем — каждые 15 минут, пока приложение открыто.';
  const busy = syncStatus.state === 'checking';
  for (const id of ['refreshBtn','onlineUpdateBtn','dataOnlineUpdateBtn']) {
    const button = $(id);
    if (button) button.disabled = busy;
  }
  $('refreshBtn').classList.toggle('spinning', busy);
}

function parseLuckyArchive(text) {
  const normalized = String(text || '').replace(/\u00a0/g,' ');
  const found = new Map();

  // Принимаем только полноценные строки таблицы архива Lucky Numbers.
  // Кнопки генератора и другие цифры со страницы сюда не проходят.
  for (const line of normalized.split(/\r?\n/)) {
    const row = line.match(/^\s*\d+\s*\|\s*\|\s*\[Button:\s*([0-9])\]\s*\[Button:\s*([0-9])\]\s*\[Button:\s*([0-9])\]\s*\|\s*\|\s*\|\s*\|\s*((?:[0-9][\s]*){6})\s*\|[^\n]*?(\d{2}\.\d{2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
    if (!row) continue;
    const item = {
      id: Number(row[4].replace(/\s/g,'')),
      date: normalizeDate(row[5]),
      time: normalizeTime(row[6]),
      a: Number(row[1]),
      b: Number(row[2]),
      c: Number(row[3])
    };
    if (isValidDraw(item) && DRAW_TIMES.includes(item.time)) found.set(item.id,item);
  }

  // Строгий запасной разбор сырой HTML-таблицы.
  if (!found.size && /<html|<table|<tr/i.test(normalized)) {
    try {
      const doc = new DOMParser().parseFromString(normalized,'text/html');
      for (const row of doc.querySelectorAll('tr')) {
        const txt = row.textContent.replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
        const dateTime = txt.match(/(\d{2}\.\d{2}\.\d{2,4})\s*,\s*(\d{1,2}:\d{2})/);
        const idMatch = txt.match(/(?:^|\s)(\d{3}\s?\d{3})(?:\s|$)/);
        const buttons = [...row.querySelectorAll('button')]
          .map(x=>x.textContent.trim())
          .filter(x=>/^[0-9]$/.test(x));
        if (!dateTime || !idMatch || buttons.length !== 3) continue;
        const item = {
          id: Number(idMatch[1].replace(/\s/g,'')),
          date: normalizeDate(dateTime[1]),
          time: normalizeTime(dateTime[2]),
          a: Number(buttons[0]),
          b: Number(buttons[1]),
          c: Number(buttons[2])
        };
        if (isValidDraw(item) && DRAW_TIMES.includes(item.time)) found.set(item.id,item);
      }
    } catch {}
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
  const stamp = Date.now();
  const sources = [
    { name:'Lucky Numbers через Jina Reader', url:`https://r.jina.ai/${LUCKY_ARCHIVE_URL}?positron=${stamp}` },
    { name:'Lucky Numbers напрямую', url:`${LUCKY_ARCHIVE_URL}?positron=${stamp}` }
  ];
  const errors=[];
  for (const source of sources) {
    try {
      const text = await fetchTextWithTimeout(source.url);
      const items = parseLuckyArchive(text);
      if (!items.length) throw new Error('в ответе не найдены тиражи');
      return { items, source:source.name };
    } catch (error) {
      errors.push(`${source.name}: ${error?.message || 'ошибка'}`);
    }
  }
  throw new Error(errors.join('; '));
}

function sameDraw(a,b) {
  return a && b
    && a.id===b.id
    && a.date===b.date
    && a.time===b.time
    && a.a===b.a
    && a.b===b.b
    && a.c===b.c;
}

function validateOnlineBatch(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('пустой ответ источника');
  const valid = items.filter(d=>isValidDraw(d) && DRAW_TIMES.includes(d.time));
  if (valid.length < 3) throw new Error('источник вернул слишком мало проверяемых строк');
  const ids = new Set(valid.map(d=>d.id));
  if (ids.size !== valid.length) throw new Error('источник вернул дубли');

  // Перед добавлением новых тиражей сверяем минимум три уже известные строки.
  // Если хотя бы одна цифра, дата или время не совпали — ничего не сохраняем.
  const localById = new Map(draws.map(d=>[d.id,d]));
  const overlap = valid.filter(d=>localById.has(d.id));
  if (overlap.length < 3) throw new Error('недостаточно контрольных совпадений с локальным архивом');
  const mismatch = overlap.find(d=>!sameDraw(d,localById.get(d.id)));
  if (mismatch) throw new Error(`контрольная сверка не пройдена на тираже №${mismatch.id}`);

  const localLatest = draws[0]?.id || 0;
  const sourceLatest = Math.max(...valid.map(d=>d.id));
  if (localLatest && sourceLatest < localLatest) throw new Error(`источник ещё не догнал локальную базу: у него №${sourceLatest}, в приложении №${localLatest}`);
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
    const message=added
      ? `Добавлено новых тиражей: ${added}. Последний найденный — №${sourceLatest}.`
      : `Новых тиражей нет. Последний найденный — №${sourceLatest}.`;
    saveSyncStatus({state:'success',lastSuccess:success,source:result.source,lastAdded:added,sourceLatest,message});
    if (!silent || added) showToast(message);
  } catch (error) {
    const message=`Автообновление не выполнено: ${error?.message || 'неизвестная ошибка'}. Локальная база сохранена.`;
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

function bindEvents() {
  qsa('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const name=btn.dataset.view;
    qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));
    qsa('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
    if (name==='archive') renderArchive(true);
    if (name==='analysis') renderAnalysis();
    window.scrollTo({top:0,behavior:'smooth'});
  }));

  $('refreshBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('onlineUpdateBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('dataOnlineUpdateBtn').addEventListener('click',()=>checkOnlineDraws({manual:true}));
  $('archiveSearch').addEventListener('input',()=>renderArchive(true));
  $('archiveLimit').addEventListener('change',()=>renderArchive(true));
  $('loadMoreBtn').addEventListener('click',()=>{ archiveShown+=Number($('archiveLimit').value)||50; renderArchive(); });
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

async function repairBadLuckyRowsOnce() {
  if (localStorage.getItem(BAD_LUCKY_REPAIR_KEY) === 'done') return 0;
  const bad = new Map([
    [267355,'000'],
    [267356,'111']
  ]);
  const currentRows = await new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,'readonly').objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  const idsToDelete = currentRows
    .filter(d=>bad.get(d.id) === `${d.a}${d.b}${d.c}`)
    .map(d=>d.id);
  if (idsToDelete.length) {
    const tx=db.transaction(STORE,'readwrite');
    const store=tx.objectStore(STORE);
    idsToDelete.forEach(id=>store.delete(id));
    await txDone(tx);
  }
  localStorage.setItem(BAD_LUCKY_REPAIR_KEY,'done');
  if (idsToDelete.length) saveSyncStatus({state:'idle',message:`Удалены ошибочно распознанные тиражи: ${idsToDelete.length}. Выполняю строгую повторную проверку источника.`});
  return idsToDelete.length;
}

async function start() {
  try {
    db=await openDB();
    await seedDatabase();
    await repairBadLuckyRowsOnce();
    await loadAllDraws();
    bindEvents();
    initializeAnalysisTools();
    renderAll();
    $('loading').classList.add('hidden');
    startAutoChecks();
    setTimeout(()=>checkOnlineDraws({silent:true}),800);
  } catch (error) {
    console.error(error);
    $('loadingText').textContent='Ошибка загрузки базы. Закрой приложение и открой снова.';
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg=>reg.update()).catch(console.error);
  }
}

document.addEventListener('DOMContentLoaded',start);
