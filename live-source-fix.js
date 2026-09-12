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
