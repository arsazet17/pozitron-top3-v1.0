// TOP-3 storage patch: IndexedDB instead of localStorage
// Version: 1.0.2
// Restored robust storage layer. Full-archive bridge is appended below.

(() => {
  'use strict';

  const DB_NAME = 'top3-auto-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'state';
  const DEFAULT_KEY = 'top3-auto-state-v1';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not supported in this browser'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
      request.onblocked = () => console.warn('[TOP-3 storage] IndexedDB upgrade is blocked by another tab.');
    });
    return dbPromise;
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error('Failed to read IndexedDB'));
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
    });
  }

  async function idbClear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
    });
  }

  function safeParse(raw) {
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async function migrateFromLocalStorage(key = DEFAULT_KEY) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return false;
      await idbSet(key, safeParse(raw));
      localStorage.removeItem(key);
      console.info(`[TOP-3 storage] Migrated "${key}" from localStorage.`);
      return true;
    } catch (error) {
      console.warn('[TOP-3 storage] Migration skipped:', error);
      return false;
    }
  }

  async function saveState(state, key = DEFAULT_KEY) {
    try { await idbSet(key, state); return true; }
    catch (error) { console.error('[TOP-3 storage] saveState failed:', error); return false; }
  }

  async function loadState(key = DEFAULT_KEY) {
    try {
      let value = await idbGet(key);
      if (value == null) {
        const migrated = await migrateFromLocalStorage(key);
        if (migrated) value = await idbGet(key);
      }
      return value;
    } catch (error) {
      console.error('[TOP-3 storage] loadState failed:', error);
      return null;
    }
  }

  async function removeState(key = DEFAULT_KEY) {
    try {
      await idbDelete(key);
      try { localStorage.removeItem(key); } catch {}
      return true;
    } catch (error) {
      console.error('[TOP-3 storage] removeState failed:', error);
      return false;
    }
  }

  async function clearAllTop3Storage() {
    try {
      await idbClear();
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('top3-')) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
      } catch {}
      return true;
    } catch (error) {
      console.error('[TOP-3 storage] clearAllTop3Storage failed:', error);
      return false;
    }
  }

  async function estimateStorage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage ?? null,
        quota: estimate.quota ?? null,
        usageMB: estimate.usage ? +(estimate.usage / 1024 / 1024).toFixed(2) : null,
        quotaMB: estimate.quota ? +(estimate.quota / 1024 / 1024).toFixed(2) : null,
      };
    } catch { return null; }
  }

  window.Top3Storage = {
    DB_NAME, STORE_NAME, DEFAULT_KEY,
    saveState, loadState, removeState, migrateFromLocalStorage,
    clearAllTop3Storage, estimateStorage,
    set: idbSet, get: idbGet, delete: idbDelete, clear: idbClear,
  };

  migrateFromLocalStorage(DEFAULT_KEY).catch(() => {});
  migrateFromLocalStorage('yulia-top3-forecast-archive-v2-auto').catch(() => {});
})();

// ===== FULL ARCHIVE BRIDGE · 12.09.2026 =====
// Dated rows are real facts and join the application database.
// The older undated block stays search-only and never enters AI/time statistics.
const TOP3_ARCHIVE_PATCH_PACK='120926:12555721225678115593811259681055641102579909553880925345085594408252070755552072525006557150625843055509505258140455020042540203555170325297025565402254550155381012572600555830025701;110926:235585323256312255862222500021557252125236205529720250751955194192527118551201825567175567617257891655615162558515551341525691145536314258321355044132539412555281225500115560111252381055683102504109551800925718085571408250870755200072506106555810625634055554805253020455851042515703551690325928025545402250610155815012514900555110025113;100926:235500923250662255078222594921555012125020205568420251371955172192529718559011825729175539817255241655132162570815556541525414145588614257981355962132508712558801225188115513911256901055792102591709558300925247085578808259460755363072537306558260625108055539105254170455778042515903559310325012025580702254040155157012558900556850025243;090926:235533323251842255415222592621554502125477205521620256721955378192515418553601825718175534517256711655536162590515555241525829145546614253381355857132567412558621225994115505611253291055142102504109554550925834085545808255840755533072532306554640625597055560305250400455373042506503551890325565025578502259250155699012596100557590025007;080926:235522423253852255043222503421557412125720205586020257961955748192548618552121825900175580717253081655055162530315552521525262145561514257691340181';
(function applyTop3RealArchivePatch(){
  const out=[];
  let id=267946;
  for(const group of TOP3_ARCHIVE_PATCH_PACK.split(';')){
    const [d,s]=group.split(':');
    const date=`${d.slice(0,2)}.${d.slice(2,4)}.${d.slice(4,6)}`;
    for(let i=0;i<s.length;i+=7){
      const x=s.slice(i,i+7), time=`${x.slice(0,2)}:${x.slice(2,4)}`, c=x.slice(4,7);
      out.push([id--,date,time,+c[0],+c[1],+c[2]]);
    }
  }
  window.TOP3_ARCHIVE_PATCH=out;
  if(Array.isArray(window.TOP3_SEED)){
    const map=new Map(window.TOP3_SEED.map(row=>[+row[0],row]));
    for(const row of out) map.set(+row[0],row);
    window.TOP3_SEED=[...map.values()].sort((a,b)=>+b[0]-+a[0]);
  }
  window.TOP3_FULL_ARCHIVE_META=Object.freeze({
    realCount:19960, searchOnlyCount:247976, totalCount:267936,
    realFirstId:247987, realLastId:267946, searchNewestId:247986, searchOldestId:11,
    searchBoundary:'28.06.23 21:25', searchOldestAssigned:'06.05.09 17:55'
  });
})();

(function installTop3SearchOnlyArchive(){
  let loadPromise=null;
  function loadTop3SearchArchive(){
    if(window.TOP3_SEARCH_ARCHIVE) return Promise.resolve(window.TOP3_SEARCH_ARCHIVE);
    if(loadPromise) return loadPromise;
    const loadScript=src=>new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=src; script.async=true;
      script.onload=resolve; script.onerror=()=>reject(new Error(`Не удалось загрузить ${src}`));
      document.head.appendChild(script);
    });
    loadPromise=loadScript('./top3-search-pack-1.js?v=267946')
      .then(()=>loadScript('./top3-search-pack-2.js?v=267946'))
      .then(()=>window.TOP3_SEARCH_ARCHIVE);
    return loadPromise;
  }
  window.loadTop3SearchArchive=loadTop3SearchArchive;

  document.addEventListener('DOMContentLoaded',()=>{
    if(typeof renderDigitSearch!=='function' || typeof renderChainSearch!=='function') return;
    const originalDigitSearch=renderDigitSearch;
    const originalChainSearch=renderChainSearch;
    const context=(draw,className='')=>draw
      ? `<span class="context-node ${className}"><b>${drawCode(draw)}</b><small>№${draw.id}</small></span>`
      : '<span class="context-node"><b>—</b><small>нет тиража</small></span>';

    renderDigitSearch=async function(){
      const query=readDigitQuery();
      if(!query || $('analysisRange')?.value!=='all') return originalDigitSearch();
      let archive;
      try { archive=await loadTop3SearchArchive(); }
      catch(error) { console.warn(error); return originalDigitSearch(); }
      const realMatches=draws.filter(draw=>matchesDigitQuery(draw,query));
      let searchCount=0;
      const searchMatches=[];
      const needed=Math.max(0,50-realMatches.length);
      archive.forEachMatch(query,(index,row)=>{
        searchCount+=1;
        if(searchMatches.length<needed) searchMatches.push({index,row});
      });
      const total=realMatches.length+searchCount;
      $('digitSearchSummary').innerHTML=`Запрос: <strong>${query.digits.join('–')}</strong>. Найдено <strong>${total.toLocaleString('ru-RU')}</strong> совпадений среди ${(draws.length+archive.count).toLocaleString('ru-RU')} комбинаций полного архива. Из них ${searchCount.toLocaleString('ru-RU')} — ранний поисковый блок.`;
      const indexById=new Map(draws.map((draw,index)=>[draw.id,index]));
      let html=realMatches.slice(0,50).map(draw=>{
        const index=indexById.get(draw.id), previous=draws[index+1]||null, next=draws[index-1]||null;
        return `<article class="search-result-row"><div class="search-result-head"><strong>№ ${draw.id} · ${drawCode(draw)}</strong><span>${draw.date} · ${draw.time}</span></div><div class="context-chain">${context(previous)}<span class="context-arrow">→</span>${context(draw,'match')}<span class="context-arrow">→</span>${context(next)}</div></article>`;
      }).join('');
      const boundary=draws.find(draw=>+draw.id===247987)||draws.at(-1)||null;
      html+=searchMatches.map(({index,row})=>{
        const previous=index+1<archive.count?archive.rowAt(index+1):null;
        const next=index?archive.rowAt(index-1):boundary;
        return `<article class="search-result-row search-only-row"><div class="search-result-head"><strong>№ ${row.id} · ${drawCode(row)}</strong><span>${row.date} · ${row.time} · поисковая привязка</span></div><div class="context-chain">${context(previous)}<span class="context-arrow">→</span>${context(row,'match')}<span class="context-arrow">→</span>${context(next)}</div></article>`;
      }).join('');
      $('digitSearchResults').innerHTML=html||'<div class="empty-result">Совпадений во всём архиве нет.</div>';
    };

    function combinedValue(id,position,archive,map){
      const draw=map.get(id);
      if(draw) return position===3?drawCode(draw):[draw.a,draw.b,draw.c][position];
      if(id>=archive.oldestId && id<=archive.newestId){
        const code=archive.codeById(id);
        return position===3?code:+code[position];
      }
      return null;
    }
    function combinedRow(id,archive,map){
      return map.get(id)||(id>=archive.oldestId&&id<=archive.newestId?archive.rowById(id):null);
    }
    function findFullContinuations(length,position,archive,map){
      const latest=[...draws].sort((a,b)=>a.id-b.id).slice(-length);
      const sequence=latest.map(draw=>position===3?drawCode(draw):[draw.a,draw.b,draw.c][position]);
      const counts=new Map(), occurrences=[];
      let total=0;
      const maxId=Math.max(...map.keys());
      for(let start=archive.oldestId;start<=maxId-length;start++){
        let matched=true;
        for(let offset=0;offset<length;offset++){
          if(combinedValue(start+offset,position,archive,map)!==sequence[offset]){ matched=false; break; }
        }
        if(!matched) continue;
        const value=combinedValue(start+length,position,archive,map);
        if(value==null) continue;
        total+=1;
        counts.set(String(value),(counts.get(String(value))||0)+1);
        occurrences.push({start:combinedRow(start,archive,map),end:combinedRow(start+length-1,archive,map),next:combinedRow(start+length,archive,map),value});
        if(occurrences.length>8) occurrences.shift();
      }
      occurrences.reverse();
      return {sequence,counts,total,occurrences};
    }

    renderChainSearch=async function(){
      const length=Math.min(3,Math.max(1,+$('chainLength').value||1));
      let archive;
      try { archive=await loadTop3SearchArchive(); }
      catch(error) { console.warn(error); return originalChainSearch(); }
      const map=new Map(draws.map(draw=>[+draw.id,draw]));
      const configs=[['1-я позиция',0],['2-я позиция',1],['3-я позиция',2],['Полная тройка',3,true]];
      const results=configs.map(([title,position,full])=>({title,full,result:findFullContinuations(length,position,archive,map)}));
      const total=results.reduce((sum,item)=>sum+item.result.total,0);
      $('chainSearchSummary').innerHTML=`Проверен полный архив ${(draws.length+archive.count).toLocaleString('ru-RU')} комбинаций. Исторических продолжений: <strong>${total.toLocaleString('ru-RU')}</strong>. Ранний блок участвует только в поиске.`;
      $('chainSearchResults').innerHTML=results.map(({title,result,full})=>`<article class="chain-result-card"><div class="chain-result-head"><h4>${title}</h4><span>${result.total} совпадений<br>с продолжением</span></div><div class="chain-seed">${result.sequence.join(' → ')}</div>${continuationRows(result,full?6:10)}${chainExamples(result)}</article>`).join('');
    };
  });
})();
