import fs from 'node:fs';

const VERSION = '1.0.28';
const indexPath = 'index.html';
const manifestPath = 'manifest.webmanifest';

if (!fs.existsSync(indexPath)) {
  throw new Error('index.html не найден. Запусти установщик из корня Yulia TOP-3.');
}

let html = fs.readFileSync(indexPath, 'utf8');

function replaceFirst(regex, replacement) {
  if (regex.test(html)) html = html.replace(regex, replacement);
}

replaceFirst(/<title>Yulia TOP-3 v[\d.]+([^<]*)<\/title>/, `<title>Yulia TOP-3 v${VERSION}$1</title>`);
replaceFirst(/<link rel="stylesheet" href="styles\.css\?v=[^"]+">/, `<link rel="stylesheet" href="styles.css?v=${VERSION}">`);
replaceFirst(/window\.TOP3_BUILD\s*=\s*'[^']+';/, `window.TOP3_BUILD = '${VERSION}';`);
replaceFirst(/<span class="version">v[\d.]+<\/span>/, `<span class="version">v${VERSION}</span>`);
replaceFirst(/<script src="app\.js\?v=[^"]+"><\/script>/, `<script src="app.js?v=${VERSION}"></script>`);

const cssTag = `  <link rel="stylesheet" href="mirror-method.css?v=${VERSION}">`;
if (!html.includes('mirror-method.css')) {
  html = html.replace('</head>', `${cssTag}\n</head>`);
}

const jsTag = `  <script src="mirror-method.js?v=${VERSION}"></script>`;
if (!html.includes('mirror-method.js')) {
  const appTagPattern = /(\s*<script src="app\.js\?v=[^"]+"><\/script>)/;
  if (appTagPattern.test(html)) {
    html = html.replace(appTagPattern, `$1\n${jsTag}`);
  } else {
    html = html.replace('</body>', `${jsTag}\n</body>`);
  }
}

fs.writeFileSync(indexPath, html, 'utf8');

if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.start_url = `./?v=${VERSION}`;
    manifest.description = 'TOP-3: архивы, разницы Позитронов, зеркала, ИИ и метод Юлии «Зеркало и прибавление · 15 тиражей».';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.warn('manifest.webmanifest не обновлён:', error.message);
  }
}

console.log(`Yulia TOP-3: зеркальный метод установлен, версия ${VERSION}.`);
