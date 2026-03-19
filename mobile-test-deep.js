const { chromium } = require('playwright');
const fs = require('fs');

const VIEWPORT = { width: 390, height: 844 };
const BASE = 'https://10.10.10.72:9090';
const USER = 'rusnas';
const PASS = 'kl4389qd';
const OUT = '/tmp/mobile-test';

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  try {
    await page.waitForSelector('#login-user-input', { timeout: 10000 });
    await page.fill('#login-user-input', USER);
    await page.fill('#login-password-input', PASS);
    await page.click('#login-button');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
    console.log('Logged in');
  } catch (e) {
    console.log('Login skip:', e.message);
  }
}

async function scrollAndShot(page, name, suffix) {
  await page.screenshot({ path: `${OUT}/${name}-${suffix}.png`, fullPage: true });
}

async function deepCheck(page) {
  return await page.evaluate(() => {
    const vw = window.innerWidth;
    const issues = [];

    // Check all interactive elements min touch target size
    document.querySelectorAll('button, input, select, a, [role="button"], [role="tab"]').forEach(el => {
      if (el.offsetParent === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return; // skip invisible
      if (rect.height < 32 || rect.width < 32) {
        issues.push({
          type: 'small_touch_target',
          element: el.tagName,
          text: el.textContent.trim().substring(0, 40),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          cls: (el.className || '').toString().substring(0, 60),
        });
      }
    });

    // Check text overflow / clipping
    document.querySelectorAll('th, td, .card-title, h1, h2, h3, h4, h5, label').forEach(el => {
      if (el.offsetParent === null) return;
      if (el.scrollWidth > el.clientWidth + 3) {
        issues.push({
          type: 'text_clipped',
          element: el.tagName,
          text: el.textContent.trim().substring(0, 40),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          cls: (el.className || '').toString().substring(0, 60),
        });
      }
    });

    // Check elements bleeding outside container
    document.querySelectorAll('.toolbar, .section-toolbar, .page-section, .card, .modal').forEach(el => {
      if (el.offsetParent === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.right > vw + 2) {
        issues.push({
          type: 'overflow_right',
          element: el.tagName,
          cls: (el.className || '').toString().substring(0, 80),
          right: Math.round(rect.right),
          vw,
        });
      }
    });

    // Check if toolbar buttons are stacked or overflow
    document.querySelectorAll('.section-toolbar, .toolbar-actions').forEach(el => {
      const rect = el.getBoundingClientRect();
      const buttons = el.querySelectorAll('button');
      const overflowButtons = [];
      buttons.forEach(btn => {
        const br = btn.getBoundingClientRect();
        if (br.right > vw + 2) overflowButtons.push(btn.textContent.trim().substring(0, 30));
      });
      if (overflowButtons.length > 0) {
        issues.push({ type: 'toolbar_overflow', buttons: overflowButtons });
      }
    });

    // Table column headers
    document.querySelectorAll('table thead th').forEach(th => {
      if (th.offsetParent === null) return;
      const fs = parseFloat(window.getComputedStyle(th).fontSize);
      if (fs < 10) {
        issues.push({
          type: 'very_small_header',
          text: th.textContent.trim(),
          fontSize: fs,
        });
      }
    });

    // Check font size of body text
    document.querySelectorAll('td, p, .stat-value, .badge').forEach(el => {
      if (el.offsetParent === null) return;
      const fs = parseFloat(window.getComputedStyle(el).fontSize);
      if (fs < 10 && el.textContent.trim().length > 0) {
        issues.push({
          type: 'tiny_text',
          element: el.tagName,
          text: el.textContent.trim().substring(0, 40),
          fontSize: fs,
          cls: (el.className || '').toString().substring(0, 50),
        });
      }
    });

    return issues;
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await login(page);

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  console.log('\n=== DASHBOARD ===');
  await page.goto(`${BASE}/rusnas/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await scrollAndShot(page, 'dashboard', 'full');
  const dashIssues = await deepCheck(page);
  console.log('Issues:', JSON.stringify(dashIssues, null, 2));

  // ── GUARD ──────────────────────────────────────────────────────────────────
  console.log('\n=== GUARD ===');
  await page.goto(`${BASE}/rusnas/guard`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await scrollAndShot(page, 'guard', 'full');
  const guardIssues = await deepCheck(page);
  console.log('Issues:', JSON.stringify(guardIssues, null, 2));

  // Click "Журнал событий" tab
  try {
    await page.click('text=Журнал событий');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/guard-events-tab.png` });
    const guardEventsIssues = await deepCheck(page);
    console.log('Guard Events tab issues:', JSON.stringify(guardEventsIssues, null, 2));
  } catch(e) { console.log('Guard events tab error:', e.message); }

  // Click "Настройки" tab
  try {
    await page.click('text=Настройки');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/guard-settings-tab.png` });
    const guardSettingsIssues = await deepCheck(page);
    console.log('Guard Settings tab issues:', JSON.stringify(guardSettingsIssues, null, 2));
  } catch(e) { console.log('Guard settings tab error:', e.message); }

  // ── SNAPSHOTS ──────────────────────────────────────────────────────────────
  console.log('\n=== SNAPSHOTS ===');
  await page.goto(`${BASE}/rusnas/snapshots`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await scrollAndShot(page, 'snapshots', 'full');
  const snapIssues = await deepCheck(page);
  console.log('Issues:', JSON.stringify(snapIssues, null, 2));

  // Click "Расписание" tab
  try {
    await page.click('text=Расписание');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/snapshots-schedule-tab.png` });
    const snapSchedIssues = await deepCheck(page);
    console.log('Snapshots Schedule tab issues:', JSON.stringify(snapSchedIssues, null, 2));
  } catch(e) { console.log('Snapshot schedule tab error:', e.message); }

  // Click "+ Создать снапшот" to check modal
  try {
    await page.click('text=+ Создать снапшот');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/snapshots-create-modal.png` });
    const snapModalIssues = await deepCheck(page);
    console.log('Snapshots create modal issues:', JSON.stringify(snapModalIssues, null, 2));
    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch(e) { console.log('Snapshot create modal error:', e.message); }

  // ── DISKS ──────────────────────────────────────────────────────────────────
  console.log('\n=== DISKS ===');
  await page.goto(`${BASE}/rusnas/disks`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await scrollAndShot(page, 'disks', 'full');
  const diskIssues = await deepCheck(page);
  console.log('Issues:', JSON.stringify(diskIssues, null, 2));

  // ── STORAGE ────────────────────────────────────────────────────────────────
  console.log('\n=== STORAGE ===');
  await page.goto(`${BASE}/rusnas/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await scrollAndShot(page, 'storage', 'full');
  const storageIssues = await deepCheck(page);
  console.log('Issues:', JSON.stringify(storageIssues, null, 2));

  await browser.close();
  console.log('\nDone. Screenshots in /tmp/mobile-test/');
})();
