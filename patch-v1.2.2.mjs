import fs from 'node:fs/promises';

async function read(path) {
  return fs.readFile(path, 'utf8');
}

async function write(path, text) {
  await fs.writeFile(path, text, 'utf8');
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Не найден шаблон: ${label}`);
  return text.replace(from, to);
}

let app = await read('app.js');
app = mustReplace(app, "const APP_VERSION='1.2.1';", "const APP_VERSION='1.2.2';", 'APP_VERSION');
await write('app.js', app);

let index = await read('index.html');
index = index.replaceAll('1.2.1', '1.2.2');
if (!index.includes('live-source-fix.js')) {
  index = mustReplace(
    index,
    '  <script src="app.js?v=1.2.2"></script>\n',
    '  <script src="app.js?v=1.2.2"></script>\n  <script src="live-source-fix.js?v=1.2.2"></script>\n',
    'index live-source hook'
  );
}
await write('index.html', index);

let sw = await read('sw.js');
sw = sw.replace("const CACHE_NAME = 'yulia-top3-v1-2-1-raw-live';", "const CACHE_NAME = 'yulia-top3-v1-2-2-direct-api';");
sw = sw.replaceAll('v=1.2.1', 'v=1.2.2');
if (!sw.includes("'./live-source-fix.js?v=1.2.2'")) {
  sw = mustReplace(
    sw,
    "'./index.html', './repair.html', './styles.css?v=1.2.2', './top3-storage-indexeddb.js?v=1.0.1', './app.js?v=1.2.2',",
    "'./index.html', './repair.html', './styles.css?v=1.2.2', './top3-storage-indexeddb.js?v=1.0.1', './app.js?v=1.2.2', './live-source-fix.js?v=1.2.2',",
    'service-worker asset hook'
  );
}
await write('sw.js', sw);

const manifest = JSON.parse(await read('manifest.webmanifest'));
manifest.start_url = './?v=1.2.2-direct-api';
await write('manifest.webmanifest', JSON.stringify(manifest, null, 2) + '\n');

console.log('TOP3 v1.2.2 patch applied');
