from pathlib import Path
import re

p = Path('triple-methods.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const VERSION='[^']+';", "const VERSION='1.2.7';", s, count=1)

engine = r'''const M4_TRIPLES=Object.freeze(['111','222','333','444','555','666','777','888','999','000']);
function m4Family(v){return padCode(v).split('').sort().join('');}
function m4IsTriple(v){return /^([0-9])\1\1$/.test(String(v||''));}
function m4ComplementCode(source,triple){const target=Number(triple[0]),src=padCode(source);return src.split('').map(x=>String((target-Number(x)+10)%10)).join('');}
function computeM4AllLinks(records=[]){
 const real=(records||[]).map(r=>{const raw=(r?.code!=null?r.code:((r?.a!=null&&r?.b!=null&&r?.c!=null)?`${r.a}${r.b}${r.c}`:''));return{id:Number(r?.id),date:String(r?.date||''),time:String(r?.time||''),code:padCode(raw)};}).filter(r=>Number.isInteger(r.id)&&/^\d{3}$/.test(r.code)).sort((a,b)=>a.id-b.id);
 let anchorIndex=-1;for(let i=real.length-1;i>=0;i--)if(m4IsTriple(real[i].code)){anchorIndex=i;break;}
 const anchor=anchorIndex>=0?real[anchorIndex]:null,cycleRows=anchorIndex>=0?real.slice(anchorIndex+1):[];
 const sourceFamilies=Object.fromEntries(M4_TRIPLES.map(t=>[t,new Map()])),links=[];
 cycleRows.forEach((row,rowIndex)=>{
  const ff=m4Family(row.code);
  for(const t of M4_TRIPLES){const matches=sourceFamilies[t].get(ff)||[];for(const src of matches)links.push({triple:t,sourceId:src.id,recipientId:row.id,lag:rowIndex-src.index});}
  for(const t of M4_TRIPLES){const addedFamily=m4Family(m4ComplementCode(row.code,t)),m=sourceFamilies[t];if(!m.has(addedFamily))m.set(addedFamily,[]);m.get(addedFamily).push({id:row.id,index:rowIndex});}
 });
 const total=links.length;
 const stats=M4_TRIPLES.map((triple,order)=>{const own=links.filter(x=>x.triple===triple),count=own.length,sourceCount=new Set(own.map(x=>x.sourceId)).size,recipientCount=new Set(own.map(x=>x.recipientId)).size,avgLag=count?own.reduce((a,b)=>a+b.lag,0)/count:null,maxLag=count?Math.max(...own.map(x=>x.lag)):null;return{triple,order,count,share:total?count*100/total:0,sourceCount,recipientCount,avgLag,maxLag};});
 const sorted=[...stats].sort((a,b)=>b.count-a.count||a.order-b.order);let lastCount=null,rank=0;const ranking=sorted.map(x=>{if(x.count!==lastCount){rank++;lastCount=x.count;}return{...x,rank};});
 return{anchor,start:cycleRows[0]||null,last:cycleRows.at(-1)||anchor||null,cycleRows:cycleRows.length,total,ranking};
}'''

if 'const M4_LEADER_SNAPSHOT=' in s:
    s, n = re.subn(r"const M4_LEADER_SNAPSHOT=\{.*?\n\]};", lambda m: engine, s, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f'M4 static block replacements={n}')
elif 'function computeM4AllLinks(' not in s:
    marker = "const SEED_ID=267958;"
    if marker not in s:
        raise SystemExit('SEED marker not found')
    s = s.replace(marker, marker+'\n'+engine, 1)

s = s.replace('<p>Текущий M4-цикл · считаются все семейные связи, а не рождения за последние 20 тиражей. Всего связей: <b id="tmM4TotalLinks">41</b>.</p>', '<p id="tmM4Summary">Расчёт текущего M4-цикла…</p>')

pattern = re.compile(r"const rankBody=document\.getElementById\('tmLeaderTableBody'\);if\(rankBody\)\{.*?\}const tb=document\.getElementById\('tmArchive'\);", re.S)
replacement = "const rankBody=document.getElementById('tmLeaderTableBody');if(rankBody){const m4=computeM4AllLinks(sourceDraws());const anchor=m4.anchor,start=m4.start;setText('tmM4Summary',anchor?`Опорная тройня: ${anchor.code} · ${displayDate(anchor.date)} ${anchor.time} · старт цикла: ${start?`${displayDate(start.date)} ${start.time}`:'—'} · тиражей в текущем цикле: ${m4.cycleRows} · всего связей: ${m4.total}`:'Опорная тройня не найдена');rankBody.innerHTML=m4.ranking.map(r=>`<tr><td><b>${r.rank}</b></td><td class=\"tm-fact\">${r.triple}</td><td><b>${r.count}</b></td><td>${r.share.toFixed(1)}%</td><td>${r.sourceCount}</td><td>${r.recipientCount}</td><td>${r.avgLag==null?'—':r.avgLag.toFixed(2)}</td><td>${r.maxLag==null?'—':r.maxLag}</td></tr>`).join('');}const tb=document.getElementById('tmArchive');"
s, n = pattern.subn(lambda m: replacement, s, count=1)
if n != 1:
    raise SystemExit(f'render marker replacements={n}')
p.write_text(s, encoding='utf-8')

p = Path('app.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const APP_VERSION='[^']+';", "const APP_VERSION='1.2.7';", s, count=1)
p.write_text(s, encoding='utf-8')

p = Path('index.html')
s = p.read_text(encoding='utf-8').replace('1.2.6', '1.2.7')
p.write_text(s, encoding='utf-8')

p = Path('sw.js')
s = p.read_text(encoding='utf-8').replace('yulia-top3-v1-2-6-m4-family-links', 'yulia-top3-v1-2-7-m4-live-cycle').replace('1.2.6', '1.2.7')
p.write_text(s, encoding='utf-8')

p = Path('manifest.webmanifest')
s = p.read_text(encoding='utf-8').replace('1.2.6-m4-family-links', '1.2.7-m4-live-cycle').replace('1.2.6', '1.2.7')
p.write_text(s, encoding='utf-8')
