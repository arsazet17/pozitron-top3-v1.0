import fs from 'node:fs/promises';

const APP = new URL('./app.js', import.meta.url);
const INDEX = new URL('./index.html', import.meta.url);
const SW = new URL('./sw.js', import.meta.url);

async function replaceInFile(file, replacements) {
  let text = await fs.readFile(file, 'utf8');
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`Не найден фрагмент для замены: ${from}`);
    text = text.split(from).join(to);
  }
  await fs.writeFile(file, text, 'utf8');
}

await replaceInFile(APP, [
  ["const APP_VERSION='1.2.0';", "const APP_VERSION='1.2.1';"],
  ["const LIVE_DATA_URL = './top3-history.json';", "const LIVE_DATA_URL = 'https://raw.githubusercontent.com/arsazet17/pozitron-top3-v1.0/main/top3-history.json';"]
]);

await replaceInFile(INDEX, [
  ['v1.2.0', 'v1.2.1'],
  ["window.TOP3_BUILD = '1.2.0';", "window.TOP3_BUILD = '1.2.1';"]
]);

await replaceInFile(SW, [
  ["const CACHE_NAME = 'yulia-top3-v1-2-0-three-methods';", "const CACHE_NAME = 'yulia-top3-v1-2-1-raw-live';"],
  ['v=1.2.0', 'v=1.2.1']
]);

console.log('TOP3 v1.2.1: live archive switched to raw.githubusercontent.com');
