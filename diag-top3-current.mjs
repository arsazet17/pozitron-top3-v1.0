import { chromium } from 'playwright';

const EMAIL = process.env.STOLOTO_EMAIL || '';
const PASSWORD = process.env.STOLOTO_PASSWORD || '';
const TARGETS = [267956,267957,267958,267959,267960];
const LOGIN_URL = 'https://oauth.stoloto.ru/login';
const URLS = [
  'https://m.stoloto.ru/top3/archive',
  'https://www.stoloto.ru/top3/archive'
];

async function firstVisible(locators) {
  for (const locator of locators) {
    try { if (await locator.isVisible({timeout:1200})) return locator; } catch {}
  }
  return null;
}

async function login(page) {
  if (!EMAIL || !PASSWORD) throw new Error('missing STOLOTO_EMAIL/STOLOTO_PASSWORD');
  await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:45000});
  await page.waitForTimeout(1000);
  const email = await firstVisible([
    page.getByLabel(/телефон или email/i).first(),
    page.getByLabel(/email/i).first(),
    page.locator('input[type="email"]').first(),
    page.locator('input[name*="login" i]').first(),
    page.locator('input[name*="email" i]').first()
  ]);
  if (!email) throw new Error('email field not found');
  await email.fill(EMAIL);
  const pass = await firstVisible([
    page.getByLabel(/пароль/i).first(),
    page.locator('input[type="password"]').first()
  ]);
  if (!pass) throw new Error('password field not found');
  await pass.fill(PASSWORD);
  const submit = await firstVisible([
    page.getByRole('button', {name:/войти|продолжить/i}).first(),
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first()
  ]);
  if (!submit) throw new Error('submit not found');
  await submit.click();
  await page.waitForTimeout(2500);
}

function excerpts(text) {
  const out = [];
  for (const n of TARGETS) {
    const s = String(n);
    let i = 0;
    while ((i = text.indexOf(s, i)) >= 0) {
      out.push({draw:n, excerpt:text.slice(Math.max(0,i-250), Math.min(text.length,i+700)).replace(/\s+/g,' ')});
      i += s.length;
      if (out.filter(x=>x.draw===n).length >= 3) break;
    }
  }
  return out;
}

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({locale:'ru-RU', timezoneId:'Europe/Moscow'});
const page = await context.newPage();
const network = [];
page.on('response', async r => {
  try {
    const type = r.request().resourceType();
    const url = r.url();
    if (!['xhr','fetch'].includes(type)) return;
    if (!/stoloto|lottery|draw|archive|top3/i.test(url)) return;
    const text = await r.text();
    const hits = excerpts(text);
    if (hits.length) network.push({status:r.status(), url, hits});
  } catch {}
});

const result = {targets:TARGETS, pages:[], network:[]};
try {
  await login(page);
  for (const base of URLS) {
    const u = `${base}?_diag=${Date.now()}`;
    await page.goto(u, {waitUntil:'domcontentloaded', timeout:45000});
    await page.waitForTimeout(2500);
    const inputs = await page.locator('input').evaluateAll(els => els.map((e,i)=>({i,type:e.type,name:e.name,placeholder:e.placeholder,aria:e.getAttribute('aria-label'),value:e.value})).filter(x=>x.type!=='password' && x.type!=='email'));
    const buttons = await page.locator('button').evaluateAll(els => els.slice(0,40).map((e,i)=>({i,text:(e.innerText||e.textContent||'').trim().replace(/\s+/g,' '),type:e.type}))).catch(()=>[]);
    const body = await page.locator('body').innerText().catch(()=> '');
    const entry = {base, inputs, buttons, initialHits:excerpts(body)};

    const candidates = page.locator('input');
    let searchInput = null;
    for (let i=0;i<await candidates.count();i++) {
      const el = candidates.nth(i);
      const meta = await el.evaluate(e=>`${e.name||''} ${e.placeholder||''} ${e.getAttribute('aria-label')||''}`.toLowerCase()).catch(()=> '');
      if (/тираж|draw|number|номер/.test(meta)) { searchInput = el; break; }
    }
    if (searchInput) {
      entry.searches = [];
      for (const draw of TARGETS) {
        await searchInput.fill(String(draw));
        const findButton = page.getByRole('button', {name:/найти|поиск|искать/i}).first();
        if (await findButton.isVisible().catch(()=>false)) {
          await findButton.click();
          await page.waitForTimeout(1800);
          const t = await page.locator('body').innerText().catch(()=> '');
          entry.searches.push({draw, hits:excerpts(t), tail:t.replace(/\s+/g,' ').slice(-2500)});
        }
      }
    }
    result.pages.push(entry);
  }
  result.network = network;
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
