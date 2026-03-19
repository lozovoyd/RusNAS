const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'test-screenshots', 'mobile-' + Date.now());
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const BASE = 'https://10.10.10.72:9090';

// Direct Cockpit plugin URLs — each page as standalone
const PAGES = [
  { name: 'dashboard',  url: `${BASE}/cockpit/@localhost/rusnas/dashboard.html` },
  { name: 'guard',      url: `${BASE}/cockpit/@localhost/rusnas/guard.html` },
  { name: 'snapshots',  url: `${BASE}/cockpit/@localhost/rusnas/snapshots.html` },
  { name: 'disks',      url: `${BASE}/cockpit/@localhost/rusnas/disks.html` },
  { name: 'storage',    url: `${BASE}/cockpit/@localhost/rusnas/index.html` },
];

async function checkOverflow(page) {
  return await page.evaluate(() => {
    const vw = window.innerWidth;
    const issues = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 3 && rect.width > 0 && rect.height > 0) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const rawCls = el.className && typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
          const cls = rawCls ? '.' + rawCls : '';
          issues.push({
            element: `${tag}${id}${cls}`.substring(0, 80),
            right: Math.round(rect.right),
            overflow: Math.round(rect.right - vw),
            text: el.textContent?.trim().replace(/\s+/g, ' ').substring(0, 60) || ''
          });
        }
      } catch (_) {}
    }
    const seen = new Set();
    return issues
      .filter(i => { if (seen.has(i.element)) return false; seen.add(i.element); return true; })
      .slice(0, 30);
  });
}

async function checkScrollWidth(page) {
  return await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyScrollWidth: document.body?.scrollWidth || 0
  }));
}

async function checkSmallText(page) {
  return await page.evaluate(() => {
    const issues = [];
    const els = document.querySelectorAll('p, span, td, th, label, button, a, li, div');
    for (const el of els) {
      try {
        if (el.children.length > 3) continue; // skip containers
        const style = window.getComputedStyle(el);
        const fs = parseFloat(style.fontSize);
        const text = el.textContent?.trim();
        if (fs > 0 && fs < 11 && text && text.length > 3 && el.offsetWidth > 0 && el.offsetHeight > 0) {
          issues.push({ fontSize: fs, text: text.substring(0, 50), tag: el.tagName });
        }
      } catch (_) {}
    }
    return issues.slice(0, 10);
  });
}

async function checkButtonsAccessible(page) {
  return await page.evaluate(() => {
    const results = [];
    const buttons = document.querySelectorAll('button, .btn, [role="button"]');
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Check minimum tap target size (44x44 recommended for mobile)
      if (rect.height < 32 || rect.width < 32) {
        results.push({
          text: btn.textContent?.trim().substring(0, 40),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      }
    }
    return results.slice(0, 10);
  });
}

async function main() {
  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--no-sandbox']
  });

  // First: get a session cookie by logging in
  const loginCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  });
  const loginPage = await loginCtx.newPage();
  console.log('Logging in to get session...');
  await loginPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await loginPage.waitForSelector('#login-user-input', { timeout: 10000 });
  await loginPage.fill('#login-user-input', 'rusnas');
  await loginPage.fill('#login-password-input', 'kl4389qd');
  await loginPage.click('#login-button');
  await loginPage.waitForFunction(() => !document.querySelector('#login-button'), { timeout: 15000 }).catch(() => {});
  await loginPage.waitForTimeout(2000);
  console.log('Logged in. URL:', loginPage.url());

  // Get all cookies
  const cookies = await loginCtx.cookies();
  console.log('Session cookies:', cookies.map(c => `${c.name}=${c.value.substring(0,10)}...`).join(', '));
  await loginCtx.close();

  // Create mobile context with the session cookies
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true
  });
  await mobileCtx.addCookies(cookies);

  console.log(`\n=== Mobile Test: 390x844 (iPhone 14 Pro) ===`);
  console.log(`Screenshots: ${SCREENSHOTS_DIR}\n`);

  const results = {};

  for (const pg of PAGES) {
    console.log(`\n${'='.repeat(55)}`);
    console.log(`PAGE: ${pg.name}`);
    console.log(`URL: ${pg.url}`);

    const page = await mobileCtx.newPage();
    try {
      await page.goto(pg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Let JS render

      // Viewport screenshot
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${pg.name}-viewport.png`), fullPage: false });
      // Full page screenshot
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${pg.name}-full.png`), fullPage: true });
      console.log(`Screenshots saved`);

      // Page title / body check
      const title = await page.title();
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, ' ').substring(0, 150) || '');
      console.log(`Title: ${title}`);
      console.log(`Body: "${bodySnippet}"`);

      // Checks
      const overflow = await checkOverflow(page);
      const scroll = await checkScrollWidth(page);
      const smallText = await checkSmallText(page);
      const buttons = await checkButtonsAccessible(page);

      // Report scroll
      const scrollOver = scroll.scrollWidth - scroll.viewportWidth;
      console.log(`\nScroll: width=${scroll.scrollWidth} viewport=${scroll.viewportWidth} overflow=${scrollOver}px`);
      if (scrollOver > 5) {
        console.log(`*** HORIZONTAL OVERFLOW: +${scrollOver}px ***`);
      } else {
        console.log('OK: No horizontal scroll');
      }

      // Report overflow elements
      if (overflow.length > 0) {
        console.log(`\nOverflow elements (${overflow.length}):`);
        overflow.forEach(i => {
          console.log(`  [OVERFLOW +${i.overflow}px] ${i.element}`);
          if (i.text) console.log(`    "${i.text}"`);
        });
      } else {
        console.log('OK: No element overflow');
      }

      // Report small text
      if (smallText.length > 0) {
        console.log(`\nSmall text elements (< 11px):`);
        smallText.forEach(i => console.log(`  [${i.fontSize}px] ${i.tag}: "${i.text}"`));
      } else {
        console.log('OK: All text >= 11px');
      }

      // Report small buttons
      if (buttons.length > 0) {
        console.log(`\nSmall tap targets (< 32px):`);
        buttons.forEach(i => console.log(`  [${i.width}x${i.height}] "${i.text}"`));
      } else {
        console.log('OK: All buttons have adequate tap size');
      }

      results[pg.name] = { overflow, scroll, smallText, buttons };

    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results[pg.name] = { error: e.message };
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${pg.name}-error.png`), fullPage: true }).catch(() => {});
    } finally {
      await page.close();
    }
  }

  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n\nDone. Screenshots: ${SCREENSHOTS_DIR}`);
  await browser.close();
}

main().catch(console.error);
