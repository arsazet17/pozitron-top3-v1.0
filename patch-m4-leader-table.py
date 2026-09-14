from pathlib import Path
import re

p = Path('triple-methods.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const VERSION='[^']+';", "const VERSION='1.2.6';", s, count=1)

marker = "const SEED_ID=267958;"
if 'M4_LEADER_SNAPSHOT' not in s:
    insert = """const M4_LEADER_SNAPSHOT={totalLinks:41,rows:[
 {place:1,triple:'888',links:6,share:'14.6%',sources:6,receivers:6,avgLag:'15.67',maxLag:30},
 {place:2,triple:'111',links:5,share:'12.2%',sources:4,receivers:5,avgLag:'10.20',maxLag:32},
 {place:2,triple:'444',links:5,share:'12.2%',sources:5,receivers:5,avgLag:'11.40',maxLag:29},
 {place:2,triple:'777',links:5,share:'12.2%',sources:5,receivers:5,avgLag:'14.20',maxLag:21},
 {place:2,triple:'999',links:5,share:'12.2%',sources:5,receivers:5,avgLag:'9.60',maxLag:15},
 {place:3,triple:'222',links:4,share:'9.8%',sources:4,receivers:4,avgLag:'10.50',maxLag:20},
 {place:3,triple:'666',links:4,share:'9.8%',sources:4,receivers:4,avgLag:'15.75',maxLag:20},
 {place:4,triple:'000',links:3,share:'7.3%',sources:3,receivers:3,avgLag:'15.67',maxLag:28},
 {place:4,triple:'333',links:3,share:'7.3%',sources:3,receivers:3,avgLag:'15.33',maxLag:23},
 {place:5,triple:'555',links:1,share:'2.4%',sources:1,receivers:1,avgLag:'4.00',maxLag:4}
]};
"""
    if marker not in s:
        raise SystemExit('SEED marker not found')
    s = s.replace(marker, marker + '\n' + insert, 1)

old_html = '<div class="tm-archive-head"><div><h4>🏆 Таблица лидеров от тройни</h4><p>Все 10 троек · новые рождения за последние 20 тиражей · сортировка по убыванию.</p></div></div><div class="tm-table-wrap"><table class="tm-table tm-leader-table"><thead><tr><th>Место</th><th>Тройня</th><th>Новых появлений</th><th>Статус</th></tr></thead><tbody id="tmLeaderTableBody"></tbody></table></div>'
new_html = '<div class="tm-archive-head"><div><h4>🏆 Лидеры от тройни · ВСЕ СЕМЕЙНЫЕ СВЯЗИ</h4><p>Текущий M4-цикл · считаются все семейные связи, а не рождения за последние 20 тиражей. Всего связей: <b id="tmM4TotalLinks">41</b>.</p></div></div><div class="tm-table-wrap"><table class="tm-table tm-leader-table"><thead><tr><th>Место</th><th>Тройня</th><th>Все связи</th><th>Доля</th><th>Источников</th><th>Фактов-получателей</th><th>Средний лаг</th><th>Макс. лаг</th></tr></thead><tbody id="tmLeaderTableBody"></tbody></table></div>'
if old_html in s:
    s = s.replace(old_html, new_html, 1)
elif 'Лидеры от тройни · ВСЕ СЕМЕЙНЫЕ СВЯЗИ' not in s:
    raise SystemExit('leader html marker not found')

pattern = re.compile(r"const rankBody=document\.getElementById\('tmLeaderTableBody'\);if\(rankBody\)\{.*?\}const tb=document\.getElementById\('tmArchive'\);", re.S)
replacement = "const rankBody=document.getElementById('tmLeaderTableBody');if(rankBody){setText('tmM4TotalLinks',String(M4_LEADER_SNAPSHOT.totalLinks));rankBody.innerHTML=M4_LEADER_SNAPSHOT.rows.map(r=>`<tr><td><b>${r.place}</b></td><td class=\"tm-fact\">${r.triple}</td><td><b>${r.links}</b></td><td>${r.share}</td><td>${r.sources}</td><td>${r.receivers}</td><td>${r.avgLag}</td><td>${r.maxLag}</td></tr>`).join('');}const tb=document.getElementById('tmArchive');"
s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f'render marker replacements={n}')
p.write_text(s, encoding='utf-8')

p = Path('app.js')
s = p.read_text(encoding='utf-8')
s = re.sub(r"const APP_VERSION='[^']+';", "const APP_VERSION='1.2.6';", s, count=1)
p.write_text(s, encoding='utf-8')

p = Path('index.html')
s = p.read_text(encoding='utf-8').replace('1.2.5', '1.2.6')
p.write_text(s, encoding='utf-8')

p = Path('sw.js')
s = p.read_text(encoding='utf-8').replace('yulia-top3-v1-2-5-triple-leader-table', 'yulia-top3-v1-2-6-m4-family-links').replace('1.2.5', '1.2.6')
p.write_text(s, encoding='utf-8')

p = Path('manifest.webmanifest')
s = p.read_text(encoding='utf-8').replace('1.2.5-triple-leader-table', '1.2.6-m4-family-links')
p.write_text(s, encoding='utf-8')
