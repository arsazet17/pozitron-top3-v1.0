(() => {
  'use strict';

  const MIRROR_METHOD_VERSION = '1.0.28';
  const SETTINGS_KEY = 'yulia-top3-mirror-method-settings-v1';
  const NOTIFY_KEY = 'yulia-top3-mirror-method-last-notify-v1';

  const DEFAULTS = {
    enabled: true,
    permutations: 'all',
    window: 15,
    tripleSignal: true,
    notifications: true,
    frequencyAccent: true,
    absenceAccent: true,
    scan: 30,
    showAllBases: false,
    showHistory: false
  };

  let settings = loadSettings();
  let lastSeenDrawId = null;
  let intervalId = null;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { ...DEFAULTS, ...saved, scan: 30 };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }

  function sourceDraws() {
    try {
      return Array.isArray(draws) ? draws : [];
    } catch {
      return [];
    }
  }

  function m10(n) {
    return ((Number(n) % 10) + 10) % 10;
  }

  function digits(draw) {
    return [Number(draw.a), Number(draw.b), Number(draw.c)];
  }

  function code(values) {
    return values.map(m10).join('');
  }

  function drawCodeLocal(draw) {
    return draw ? `${draw.a}${draw.b}${draw.c}` : '—';
  }

  function mirrorDigitLocal(value) {
    return m10(10 - Number(value));
  }

  function mirror(values) {
    return values.map(mirrorDigitLocal);
  }

  function signature(values) {
    return [...values].map(Number).sort((a,b) => a-b).join('');
  }

  function uniquePermutations(values) {
    const arr = [...values];
    const result = new Set();
    const permute = (start) => {
      if (start >= arr.length - 1) {
        result.add(arr.join(''));
        return;
      }
      const used = new Set();
      for (let i = start; i < arr.length; i++) {
        if (used.has(arr[i])) continue;
        used.add(arr[i]);
        [arr[start], arr[i]] = [arr[i], arr[start]];
        permute(start + 1);
        [arr[start], arr[i]] = [arr[i], arr[start]];
      }
    };
    permute(0);
    return [...result].map(item => item.split('').map(Number));
  }

  function baseVariants(draw) {
    const base = digits(draw);
    return settings.permutations === 'exact' ? [base] : uniquePermutations(base);
  }

  function addVariantToDraw(variant, draw) {
    const current = digits(draw);
    return variant.map((value, index) => m10(value + current[index]));
  }

  function tripleFrom(values) {
    return values[0] === values[1] && values[1] === values[2] ? values[0] : null;
  }

  function parseDrawDateLocal(text) {
    const m = String(text || '').match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  }

  function daysBetween(older, newer) {
    const a = parseDrawDateLocal(older?.date);
    const b = parseDrawDateLocal(newer?.date);
    if (!a || !b) return 0;
    return Math.max(0, Math.floor((b - a) / 86400000));
  }

  function formatMirrorMapping() {
    return '0=0 · 1=9 · 2=8 · 3=7 · 4=6 · 5=5 · 6=4 · 7=3 · 8=2 · 9=1';
  }

  function previousMirrorMatch(ordered, baseIndex) {
    const base = ordered[baseIndex];
    if (!base) return null;
    const mirrored = mirror(digits(base));
    const wanted = signature(mirrored);
    for (let index = baseIndex - 1; index >= 0; index--) {
      if (signature(digits(ordered[index])) === wanted) {
        return {
          draw: ordered[index],
          index,
          mirrorCode: code(mirrored),
          matchedCode: drawCodeLocal(ordered[index])
        };
      }
    }
    return null;
  }

  function getQualifiedBases(ordered) {
    if (!ordered.length) return [];
    const start = Math.max(0, ordered.length - settings.scan);
    const latestIndex = ordered.length - 1;
    const result = [];
    for (let index = start; index < ordered.length; index++) {
      const base = ordered[index];
      const match = previousMirrorMatch(ordered, index);
      if (!match) continue;
      const age = latestIndex - index;
      const remaining = Math.max(0, settings.window - age);
      result.push({
        draw: base,
        index,
        match,
        age,
        remaining,
        active: age <= settings.window,
        readyForSum: age >= 1 && age <= settings.window
      });
    }
    return result;
  }

  function getFrequencyStats(ordered) {
    const recent = ordered.slice(-30);
    const total = Array(10).fill(0);
    const columns = [Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)];

    recent.forEach(draw => {
      digits(draw).forEach((value, pos) => {
        total[value] += 1;
        columns[pos][value] += 1;
      });
    });

    const maxTotal = Math.max(...total);
    const globalHot = total.map((n,d) => n === maxTotal ? d : null).filter(v => v !== null);

    const allColumnScores = total.map((_, digit) => Math.min(
      columns[0][digit], columns[1][digit], columns[2][digit]
    ));
    const maxAllColumn = Math.max(...allColumnScores);
    const allColumnHot = allColumnScores.map((n,d) => n === maxAllColumn ? d : null).filter(v => v !== null);

    return { recent, total, columns, globalHot, allColumnHot, allColumnScores, maxTotal, maxAllColumn };
  }

  function getAbsenceStats(ordered) {
    const latest = ordered.at(-1);
    const latestDate = latest?.date || '';
    const todayDraws = ordered.filter(draw => draw.date === latestDate);
    const todayPresent = new Set(todayDraws.flatMap(digits));
    const todayAbsent = Array.from({length:10}, (_,d) => d).filter(d => !todayPresent.has(d));

    const stats = Array.from({length:10}, (_, digit) => {
      let lastIndex = -1;
      for (let index = ordered.length - 1; index >= 0; index--) {
        if (digits(ordered[index]).includes(digit)) {
          lastIndex = index;
          break;
        }
      }
      if (lastIndex < 0) {
        return { digit, drawGap: ordered.length, dayGap: 999, lastDraw: null };
      }
      const lastDraw = ordered[lastIndex];
      return {
        digit,
        drawGap: (ordered.length - 1) - lastIndex,
        dayGap: daysBetween(lastDraw, latest),
        lastDraw
      };
    });

    const maxGap = Math.max(...stats.map(x => x.drawGap));
    const longest = stats.filter(x => x.drawGap === maxGap);
    const absent2Days = stats.filter(x => x.dayGap >= 2 || x.drawGap >= 20);
    const absent3Days = stats.filter(x => x.dayGap >= 3 || x.drawGap >= 30);

    return { latestDate, todayAbsent, stats, longest, absent2Days, absent3Days };
  }

  function buildCurrentSignals(ordered, bases, frequency, absence) {
    const latest = ordered.at(-1);
    if (!latest || !settings.enabled || !settings.tripleSignal) return [];

    const map = new Map();

    bases.filter(base => base.readyForSum).forEach(base => {
      baseVariants(base.draw).forEach(variant => {
        const result = addVariantToDraw(variant, latest);
        const digit = tripleFrom(result);
        if (digit === null) return;
        const triple = `${digit}${digit}${digit}`;
        if (!map.has(triple)) {
          map.set(triple, {
            triple,
            digit,
            sources: [],
            frequencyGlobal: false,
            frequencyAllColumns: false,
            absence: false,
            score: 1
          });
        }
        map.get(triple).sources.push({
          base: drawCodeLocal(base.draw),
          baseId: base.draw.id,
          variant: code(variant),
          fact: drawCodeLocal(latest),
          result: triple,
          remaining: base.remaining
        });
      });
    });

    for (const signal of map.values()) {
      if (settings.frequencyAccent) {
        signal.frequencyGlobal = frequency.globalHot.includes(signal.digit);
        signal.frequencyAllColumns = frequency.allColumnHot.includes(signal.digit);
      }
      if (settings.absenceAccent) {
        const stat = absence.stats[signal.digit];
        signal.absence = Boolean(stat && (stat.dayGap >= 2 || stat.drawGap >= 20));
      }

      signal.score =
        1 +
        Math.min(2, Math.max(0, signal.sources.length - 1)) +
        (signal.frequencyGlobal ? 1 : 0) +
        (signal.frequencyAllColumns ? 1 : 0) +
        (signal.absence ? 2 : 0);

      signal.level =
        signal.score >= 5 ? 'alarm' :
        signal.score >= 3 ? 'strong' : 'normal';
    }

    return [...map.values()].sort((a,b) =>
      b.score - a.score ||
      b.sources.length - a.sources.length ||
      a.digit - b.digit
    );
  }

  function buildHistory(ordered, bases) {
    const grouped = new Map();

    bases.forEach(base => {
      const lastStep = Math.min(settings.window, ordered.length - 1 - base.index);
      for (let step = 1; step <= lastStep; step++) {
        const factIndex = base.index + step;
        const fact = ordered[factIndex];
        const target = ordered[factIndex + 1] || null;

        const triples = new Map();
        baseVariants(base.draw).forEach(variant => {
          const result = addVariantToDraw(variant, fact);
          const digit = tripleFrom(result);
          if (digit === null) return;
          const triple = `${digit}${digit}${digit}`;
          if (!triples.has(triple)) triples.set(triple, []);
          triples.get(triple).push(code(variant));
        });

        for (const [triple, variants] of triples.entries()) {
          const targetKey = target ? target.id : `pending-after-${fact.id}`;
          const key = `${targetKey}|${triple}`;
          if (!grouped.has(key)) {
            grouped.set(key, {
              triple,
              fact,
              target,
              hit: Boolean(target && drawCodeLocal(target) === triple),
              sources: []
            });
          }
          grouped.get(key).sources.push({
            base: base.draw,
            variants,
            step
          });
          if (target && drawCodeLocal(target) === triple) grouped.get(key).hit = true;
        }
      }
    });

    return [...grouped.values()].sort((a,b) => {
      const aid = a.target?.id || (a.fact?.id || 0) + 0.5;
      const bid = b.target?.id || (b.fact?.id || 0) + 0.5;
      return bid - aid || a.triple.localeCompare(b.triple);
    });
  }

  function accentTriples(frequency, absence) {
    const map = new Map();
    const add = (digit, reason, kind) => {
      const triple = `${digit}${digit}${digit}`;
      if (!map.has(triple)) map.set(triple, { triple, digit, reasons: [], kinds: new Set() });
      map.get(triple).reasons.push(reason);
      map.get(triple).kinds.add(kind);
    };

    if (settings.frequencyAccent) {
      frequency.allColumnHot.forEach(d => add(d, 'максимум одновременно во всех 3 столбцах', 'frequency-all'));
      frequency.globalHot.forEach(d => add(d, 'максимальная общая частота за 30 тиражей', 'frequency-global'));
    }

    if (settings.absenceAccent) {
      absence.longest.forEach(item => {
        if (item.drawGap > 0) add(item.digit, `самая длинная пауза: ${item.drawGap} тиражей`, 'absence');
      });
      absence.absent2Days.forEach(item => add(item.digit, `не появлялась около ${Math.max(item.dayGap, 2)} дн.`, 'absence-days'));
    }

    return [...map.values()].map(item => ({ ...item, kinds: [...item.kinds] }));
  }

  function renderSwitch(key, label, icon='') {
    const on = Boolean(settings[key]);
    return `<button class="mm-chip-toggle ${on ? 'on' : ''}" type="button" data-mm-switch="${key}" aria-pressed="${on}">
      <span class="mm-chip-icon">${icon}</span>
      <span>${label}</span>
      <i class="mm-mini-switch"><b></b></i>
    </button>`;
  }

  function renderSignalTile(signal) {
    const reasons = [];
    if (signal.frequencyAllColumns) reasons.push('макс. во всех столбцах');
    if (signal.frequencyGlobal) reasons.push('макс. частота');
    if (signal.absence) reasons.push('долгое отсутствие');
    if (signal.sources.length > 1) reasons.push(`${signal.sources.length} подтверждения`);

    const status = signal.level === 'alarm' ? '🚨 СИЛЬНЫЙ' :
      signal.level === 'strong' ? '🔥 УСИЛЕННЫЙ' : 'СИГНАЛ';

    return `<article class="mm-signal-tile ${signal.level}">
      <div class="mm-signal-code">${signal.triple}</div>
      <div class="mm-signal-status">${status}</div>
      <div class="mm-signal-reason">${reasons.join(' · ') || 'зеркальное сложение'}</div>
      <details>
        <summary>${signal.sources.length} источник${signal.sources.length === 1 ? '' : 'а'}</summary>
        ${signal.sources.map(s => `<p>${s.variant} + ${s.fact} = <strong>${s.result}</strong> · база ${s.base}</p>`).join('')}
      </details>
    </article>`;
  }

  function renderAccentTile(item, liveSignals) {
    const isLive = liveSignals.some(s => s.triple === item.triple);
    return `<article class="mm-accent-tile ${isLive ? 'live' : ''}">
      <strong>${item.triple}</strong>
      <span>${isLive ? '🚨 СОВПАЛ С СИГНАЛОМ' : 'акцент наблюдения'}</span>
      <small>${item.reasons.join(' · ')}</small>
    </article>`;
  }

  function activeBaseHtml(base, strongestBases) {
    const isStrong = strongestBases.has(base.draw.id);
    const mirrorPerms = uniquePermutations(mirror(digits(base.draw))).map(code).join(' / ');
    const remainingText = base.age === 0
      ? `${settings.window} / ${settings.window} · ждёт 1-й факт`
      : `${base.remaining} / ${settings.window}`;

    return `<article class="mm-base-card ${isStrong ? 'crown' : ''}">
      <div class="mm-base-code">${drawCodeLocal(base.draw)}${isStrong ? '<span>♛</span>' : ''}</div>
      <div class="mm-base-meta">№${base.draw.id} · ${base.draw.time}</div>
      <div class="mm-base-remain"><span>осталось</span><strong>${remainingText}</strong></div>
      <details>
        <summary>зеркало найдено</summary>
        <p>Зеркало: <b>${base.match.mirrorCode}</b></p>
        <p>Перестановки: ${mirrorPerms}</p>
        <p>Архив: №${base.match.draw.id} · ${base.match.matchedCode}</p>
      </details>
    </article>`;
  }

  function historyHtml(history) {
    if (!history.length) return '<div class="mm-empty">За выбранное окно тройных сигналов пока нет.</div>';
    return history.slice(0, 30).map(item => {
      const status = !item.target ? 'ОЖИДАЕТ' : item.hit ? '✅ ПОПАДАНИЕ' : '—';
      const cls = !item.target ? 'pending' : item.hit ? 'hit' : 'miss';
      return `<article class="mm-history-row ${cls}">
        <div>
          <strong>${item.triple}</strong>
          <span>${status}</span>
        </div>
        <p>После факта №${item.fact.id} · ${drawCodeLocal(item.fact)} → ${item.target ? `№${item.target.id} · ${drawCodeLocal(item.target)}` : 'следующий тираж'}</p>
        <small>Базы: ${item.sources.map(s => `${drawCodeLocal(s.base)} (шаг ${s.step}/15)`).join(' · ')}</small>
      </article>`;
    }).join('');
  }

  function renderPanel() {
    ensurePanel();
    const panel = document.getElementById('mirrorMethodPanel');
    if (!panel) return;

    const all = sourceDraws();
    if (!all.length) {
      panel.querySelector('.mm-body').innerHTML = '<div class="mm-empty">Жду загрузку архива TOP-3…</div>';
      return;
    }

    const ordered = [...all].sort((a,b) => a.id - b.id);
    const latest = ordered.at(-1);
    const qualified = getQualifiedBases(ordered);
    const active = qualified.filter(item => item.active);
    const frequency = getFrequencyStats(ordered);
    const absence = getAbsenceStats(ordered);
    const signals = buildCurrentSignals(ordered, active, frequency, absence);
    const history = buildHistory(ordered, qualified);
    const accents = accentTriples(frequency, absence);

    const strongestBases = new Set(
      signals.flatMap(signal => signal.level !== 'normal' ? signal.sources.map(s => s.baseId) : [])
    );

    const hits = history.filter(item => item.hit).length;
    const checked = history.filter(item => item.target).length;
    const signalTargets = new Set(history.map(item => item.target?.id).filter(Boolean)).size;
    const baseVisible = settings.showAllBases ? active : active.slice().reverse().slice(0, 6).reverse();

    let nextText = 'следующий тираж';
    try {
      if (typeof nextDrawAfterLatest === 'function') {
        const next = nextDrawAfterLatest(latest);
        if (next?.time) nextText = `${next.date || ''} ${next.time}`.trim();
      }
    } catch {}

    const hotAll = frequency.allColumnHot.join(', ');
    const hotGlobal = frequency.globalHot.join(', ');
    const absentToday = absence.todayAbsent.length ? absence.todayAbsent.join(', ') : 'нет';
    const absent2 = absence.absent2Days.length ? absence.absent2Days.map(x => x.digit).join(', ') : 'нет';

    panel.classList.toggle('mm-disabled', !settings.enabled);

    panel.querySelector('.mm-body').innerHTML = `
      <div class="mm-controls-grid">
        <div class="mm-control-card">
          <label>ВКЛ / ВЫКЛ</label>
          <button class="mm-main-switch ${settings.enabled ? 'on' : ''}" data-mm-switch="enabled" type="button">
            <span>${settings.enabled ? 'ВКЛ' : 'ВЫКЛ'}</span><i><b></b></i>
          </button>
        </div>

        <div class="mm-control-card">
          <label>ПЕРЕСТАНОВКИ</label>
          <select id="mmPermutations">
            <option value="all" ${settings.permutations === 'all' ? 'selected' : ''}>все уникальные</option>
            <option value="exact" ${settings.permutations === 'exact' ? 'selected' : ''}>только исходная</option>
          </select>
        </div>

        <div class="mm-control-card">
          <label>ОКНО ДЕЙСТВИЯ БАЗЫ</label>
          <select id="mmWindow">
            ${[5,10,15,20].map(n => `<option value="${n}" ${settings.window === n ? 'selected' : ''}>${n} тиражей</option>`).join('')}
          </select>
        </div>

        <div class="mm-control-card">
          <label>СИГНАЛ НА ТРОЙНИК</label>
          <button class="mm-main-switch ${settings.tripleSignal ? 'on' : ''}" data-mm-switch="tripleSignal" type="button">
            <span>${settings.tripleSignal ? 'ВКЛ' : 'ВЫКЛ'}</span><i><b></b></i>
          </button>
        </div>
      </div>

      <div class="mm-toggle-row">
        ${renderSwitch('notifications','Уведомления','♢')}
        ${renderSwitch('frequencyAccent','Акцент на частоты','☆')}
        ${renderSwitch('absenceAccent','Акцент на отсутствие','⊘')}
      </div>

      <section class="mm-live-section">
        <div class="mm-section-head">
          <div><span class="mm-kicker">ТЕКУЩИЙ РАСЧЁТ</span><h4>Сигналы на тройник · ${nextText}</h4></div>
          <span class="mm-live-dot">${signals.length ? '● СИГНАЛ' : '● НАБЛЮДЕНИЕ'}</span>
        </div>
        <div class="mm-signal-grid">
          ${signals.length ? signals.map(renderSignalTile).join('') : `
            <div class="mm-empty-signal">
              <strong>Прямого тройника сейчас нет</strong>
              <span>Метод продолжает считать все активные базы на каждом новом факте.</span>
            </div>`}
        </div>
        <div class="mm-accent-grid">
          ${accents.slice(0,6).map(item => renderAccentTile(item, signals)).join('')}
        </div>
      </section>

      <section class="mm-summary-grid">
        <div class="mm-summary-card">
          <span>АКТИВНЫХ БАЗ</span>
          <strong>${active.length}<small> / ${settings.scan}</small></strong>
          <em>зеркало найдено: ${qualified.length} из последних ${settings.scan}</em>
        </div>
        <div class="mm-summary-card">
          <span>ПОПАДАНИЙ В ИСТОРИИ</span>
          <strong class="blue">${hits}</strong>
          <em>проверено сигналов: ${checked} · целей: ${signalTargets}</em>
        </div>
      </section>

      <section class="mm-bases-section">
        <div class="mm-section-head">
          <div><span class="mm-kicker">АКТИВНЫЕ БАЗЫ</span><h4>Зеркало найдено → считаем ${settings.window} тиражей</h4></div>
          <button id="mmShowAllBases" class="mm-link-btn" type="button">${settings.showAllBases ? 'Свернуть' : 'Показать все'} ›</button>
        </div>
        <div class="mm-base-strip">
          ${baseVisible.length ? baseVisible.map(base => activeBaseHtml(base, strongestBases)).join('') : '<div class="mm-empty">Активных баз сейчас нет.</div>'}
        </div>
      </section>

      <section class="mm-stats-grid">
        <div class="mm-frequency-card">
          <div class="mm-section-head compact">
            <div><span class="mm-kicker cyan">ЧАСТОТА ЦИФР</span><h4>Последние 30 тиражей</h4></div>
          </div>
          <div class="mm-digit-frequency">
            ${frequency.total.map((count,digit) => {
              const cls = [
                frequency.globalHot.includes(digit) ? 'hot-global' : '',
                frequency.allColumnHot.includes(digit) ? 'hot-all' : ''
              ].filter(Boolean).join(' ');
              return `<div class="mm-digit-cell ${cls}">
                <b>${digit}</b><strong>${count}</strong>
                <small>${frequency.columns[0][digit]}/${frequency.columns[1][digit]}/${frequency.columns[2][digit]}</small>
              </div>`;
            }).join('')}
          </div>
          <p class="mm-stat-note"><span class="green">●</span> максимум во всех столбцах: <strong>${hotAll}</strong> · <span class="red">●</span> максимум общей частоты: <strong>${hotGlobal}</strong></p>
        </div>

        <div class="mm-absence-card">
          <div class="mm-section-head compact">
            <div><span class="mm-kicker orange">ОТСУТСТВИЕ ЦИФР</span><h4>Паузы 2–3 дня</h4></div>
          </div>
          <p>Сегодня не было: <strong>${absentToday}</strong></p>
          <p>Около 2+ дней без: <strong>${absent2}</strong></p>
          <div class="mm-drought-list">
            ${absence.longest.map(item => `<div><b>${item.digit}</b><span>${item.drawGap} тиражей без цифры</span><small>${item.lastDraw ? `последний раз: ${item.lastDraw.date} ${item.lastDraw.time} (${drawCodeLocal(item.lastDraw)})` : 'в архиве не найдена'}</small></div>`).join('')}
          </div>
        </div>
      </section>

      <button id="mmHistoryBtn" class="mm-history-button" type="button">
        <span>▥</span><b>ИСТОРИЯ СИГНАЛОВ И ПОПАДАНИЙ</b><i>${settings.showHistory ? '⌃' : '›'}</i>
      </button>
      <div id="mmHistory" class="mm-history ${settings.showHistory ? '' : 'hidden'}">
        ${historyHtml(history)}
      </div>
    `;

    bindPanelEvents(panel);
    maybeNotify(signals, latest, nextText);
  }

  function ensurePanel() {
    if (document.getElementById('mirrorMethodPanel')) return;
    const view = document.getElementById('view-analysis');
    if (!view) return;
    const title = view.querySelector('.page-title');
    if (!title) return;

    const panel = document.createElement('section');
    panel.id = 'mirrorMethodPanel';
    panel.className = 'panel mm-panel';
    panel.setAttribute('aria-labelledby','mmTitle');
    panel.innerHTML = `
      <div class="mm-panel-head">
        <div class="mm-method-icon">↯</div>
        <div class="mm-title-block">
          <span class="mm-kicker">МЕТОД ЮЛИИ · ЗЕРКАЛЬНЫЙ СКАНЕР</span>
          <h3 id="mmTitle">ЗЕРКАЛО И ПРИБАВЛЕНИЕ · 15 ТИРАЖЕЙ</h3>
          <p>Зеркалим каждую комбинацию, ищем зеркало в прошлом архиве и прибавляем перестановки базы к следующим фактам по mod 10.</p>
        </div>
        <button id="mmHelpBtn" class="mm-help-btn" type="button">ⓘ <span>Как работает</span></button>
      </div>
      <div class="mm-body"><div class="mm-empty">Загружаю зеркальный метод…</div></div>
      <dialog id="mmHelpDialog" class="mm-help-dialog">
        <form method="dialog">
          <button class="mm-dialog-close" aria-label="Закрыть">×</button>
          <span class="mm-kicker">КАК РАБОТАЕТ МЕТОД</span>
          <h3>Зеркало → база → 15 тиражей</h3>
          <ol>
            <li>Каждую новую тройку зеркалим: <b>${formatMirrorMapping()}</b>.</li>
            <li>Проверяем все перестановки зеркала только в более раннем архиве.</li>
            <li>Если зеркало найдено — фактическая комбинация становится базой на ${settings.window} следующих тиражей.</li>
            <li>Все уникальные перестановки базы прибавляются к каждому новому факту по позициям, mod 10.</li>
            <li>Если сумма дала 000/111/…/999 — это сигнал на следующий тираж.</li>
            <li>Сигнал усиливается, если цифра долго отсутствует или имеет максимальную частоту во всех столбцах.</li>
          </ol>
          <p class="mm-dialog-example"><b>Контрольный пример:</b> база 309 → перестановка 930; факт 281; 930 + 281 = <strong>111</strong> → следующий факт 111.</p>
        </form>
      </dialog>
    `;
    title.insertAdjacentElement('afterend', panel);
  }

  function bindPanelEvents(panel) {
    panel.querySelectorAll('[data-mm-switch]').forEach(button => {
      button.onclick = async () => {
        const key = button.dataset.mmSwitch;
        settings[key] = !settings[key];
        saveSettings();

        if (key === 'notifications' && settings.notifications && 'Notification' in window && Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch {}
        }
        renderPanel();
      };
    });

    const permutations = panel.querySelector('#mmPermutations');
    if (permutations) permutations.onchange = () => {
      settings.permutations = permutations.value === 'exact' ? 'exact' : 'all';
      saveSettings();
      renderPanel();
    };

    const windowSelect = panel.querySelector('#mmWindow');
    if (windowSelect) windowSelect.onchange = () => {
      settings.window = Math.max(1, Math.min(30, Number(windowSelect.value) || 15));
      saveSettings();
      renderPanel();
    };

    const showAll = panel.querySelector('#mmShowAllBases');
    if (showAll) showAll.onclick = () => {
      settings.showAllBases = !settings.showAllBases;
      saveSettings();
      renderPanel();
    };

    const historyBtn = panel.querySelector('#mmHistoryBtn');
    if (historyBtn) historyBtn.onclick = () => {
      settings.showHistory = !settings.showHistory;
      saveSettings();
      renderPanel();
    };

    const help = panel.querySelector('#mmHelpBtn');
    if (help) help.onclick = () => {
      const dialog = panel.querySelector('#mmHelpDialog');
      if (!dialog) return;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open','');
    };
  }

  function maybeNotify(signals, latest, nextText) {
    if (!settings.enabled || !settings.notifications || !signals.length || !latest) return;
    const strongest = signals[0];
    if (strongest.level === 'normal') return;

    const key = `${latest.id}|${strongest.triple}|${strongest.level}`;
    try {
      if (localStorage.getItem(NOTIFY_KEY) === key) return;
    } catch {}

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`Yulia TOP-3 · сигнал ${strongest.triple}`, {
          body: `${nextText}: ${strongest.level === 'alarm' ? 'сильный' : 'усиленный'} зеркальный сигнал. Подтверждений: ${strongest.sources.length}.`,
          icon: 'icon-192.png',
          tag: `yulia-top3-${strongest.triple}`
        });
        try { localStorage.setItem(NOTIFY_KEY, key); } catch {}
      } catch {}
    }
  }

  function installHooks() {
    ensurePanel();

    try {
      if (typeof renderAnalysis === 'function' && !renderAnalysis.__mirrorMethodWrapped) {
        const original = renderAnalysis;
        const wrapped = function(...args) {
          const value = original.apply(this, args);
          queueMicrotask(renderPanel);
          return value;
        };
        wrapped.__mirrorMethodWrapped = true;
        renderAnalysis = wrapped;
      }
    } catch {}

    document.addEventListener('click', event => {
      if (event.target.closest('[data-view="analysis"]')) {
        setTimeout(renderPanel, 0);
      }
    });

    clearInterval(intervalId);
    intervalId = setInterval(() => {
      const list = sourceDraws();
      const latestId = list[0]?.id || null;
      if (latestId !== lastSeenDrawId) {
        lastSeenDrawId = latestId;
        renderPanel();
      }
    }, 8000);

    renderPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHooks, { once: true });
  } else {
    installHooks();
  }

  window.YuliaMirrorMethod = {
    version: MIRROR_METHOD_VERSION,
    render: renderPanel,
    getSettings: () => ({ ...settings }),
    resetSettings: () => {
      settings = { ...DEFAULTS };
      saveSettings();
      renderPanel();
    }
  };
})();
