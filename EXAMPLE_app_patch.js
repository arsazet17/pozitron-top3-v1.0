// ПРИМЕР ПАТЧА ДЛЯ TOP-3
// Используйте только после подключения top3-storage-indexeddb.js

// СОХРАНЕНИЕ:
async function saveTop3State(state) {
  await Top3Storage.saveState(state);
}

// ЗАГРУЗКА:
async function loadTop3State() {
  return await Top3Storage.loadState();
}

// ПРИМЕР СТАРТА:
async function initApp() {
  const state = await loadTop3State();

  if (state) {
    // восстановить состояние приложения
    // applyState(state);
  }

  // дальше обычный запуск приложения
}

// initApp();
