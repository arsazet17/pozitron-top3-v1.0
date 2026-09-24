from pathlib import Path

p = Path('update-top3-api.mjs')
s = p.read_text(encoding='utf-8')
old = """const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
  referer: 'https://m.stoloto.ru/',
  'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36'
};"""
new = """const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
  referer: 'https://www.stoloto.ru/',
  'content-type': 'application/x-www-form-urlencoded',
  'device-type': 'STOLOTO',
  'device-platform': 'DESKTOP',
  'gosloto-partner': 'bXMjXFRXZ3coWXh6R3s1NTdUX3dnWlBMLUxmdg',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
};"""
if new in s:
    print('Headers already current')
elif old in s:
    p.write_text(s.replace(old, new, 1), encoding='utf-8')
    print('Patched current Stoloto headers')
else:
    raise SystemExit('HEADERS block did not match expected source')
