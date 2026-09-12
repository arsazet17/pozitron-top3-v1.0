import fs from 'node:fs/promises';

let app = await fs.readFile('app.js', 'utf8');
const needle = "  const rows = seedObjects();";
const first = app.indexOf(needle);
const second = first >= 0 ? app.indexOf(needle, first + needle.length) : -1;
if (second >= 0) {
  app = app.slice(0, second) + app.slice(second + needle.length + 1);
}
if ((app.match(/const rows = seedObjects\(\);/g) || []).length !== 1) {
  throw new Error('seedDatabase: ожидалась ровно одна строка const rows = seedObjects()');
}
if (!app.includes("$('tripleComboTable').innerHTML")) {
  throw new Error('Не найден код расширенной статистики тройных комбинаций');
}
await fs.writeFile('app.js', app, 'utf8');

let index = await fs.readFile('index.html', 'utf8');
index = index.replace('styles.css?v=1.0.29-fix1', 'styles.css?v=1.1.0');
index = index.replace('mirror-method.css?v=1.0.29-fix1', 'mirror-method.css?v=1.1.0');
index = index.replace('mirror-method.js?v=1.0.29-fix1', 'mirror-method.js?v=1.1.0');
if (!index.includes('styles.css?v=1.1.0') || !index.includes('id="tripleComboTable"')) {
  throw new Error('index.html не прошёл проверку v1.1.0');
}
await fs.writeFile('index.html', index, 'utf8');

let sw = await fs.readFile('sw.js', 'utf8');
sw = sw.replace(/styles\.css\?v=[^']+/g, 'styles.css?v=1.1.0');
sw = sw.replace(/mirror-method\.css\?v=[^']+/g, 'mirror-method.css?v=1.1.0');
sw = sw.replace(/mirror-method\.js\?v=[^']+/g, 'mirror-method.js?v=1.1.0');
await fs.writeFile('sw.js', sw, 'utf8');

console.log('v1.1.0 hotfix applied');
