// v1.2.15 — безопасное восстановление пропущенного участка TOP-3.
// Обычные проверки используют компактный top3-live.json.
// Полная история загружается лишь при недостаточном пересечении с локальной базой.
(() => {
  'use strict';

  if (typeof fetchLuckyDraws !== 'function') {
    console.error('TOP-3 backfill: загрузчик тиражей не найден');
    return;
  }

  const originalFetch = fetchLuckyDraws;
  const HISTORY_URL = 'https://raw.githubusercontent.com/arsazet17/pozitron-top3-v1.0/main/top3-history.json';

  function equalDraw(a, b) {
    return !!a && !!b
      && Number(a.id) === Number(b.id)
      && String(a.date) === String(b.date)
      && String(a.time) === String(b.time)
      && Number(a.a) === Number(b.a)
      && Number(a.b) === Number(b.b)
      && Number(a.c) === Number(b.c);
  }

  function timestamp(row) {
    const [day, month, year] = String(row.date).split('.').map(Number);
    const [hour, minute] = String(row.time).split(':').map(Number);
    return Date.UTC(2000 + year, month - 1, day, hour, minute);
  }

  async function readFullHistory() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      // Большой файл GitHub нельзя читать через Contents API: свыше 1 МБ
      // API может вернуть пустое поле content. Используем прямой raw URL.
      const response = await fetch(HISTORY_URL + '?_=' + Date.now(), {
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      if (payload?.fullArchive !== true || !Array.isArray(payload.draws) || payload.draws.length < 3) {
        throw new Error('файл полной истории повреждён или неполный');
      }
      return payload;
    } catch (error) {
      throw new Error('не удалось получить полную историю TOP-3: ' + (error?.message || error));
    } finally {
      clearTimeout(timeout);
    }
  }

  fetchLuckyDraws = async function fetchLuckyDrawsWithBackfill() {
    const live = await originalFetch();
    if (!Array.isArray(live?.items) || !Array.isArray(draws) || draws.length < 3) return live;

    const localById = new Map(draws.map(row => [Number(row.id), row]));
    const recentOverlap = live.items.filter(row => localById.has(Number(row.id)));
    if (recentOverlap.length >= 3) return live;

    const boundary = draws.slice(0, 3);
    const localLatest = Number(boundary[0].id);
    if (boundary.some((row, index) => Number(row.id) !== localLatest - index)) {
      throw new Error('перед восстановлением нужна проверка последних трёх локальных тиражей');
    }

    const history = await readFullHistory();
    const historyById = new Map(history.draws.map(row => [Number(row.id), row]));
    const liveById = new Map(live.items.map(row => [Number(row.id), row]));

    if (historyById.size !== history.draws.length || liveById.size !== live.items.length) {
      throw new Error('дубли номеров в файлах обновлений');
    }

    // Три контрольных факта подтверждают присоединение к личной базе.
    for (const row of boundary) {
      if (!equalDraw(row, historyById.get(Number(row.id)))) {
        throw new Error('контрольный тираж №' + row.id + ' не совпал с полной историей');
      }
    }

    // Сверяем новый полный архив с актуальным коротким потоком.
    const shared = live.items
      .filter(row => historyById.has(Number(row.id)))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 20);
    if (shared.length < 3 || shared.some(row => !equalDraw(row, historyById.get(Number(row.id))))) {
      throw new Error('контрольная сверка полного архива со свежими тиражами не пройдена');
    }

    const newest = Math.max(...live.items.map(row => Number(row.id)), Number(history.draws[0].id));
    const bridge = [];
    let previousTime = -Infinity;

    // Запрещаем молчаливые пропуски, дубли, неверные цифры и нарушения хронологии.
    for (let id = localLatest - 2; id <= newest; id += 1) {
      const historical = historyById.get(id);
      const current = liveById.get(id);
      if (historical && current && !equalDraw(historical, current)) {
        throw new Error('источники расходятся на тираже №' + id);
      }
      const row = current || historical;
      if (!row || !isValidDraw(row) || !DRAW_TIMES.includes(row.time)) {
        throw new Error('в восстановлении отсутствует проверенный тираж №' + id);
      }
      const time = timestamp(row);
      if (!Number.isFinite(time) || time <= previousTime) {
        throw new Error('нарушена хронология тиража №' + id);
      }
      previousTime = time;
      bridge.push(row);
    }

    console.info('TOP-3: подтверждённое восстановление', {
      from: localLatest, to: newest, newDraws: newest - localLatest
    });

    // Специальное имя источника не включает разрешение на автоперезапись
    // старых фактов. Новые номера только добавляются в IndexedDB.
    return {
      ...live,
      items: bridge.reverse(),
      source: 'GitHub TOP-3 · проверенная полная история + свежие тиражи',
      generatedAt: history.updatedAt || live.generatedAt
    };
  };
})();
