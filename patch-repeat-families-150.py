from pathlib import Path
import re

VER='1.2.13'
p=Path('triple-methods.js')
s=p.read_text(encoding='utf-8')
s=re.sub(r"const VERSION='[^']+';",f"const VERSION='{VER}';",s,count=1)

if 'function computeRepeatFamilies150' not in s:
    marker='function nextSlot(last)'
    add="""function computeRepeatFamilies150(records=[]){
 const window=(records||[]).slice(-150),byFamily=new Map();
 window.forEach((r,i)=>{const family=sig(r.code);if(!byFamily.has(family))byFamily.set(family,[]);byFamily.get(family).push({pos:i+1,id:r.id,code:r.code,date:r.date,time:r.time});});
 const rows=[...byFamily.entries()].filter(([,hits])=>hits.length>=2).map(([family,hits])=>({family,count:hits.length,hits})).sort((a,b)=>b.count-a.count||a.family.localeCompare(b.family));
 return{windowSize:window.length,rows};
}
"""
    if marker not in s: raise SystemExit('nextSlot marker not found')
    s=s.replace(marker,add+marker,1)

if 'tmRepeatFamilies150Body' not in s:
    marker='<div class="tm-archive-head"><div><h4>🏆 Лидеры от тройни · ВСЕ СЕМЕЙНЫЕ СВЯЗИ</h4>'
    block='<div class="tm-archive-head"><div><h4>🔁 Повторные семьи · последние 150 тиражей</h4><p id="tmRepeatFamilies150Summary">Только family, встретившиеся минимум 2 раза. Позиция 1 — самый старый тираж окна, позиция 150 — самый новый.</p></div></div><div class="tm-table-wrap"><table class="tm-table"><thead><tr><th>Family</th><th>Количество</th><th>Позиции в окне 150</th><th>Тиражи / комбинации</th></tr></thead><tbody id="tmRepeatFamilies150Body"></tbody></table></div>'
    if marker not in s: raise SystemExit('M4 heading marker not found')
    s=s.replace(marker,block+marker,1)

if "const repeat150=computeRepeatFamilies150" not in s:
    marker="const rankBody=document.getElementById('tmLeaderTableBody');"
    code="""const repeat150=computeRepeatFamilies150(chronological());const repeatBody=document.getElementById('tmRepeatFamilies150Body');setText('tmRepeatFamilies150Summary',`Окно: ${repeat150.windowSize}/150 последних фактических тиражей · только повторные family (2+). Позиция 1 = самый старый в окне, ${repeat150.windowSize||0} = самый новый.`);if(repeatBody){repeatBody.innerHTML=repeat150.rows.length?repeat150.rows.map(r=>`<tr><td><b>family${esc(r.family)}</b></td><td><b>${r.count}</b></td><td>${r.hits.map(x=>x.pos).join(' · ')}</td><td>${r.hits.map(x=>`№${x.id}=${esc(x.code)}`).join(' · ')}</td></tr>`).join(''):'<tr><td colspan="4">В последних 150 тиражах повторных family пока нет.</td></tr>';}
"""
    if marker not in s: raise SystemExit('rankBody marker not found')
    s=s.replace(marker,code+marker,1)

p.write_text(s,encoding='utf-8')

p=Path('app.js'); s=p.read_text(encoding='utf-8'); s=re.sub(r"const APP_VERSION='[^']+';",f"const APP_VERSION='{VER}';",s,count=1); p.write_text(s,encoding='utf-8')
for name in ['index.html','sw.js','manifest.webmanifest']:
    p=Path(name); s=p.read_text(encoding='utf-8'); s=s.replace('1.2.12',VER).replace('1-2-12','1-2-13'); p.write_text(s,encoding='utf-8')
