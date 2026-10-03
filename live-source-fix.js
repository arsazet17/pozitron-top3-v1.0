(() => {
  'use strict';

  const CONTENTS_URL = 'https://api.github.com/repos/arsazet17/pozitron-top3-v1.0/contents/top3-live.json?ref=main';
  const RAW_URL = 'https://raw.githubusercontent.com/arsazet17/pozitron-top3-v1.0/main/top3-live.json';

  function normalizePayload(payload, transport) {
    const items = Array.isArray(payload) ? payload : payload?.draws;
    if (!Array.isArray(items) || !items.length) {
      throw new Error(`${transport}: файл не содержит тиражей`);
    }
    return {
      items,
      forecasts: Array.isArray(payload?.forecasts) ? payload.forecasts : [],
      source: `${payload?.source || 'GitHub TOP-3 Live'} · ${transport}`,
      generatedAt: payload?.updatedAt || null
    };
  }

  function decodeBase64Utf8(value) {
    const clean = String(value || '').replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function fetchFromContentsApi() {
    const response = await fetch(`${CONTENTS_URL}&_=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);

    const meta = await response.json();
    if (meta?.content && meta?.encoding === 'base64') {
      const payload = JSON.parse(decodeBase64Utf8(meta.content));
      return normalizePayload(payload, 'GitHub API direct');
    }

    if (meta?.download_url) {
      const raw = await fetch(`${meta.download_url}${meta.download_url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
      if (!raw.ok) throw new Error(`GitHub raw fallback HTTP ${raw.status}`);
      return normalizePayload(await raw.json(), 'GitHub API→raw');
    }

    throw new Error('GitHub API не вернул содержимое top3-live.json');
  }

  async function fetchFromRaw() {
    const response = await fetch(`${RAW_URL}?_=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`GitHub raw HTTP ${response.status}`);
    return normalizePayload(await response.json(), 'GitHub raw fallback');
  }

  if (typeof fetchLuckyDraws === 'function') {
    fetchLuckyDraws = async function fetchLuckyDrawsDirect() {
      try {
        return await fetchFromContentsApi();
      } catch (apiError) {
        console.warn('TOP3 direct API source failed, using raw fallback:', apiError);
        return await fetchFromRaw();
      }
    };
  } else {
    console.error('TOP3 live-source fix: fetchLuckyDraws is not available');
  }
})();

(() => {
  'use strict';

  if (typeof buildAiAnalysisForTime !== 'function' || typeof renderAiInto !== 'function') {
    console.error('TOP3 neural predictor: AI functions are not available');
    return;
  }

  const ORIGINAL_BUILD_AI = buildAiAnalysisForTime;
  const WINDOWS = [8, 32];
  const INPUT_SIZE = 92; // 60 частот + 30 one-hot последнего тиража + sin/cos времени
  const HIDDEN_SIZE = 16;
  const OUTPUT_SIZE = 30; // 3 поля × 10 цифр
  const MAX_TRAIN_SAMPLES = 1200;
  const EPOCHS = 3;
  const MIN_ROWS = 40;
  const neuralCache = new Map();

  function digitAt(draw, position) {
    if (!draw) return 0;
    if (position === 0) return Number(draw.a) || 0;
    if (position === 1) return Number(draw.b) || 0;
    return Number(draw.c) || 0;
  }

  function codeOfDraw(draw) {
    return `${digitAt(draw, 0)}${digitAt(draw, 1)}${digitAt(draw, 2)}`;
  }

  function shortDateToFull(value) {
    const match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
    return match ? `${match[1]}.${match[2]}.20${match[3]}` : String(value || '');
  }

  function timeParts(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return [0, 0];
    return [Number(match[1]) || 0, Number(match[2]) || 0];
  }

  function makeFeatures(rows, endExclusive, targetTime) {
    const features = [];

    WINDOWS.forEach(windowSize => {
      const start = Math.max(0, endExclusive - windowSize);
      const count = Math.max(1, endExclusive - start);
      for (let position = 0; position < 3; position += 1) {
        const counts = Array(10).fill(0);
        for (let index = start; index < endExclusive; index += 1) {
          counts[digitAt(rows[index], position)] += 1;
        }
        for (let digit = 0; digit < 10; digit += 1) features.push(counts[digit] / count);
      }
    });

    const last = rows[endExclusive - 1] || null;
    for (let position = 0; position < 3; position += 1) {
      const lastDigit = digitAt(last, position);
      for (let digit = 0; digit < 10; digit += 1) features.push(last && digit === lastDigit ? 1 : 0);
    }

    const [hour, minute] = timeParts(targetTime);
    const dayFraction = (hour * 60 + minute) / 1440;
    features.push(Math.sin(dayFraction * Math.PI * 2));
    features.push(Math.cos(dayFraction * Math.PI * 2));

    return Float32Array.from(features);
  }

  function seededRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function seedFor(time, latestId) {
    let hash = (Number(latestId) || 1) >>> 0;
    const text = String(time || 'all');
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
    }
    return hash || 1;
  }

  function createNetwork(seed) {
    const random = seededRandom(seed);
    const w1 = new Float32Array(HIDDEN_SIZE * INPUT_SIZE);
    const b1 = new Float32Array(HIDDEN_SIZE);
    const w2 = new Float32Array(OUTPUT_SIZE * HIDDEN_SIZE);
    const b2 = new Float32Array(OUTPUT_SIZE);
    for (let index = 0; index < w1.length; index += 1) w1[index] = (random() - 0.5) * 0.12;
    for (let index = 0; index < w2.length; index += 1) w2[index] = (random() - 0.5) * 0.12;
    return {w1, b1, w2, b2};
  }

  function forward(network, input) {
    const hidden = new Float32Array(HIDDEN_SIZE);
    for (let h = 0; h < HIDDEN_SIZE; h += 1) {
      let sum = network.b1[h];
      const offset = h * INPUT_SIZE;
      for (let i = 0; i < INPUT_SIZE; i += 1) sum += network.w1[offset + i] * input[i];
      hidden[h] = Math.tanh(sum);
    }

    const logits = new Float32Array(OUTPUT_SIZE);
    for (let out = 0; out < OUTPUT_SIZE; out += 1) {
      let sum = network.b2[out];
      const offset = out * HIDDEN_SIZE;
      for (let h = 0; h < HIDDEN_SIZE; h += 1) sum += network.w2[offset + h] * hidden[h];
      logits[out] = sum;
    }

    const probabilities = new Float32Array(OUTPUT_SIZE);
    for (let position = 0; position < 3; position += 1) {
      const base = position * 10;
      let maximum = -Infinity;
      for (let digit = 0; digit < 10; digit += 1) maximum = Math.max(maximum, logits[base + digit]);
      let total = 0;
      for (let digit = 0; digit < 10; digit += 1) {
        const value = Math.exp(logits[base + digit] - maximum);
        probabilities[base + digit] = value;
        total += value;
      }
      const divisor = total || 1;
      for (let digit = 0; digit < 10; digit += 1) probabilities[base + digit] /= divisor;
    }

    return {hidden, probabilities};
  }

  function trainOne(network, input, targetDraw, learningRate) {
    const {hidden, probabilities} = forward(network, input);
    const dOut = new Float32Array(OUTPUT_SIZE);
    const scale = 1 / 3;

    for (let position = 0; position < 3; position += 1) {
      const target = digitAt(targetDraw, position);
      const base = position * 10;
      for (let digit = 0; digit < 10; digit += 1) {
        dOut[base + digit] = (probabilities[base + digit] - (digit === target ? 1 : 0)) * scale;
      }
    }

    const dHidden = new Float32Array(HIDDEN_SIZE);
    for (let h = 0; h < HIDDEN_SIZE; h += 1) {
      let sum = 0;
      for (let out = 0; out < OUTPUT_SIZE; out += 1) {
        sum += network.w2[out * HIDDEN_SIZE + h] * dOut[out];
      }
      dHidden[h] = sum * (1 - hidden[h] * hidden[h]);
    }

    for (let out = 0; out < OUTPUT_SIZE; out += 1) {
      const gradient = dOut[out];
      const offset = out * HIDDEN_SIZE;
      for (let h = 0; h < HIDDEN_SIZE; h += 1) {
        network.w2[offset + h] -= learningRate * gradient * hidden[h];
      }
      network.b2[out] -= learningRate * gradient;
    }

    for (let h = 0; h < HIDDEN_SIZE; h += 1) {
      const gradient = dHidden[h];
      const offset = h * INPUT_SIZE;
      for (let i = 0; i < INPUT_SIZE; i += 1) {
        network.w1[offset + i] -= learningRate * gradient * input[i];
      }
      network.b1[h] -= learningRate * gradient;
    }
  }

  function trainNetwork(rows, time, latestId) {
    const network = createNetwork(seedFor(time, latestId));
    const firstTarget = Math.max(WINDOWS[WINDOWS.length - 1], rows.length - MAX_TRAIN_SAMPLES);
    const trainedSamples = Math.max(0, rows.length - firstTarget);

    for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
      const learningRate = 0.018 / (1 + epoch * 0.35);
      for (let index = firstTarget; index < rows.length; index += 1) {
        const input = makeFeatures(rows, index, rows[index].time);
        trainOne(network, input, rows[index], learningRate);
      }
    }

    return {network, trainedSamples};
  }

  function rankingsFromProbabilities(probabilities) {
    return [0, 1, 2].map(position => {
      const base = position * 10;
      const items = [];
      for (let digit = 0; digit < 10; digit += 1) {
        items.push({digit, probability:Number(probabilities[base + digit]) || 0});
      }
      return items.sort((left, right) => right.probability - left.probability || left.digit - right.digit);
    });
  }

  function hideBacktests() {
    ['aiBacktest', 'aiTimeBacktest'].forEach(id => {
      const element = document.getElementById(id);
      if (!element) return;
      element.innerHTML = '';
      element.hidden = true;
      element.style.display = 'none';
    });
  }

  function ensureParagraph(panel, className, afterNode) {
    let paragraph = panel?.querySelector(`.${className}`);
    if (!paragraph && panel) {
      paragraph = document.createElement('p');
      paragraph.className = `panel-note ${className}`;
      if (afterNode?.parentNode) afterNode.parentNode.insertBefore(paragraph, afterNode.nextSibling);
      else panel.appendChild(paragraph);
    }
    return paragraph;
  }

  function decorateStaticCopy() {
    const homeTitle = document.getElementById('aiTitle');
    const homePanel = homeTitle?.closest('.ai-panel');
    if (homePanel) {
      const eyebrow = homePanel.querySelector('.eyebrow');
      if (eyebrow) eyebrow.textContent = 'НЕЙРОСЕТЬ · ОБУЧЕНИЕ В БРАУЗЕРЕ';
      const sectionHead = homePanel.querySelector('.section-head');
      const subtitle = ensureParagraph(homePanel, 'ai-neural-subtitle', sectionHead);
      if (subtitle) subtitle.textContent = 'Обучите модель на реальных тиражах и получите модельные вероятности цифр к следующему розыгрышу.';
    }

    const pageTitle = document.getElementById('aiTimeTitle');
    const pageBox = pageTitle?.closest('.page-title');
    if (pageBox) {
      const eyebrow = pageBox.querySelector('.eyebrow');
      if (eyebrow) eyebrow.textContent = 'НЕЙРОСЕТЬ · ОБЩАЯ МОДЕЛЬ И 48 МОДЕЛЕЙ ПО ВРЕМЕНИ';
      pageTitle.textContent = 'Нейросеть Топ-3: ИИ-предсказание чисел';
      const text = pageBox.querySelector('p');
      if (text) text.textContent = 'Режим «ВСЕ» обучается на общей последовательности тиражей. Отдельное время обучается только на истории этого времени между днями.';
    }
  }

  function updateModelExplanation(analysis) {
    const archiveLatest = Array.isArray(draws) && draws.length ? draws[0] : analysis?.latest;
    const homeTitle = document.getElementById('aiTitle');
    const homePanel = homeTitle?.closest('.ai-panel');
    if (homePanel && archiveLatest) {
      homeTitle.textContent = 'Нейросеть Топ-3: ИИ-предсказание чисел';
      const notes = [...homePanel.querySelectorAll(':scope > .panel-note')];
      const originalNote = notes.find(note => !note.classList.contains('ai-neural-subtitle') && !note.classList.contains('ai-neural-explainer'));
      if (originalNote) {
        originalNote.innerHTML = `<strong>Нейросеть для Топ-3 обучается на реальных тиражах прямо в браузере и оценивает 30 модельных вероятностей — по 10 цифр для каждого из трёх полей — в следующем розыгрыше.</strong> Данные учитывают тираж №${archiveLatest.id} от ${shortDateToFull(archiveLatest.date)}.`;
        const explainer = ensureParagraph(homePanel, 'ai-neural-explainer', originalNote);
        if (explainer) explainer.textContent = 'Модель просматривает последовательность прошлых тиражей через скользящие окна 8 и 32, учится на частотах и последних состояниях и превращает выходы сети в вероятности. Из них собирается готовая комбинация для следующего розыгрыша.';
      }
    }

    const timePanelTitle = document.getElementById('aiTimePanelTitle');
    const timePanel = timePanelTitle?.closest('.ai-panel');
    if (timePanel) {
      const note = timePanel.querySelector('.panel-note');
      if (note) note.textContent = 'Нейросеть выдаёт 30 модельных вероятностей: 10 цифр для каждого из трёх полей. Основная комбинация собирается из максимальной вероятности каждого поля.';
    }
  }

  // Бэктест полностью отключён: он не рассчитывается и не влияет на сигнал.
  runAiBacktest = function runAiBacktestDisabled() { return null; };

  buildAiAnalysisForTime = function buildNeuralAnalysisForTime(time) {
    const isAll = time === 'all';
    const modelDraws = isAll ? [...draws].sort((left, right) => right.id - left.id) : drawsForTime(time);
    const latest = modelDraws[0] || null;
    if (!latest) return null;

    const rows = [...modelDraws].sort((left, right) => left.id - right.id);
    if (rows.length < MIN_ROWS) {
      const fallback = ORIGINAL_BUILD_AI(time);
      if (fallback) fallback.backtest = null;
      return fallback;
    }

    const next = isAll ? {...nextDrawAfterLatest(latest), dayGap:1} : nextSameTimeAfterLatest(latest, time);
    const cacheKey = `neural-v1|${time}|${rows.length}|${latest.id}|${codeOfDraw(latest)}|${next.date}|${next.time}`;
    if (neuralCache.has(cacheKey)) return neuralCache.get(cacheKey);

    const {network, trainedSamples} = trainNetwork(rows, time, latest.id);
    const input = makeFeatures(rows, rows.length, next.time);
    const {probabilities} = forward(network, input);
    const rankings = rankingsFromProbabilities(probabilities);
    const predictedDigits = rankings.map(ranking => ranking[0].digit);
    const primaryDelta = predictedDigits.map((digit, position) => ((digit - digitAt(latest, position)) % 10 + 10) % 10);
    const records = rows.slice(1);

    const value = {
      time,
      isAll,
      timeDraws:modelDraws,
      latest,
      records,
      next,
      rankings,
      primaryDelta,
      predictedDigits,
      backtest:null,
      neuralMeta:{
        samples:trainedSamples,
        epochs:EPOCHS,
        hidden:HIDDEN_SIZE,
        windows:[...WINDOWS]
      }
    };
    neuralCache.set(cacheKey, value);
    return value;
  };

  aiSignalInfo = function neuralSignalInfo(analysis) {
    const probabilities = analysis?.rankings?.map(ranking => ranking[0]?.probability || 0) || [0, 0, 0];
    const gaps = analysis?.rankings?.map(ranking => (ranking[0]?.probability || 0) - (ranking[1]?.probability || 0)) || [0, 0, 0];
    const averageProbability = probabilities.reduce((sum, value) => sum + value, 0) / 3;
    const averageGap = gaps.reduce((sum, value) => sum + value, 0) / 3;
    if (averageProbability >= 0.16 && averageGap >= 0.025) return {label:'Повышенный сигнал', className:'strong'};
    if (averageProbability >= 0.13 && averageGap >= 0.012) return {label:'Средний сигнал', className:'medium'};
    return {label:'Слабый сигнал', className:'weak'};
  };

  renderAiInto = function renderNeuralAiInto(ids, time) {
    const contextNode = document.getElementById(ids.context);
    if (!contextNode) return;
    const analysis = buildAiAnalysisForTime(time);
    const scopeLabel = time === 'all' ? 'ВСЕ ВРЕМЕНА' : time;
    const titleNode = ids.title ? document.getElementById(ids.title) : null;
    if (titleNode) titleNode.textContent = ids.title === 'aiTitle'
      ? 'Нейросеть Топ-3: ИИ-предсказание чисел'
      : `Нейросеть Топ-3 · ${scopeLabel}`;

    const mainNode = document.getElementById(ids.main);
    const columnsNode = document.getElementById(ids.columns);
    const backtestNode = document.getElementById(ids.backtest);

    if (!analysis) {
      contextNode.textContent = `Недостаточно истории для обучения нейросети ${scopeLabel}.`;
      if (mainNode) mainNode.innerHTML = '';
      if (columnsNode) columnsNode.innerHTML = '';
      if (backtestNode) {
        backtestNode.innerHTML = '';
        backtestNode.hidden = true;
        backtestNode.style.display = 'none';
      }
      return;
    }

    const signal = aiSignalInfo(analysis);
    const badge = document.getElementById(ids.badge);
    if (badge) {
      badge.textContent = signal.label;
      badge.className = `ai-signal ${signal.className}`;
    }

    const trainedSamples = analysis.neuralMeta?.samples ?? Math.max(0, analysis.records?.length || 0);
    contextNode.innerHTML = `<div><span>Последний факт ${scopeLabel}</span><strong>№${analysis.latest.id} · ${codeOfDraw(analysis.latest)}</strong><small>${shortDateToFull(analysis.latest.date)}</small></div><div><span>Следующая цель</span><strong>${shortDateToFull(analysis.next.date)} · ${analysis.next.time}</strong><small>${trainedSamples.toLocaleString('ru-RU')} примеров в обучении</small></div>`;

    if (mainNode) {
      mainNode.innerHTML = `
        <div class="ai-main-block"><span>Нейросеть ${scopeLabel}</span><strong>${trainedSamples.toLocaleString('ru-RU')}</strong><small>обучающих примеров · окна ${WINDOWS.join('/')}</small></div>
        <div class="ai-main-arrow">→</div>
        <div class="ai-main-block result"><span>Расчётная комбинация</span><strong>${analysis.predictedDigits.join('')}</strong><small>максимальная модельная вероятность в каждом поле</small></div>`;
    }

    if (columnsNode) {
      columnsNode.innerHTML = analysis.rankings.map((ranking, position) => {
        const candidates = ranking.slice(0, 3);
        return `<article class="ai-column-card">
          <span>ПОЛЕ ${position + 1}</span>
          <strong>${candidates[0]?.digit ?? '—'}</strong>
          <div class="ai-candidates">${candidates.map((item, index) => `<b class="ai-candidate ${index === 0 ? 'primary' : ''}"><span>${item.digit}</span><small>${(item.probability * 100).toFixed(1)}%</small></b>`).join('')}</div>
        </article>`;
      }).join('');
    }

    if (backtestNode) {
      backtestNode.innerHTML = '';
      backtestNode.hidden = true;
      backtestNode.style.display = 'none';
    }

    decorateStaticCopy();
    updateModelExplanation(analysis);
    hideBacktests();
  };

  document.addEventListener('DOMContentLoaded', () => {
    decorateStaticCopy();
    hideBacktests();
  });
})();
