from pathlib import Path
import re

TARGET_VERSION = '1.2.8'

p = Path('triple-methods.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const VERSION='[^']+';", f"const VERSION='{TARGET_VERSION}';", s, count=1)

# Separate MAYACHOK forecast.  It intentionally does not merge into the old M1/M2/M3 FROZEN.
# Rule: exact digit order only; chronological 50-draw window; deterministic NO-REUSE pairing:
# earliest free source -> first later free exact second -> lock both rows.
if 'MAYACHOK_WATCH_V2' not in s:
    marker = "const M2_MAP={"
    block = r'''// MAYACHOK · separate forecast · exact collapses / NO-REUSE V2.
// Frozen watch matrix from the V2 archive re-check. This signal is independent of M1/M2/M3.
const MAYACHOK_WATCH_V2=Object.freeze([
 ['111',19],['666',2],['222',17],['999',20],['555',4],['888',4],['888',20],
 ['777',13],['222',16],['777',7],['999',14],['999',4],['555',6]
]);
const MAYACHOK_WATCH_SET=new Set(MAYACHOK_WATCH_V2.map(([t,d])=>`${t}@${d}`));
function computeMayachokV2(records=[]){
 const real=(records||[]).map(r=>{const raw=(r?.code!=null?r.code:((r?.a!=null&&r?.b!=null&&r?.c!=null)?`${r.a}${r.b}${r.c}`:''));return{id:Number(r?.id),date:String(r?.date||''),time:String(r?.time||''),code:padCode(raw)};}).filter(r=>Number.isInteger(r.id)&&/^\d{3}$/.test(r.code)).sort((a,b)=>a.id-b.id);
 const window=real.slice(-50),used=new Set(),pairs=[];
 for(let i=0;i<window.length;i++){
  if(used.has(i))continue;
  for(let j=i+1;j<window.length;j++){
   if(used.has(j))continue;
   const exact=add(window[i].code,window[j].code);
   if(!isTriple(exact))continue;
   used.add(i);used.add(j);
   const distance=window.length-j;
   pairs.push({triple:exact,distance,source:window[i],second:window[j]});
   break;
  }
 }
 const active=pairs.filter(x=>x.distance>=1&&x.distance<=20).sort((a,b)=>a.distance-b.distance||tripleSort(a.triple,b.triple));
 const matches=active.filter(x=>MAYACHOK_WATCH_SET.has(`${x.triple}@${x.distance}`));
 return{signal:matches.length>0,matches,active,pairs,windowSize:window.length};
}

'''
    if marker not in s:
        raise SystemExit('MAYACHOK insert marker not found')
    s = s.replace(marker, block + marker, 1)

# Put MAYACHOK as its own forecast card immediately before M1/M2/M3.
if 'id="tmMayachok"' not in s:
    marker = '<div class="tm-method-grid"><article class="tm-method"><header><b>M1</b>'
    card = '<div class="tm-leader tm-mayachok"><div><span>🚨 МАЯЧОК · ОТДЕЛЬНЫЙ ПРОГНОЗ</span><strong id="tmMayachok">—</strong></div><div id="tmMayachokMeta" class="tm-sub">—</div><small>Точный порядок цифр · NO-REUSE V2 · окно 50 завершённых тиражей. МАЯЧОК отвечает только «ТРОЙНЯ / НЕТ СИГНАЛА» и не смешивается с FROZEN M1/M2/M3.</small></div>'
    if marker not in s:
        raise SystemExit('MAYACHOK UI marker not found')
    s = s.replace(marker, card + marker, 1)

if "const beacon=computeMayachokV2(sourceDraws());" not in s:
    marker = "setText('tmM1',fmtList(s.m1));"
    render = "const beacon=computeMayachokV2(sourceDraws());setText('tmMayachok',beacon.signal?'🚨 СИГНАЛ: ТРОЙНЯ':'— НЕТ СИГНАЛА');const beaconMeta=beacon.matches.length?`Совпали: ${beacon.matches.map(x=>`${x.triple} · дистанция ${x.distance} · ${x.source.code}+${x.second.code}=${x.triple}`).join(' · ')}`:(beacon.active.length?`Активные разрешённые NO-REUSE схлопывания: ${beacon.active.map(x=>`${x.triple}@${x.distance}`).join(' · ')} · совпадений с frozen-матрицей МАЯЧКА нет`:'В дистанциях 1–20 разрешённых NO-REUSE схлопываний нет');setText('tmMayachokMeta',beaconMeta);const beaconEl=document.getElementById('tmMayachok');if(beaconEl)beaconEl.className=beacon.signal?'hit':'neutral';"
    if marker not in s:
        raise SystemExit('MAYACHOK render marker not found')
    s = s.replace(marker, render + marker, 1)

p.write_text(s, encoding='utf-8')

p = Path('app.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const APP_VERSION='[^']+';", f"const APP_VERSION='{TARGET_VERSION}';", s, count=1)
p.write_text(s, encoding='utf-8')

p = Path('index.html')
s = p.read_text(encoding='utf-8')
s = re.sub(r'1\.2\.\d+', TARGET_VERSION, s)
p.write_text(s, encoding='utf-8')

p = Path('sw.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const CACHE_NAME = 'yulia-top3-[^']+';", "const CACHE_NAME = 'yulia-top3-v1-2-8-mayachok-v2';", s, count=1)
s = re.sub(r'1\.2\.\d+', TARGET_VERSION, s)
p.write_text(s, encoding='utf-8')

p = Path('manifest.webmanifest')
s = p.read_text(encoding='utf-8')
s = re.sub(r'"start_url":\s*"[^"]+"', '"start_url": "./?v=1.2.8-mayachok-v2"', s, count=1)
p.write_text(s, encoding='utf-8')
