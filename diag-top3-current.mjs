import { chromium } from 'playwright';

const EMAIL = process.env.STOLOTO_EMAIL || '';
const PASSWORD = process.env.STOLOTO_PASSWORD || '';
const TARGETS = [267956,267957,267958,267959,267960];
const LOGIN_URL = 'https://oauth.stoloto.ru/login';
const ARCHIVE_URL = 'https://m.stoloto.ru/top3/archive';

async function firstVisible(locators) {
  for (const locator of locators) {
    try { if (await locator.isVisible({timeout:1200})) return locator; } catch {}
  }
  return null;
}

async function login(page) {
  if (!EMAIL || !PASSWORD) throw new Error('missing secrets');
  await page.goto(LOGIN_URL, {waitUntil:'domcontentloaded', timeout:45000});
  await page.waitForTimeout(900);
  const email = await firstVisible([
    page.getByLabel(/телефон или email/i).first(), page.getByLabel(/email/i).first(),
    page.locator('input[type="email"]').first(), page.locator('input[name*="login" i]').first(),
    page.locator('input[name*="email" i]').first()
  ]);
  const pass = await firstVisible([page.getByLabel(/пароль/i).first(), page.locator('input[type="password"]').first()]);
  if (!email || !pass) throw new Error('login fields not found');
  await email.fill(EMAIL); await pass.fill(PASSWORD);
  const submit = await firstVisible([page.getByRole('button',{name:/войти|продолжить/i}).first(), page.locator('button[type="submit"]').first()]);
  if (!submit) throw new Error('submit not found');
  await submit.click(); await page.waitForTimeout(2200);
}

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({locale:'ru-RU', timezoneId:'Europe/Moscow'});
const page = await context.newPage();
const urls = [];
const bodies = [];
page.on('response', async r => {
  try {
    if (!['xhr','fetch'].includes(r.request().resourceType())) return;
    const url = r.url();
    if (!url.includes('stoloto.ru')) return;
    urls.push({status:r.status(), method:r.request().method(), url});
    const text = await r.text();
    if (/267755|267956|267957|267958|267959|267960/.test(text)) {
      bodies.push({url, sample:text.slice(0,12000)});
    }
  } catch {}
});

const result = {targets:TARGETS, filterInputs:[], urlsBeforeClick:[], urlsAfterClick:[], bodies:[], currentTop3:null, afterFilterText:''};
try {
  await login(page);
  await page.goto(`${ARCHIVE_URL}?_diag=${Date.now()}`, {waitUntil:'domcontentloaded', timeout:45000});
  await page.waitForTimeout(2500);

  const current = await page.evaluate(async () => {
    const r = await fetch('/p/api/mobile/api/v35/service/games/info-new', {credentials:'include', cache:'no-store'});
    const j = await r.json();
    const stack = Array.isArray(j) ? j : (j?.data || j?.games || j?.result || []);
    const arr = Array.isArray(stack) ? stack : Object.values(stack || {});
    const game = arr.find(x => x?.name === 'top-3') || arr.find(x => JSON.stringify(x).includes('top-3')) || null;
    return game;
  }).catch(e => ({error:String(e)}));
  result.currentTop3 = current;
  result.urlsBeforeClick = [...urls];

  const filter = page.getByRole('button',{name:/фильтр/i}).first();
  if (await filter.isVisible().catch(()=>false)) {
    await filter.click(); await page.waitForTimeout(500);
    result.filterInputs = await page.locator('input:visible').evaluateAll(els => els.map((e,i)=>({
      i, type:e.type, name:e.name, placeholder:e.placeholder, aria:e.getAttribute('aria-label'),
      parent:(e.parentElement?.innerText||e.parentElement?.textContent||'').trim().replace(/\s+/g,' ').slice(0,250)
    })));
    result.afterFilterText = (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,3500);
  }

  const before = urls.length;
  const oldDraw = page.getByRole('button',{name:/267755/}).first();
  if (await oldDraw.isVisible().catch(()=>false)) {
    await oldDraw.click(); await page.waitForTimeout(1800);
  }
  result.urlsAfterClick = urls.slice(before);
  result.bodies = bodies.slice(-8);
} finally {
  await browser.close();
}
console.log(JSON.stringify(result,null,2));
