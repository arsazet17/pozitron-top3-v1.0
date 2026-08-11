import fs from 'node:fs/promises';

const FILES = [
  new URL('./index.html', import.meta.url),
  new URL('./app.js', import.meta.url)
];

let changed = 0;

for (const file of FILES) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    console.warn(`Пропуск ${file.pathname}: ${error.message}`);
    continue;
  }

  const before = text;

  // Меняем только пользовательские надписи. URL и внутренняя база не трогаются.
  text = text.replace(/Lucky Numbers/g, 'Столото');

  if (text !== before) {
    await fs.writeFile(file, text, 'utf8');
    changed += 1;
    console.log(`Исправлено отображение источника: ${file.pathname}`);
  }
}

console.log(changed
  ? `ГОТОВО: изменено файлов интерфейса: ${changed}`
  : 'Интерфейс уже показывает Столото — изменений нет.');
