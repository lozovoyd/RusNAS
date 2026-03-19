const { chromium } = require('playwright');
const path = require('path');

const VIEWPORT = { width: 390, height: 844 };
const BASE = 'https://10.10.10.72:9090';
const USER = 'rusnas';
const PASS = 'kl4389qd';
const OUT = '/tmp/mobile-test';

const PAGES = [
  { name: 'dashboard',  url: `${BASE}/rusnas/dashboard` },
  { name: 'guard',      url: `${BASE}/rusnas/guard` },
  { name: 'snapshots',  url: `${BASE}/rusnas/snapshots` },
  { name: 'disks',      url: `${BASE}/rusnas/disks` },
  { name: 'storage',    url: `${BASE}/rusnas/` },
];

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  // Accept any SSL certificate warning (handled via ignoreHTTPSErrors)
  // Fill login form
  try {
    await page.waitForSelector('#login-user-input', { timeout: 10000 });
    await page.fill('#login-user-input', USER);
    await page.fill('#login-password-input', PASS);
    await page.click('#login-button');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
    console.log('Logged in successfully');
  } catch (e) {
    console.log('Login step skipped or already logged in:', e.message);
  }
}

async function measureOverflow(page) {
  // Check for horizontal scroll / overflow
  const result = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewWidth = window.innerWidth;
    const overflowElements = [];

    // Find elements wider than viewport
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > viewWidth + 5) {
        overflowElements.push({
          tag: el.tagName,
          id: el.id || '',
          className: (el.className || '').toString().substring(0, 80),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          viewWidth,
        });
      }
    });

    return {
      docWidth,
      viewWidth,
      hasHorizontalScroll: docWidth > viewWidth,
      overflowElements: overflowElements.slice(0, 20), // top 20
    };
  });
  return result;
}

async function measureSmallText(page) {
  // Find text elements with font-size < 11px
  const result = await page.evaluate(() => {
    const small = [];
    document.querySelectorAll('p, span, td, th, label, button, a, h1, h2, h3, h4, li').forEach(el => {
      if (el.offsetParent === null) return; // hidden
      const fs = parseFloat(window.getComputedStyle(el).fontSize);
      if (fs < 11 && el.textContent.trim().length > 0) {
        small.push({
          tag: el.tagName,
          fontSize: fs,
          text: el.textContent.trim().substring(0, 60),
          className: (el.className || '').toString().substring(0, 50),
        });
      }
    });
    return small.slice(0, 15);
  });
  return result;
}

async function measureSmallButtons(page) {
  // Find buttons/controls with height < 36px (too small to tap on mobile)
  const result = await page.evaluate(() => {
    const small = [];
    document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a.btn, .btn').forEach(el => {
      if (el.offsetParent === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.height < 36 && rect.width > 0) {
        small.push({
          tag: el.tagName,
          text: el.textContent.trim().substring(0, 40),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          className: (el.className || '').toString().substring(0, 60),
        });
      }
    });
    return small.slice(0, 15);
  });
  return result;
}

async function checkTables(page) {
  // Check if tables overflow without scroll container
  const result = await page.evaluate(() => {
    const issues = [];
    document.querySelectorAll('table').forEach(table => {
      const tableRect = table.getBoundingClientRect();
      const parent = table.parentElement;
      const parentStyle = parent ? window.getComputedStyle(parent) : null;
      const hasScroll = parentStyle && (
        parentStyle.overflowX === 'auto' ||
        parentStyle.overflowX === 'scroll' ||
        parentStyle.overflow === 'auto' ||
        parentStyle.overflow === 'scroll'
      );

      if (tableRect.width > window.innerWidth + 5) {
        issues.push({
          tableWidth: Math.round(tableRect.width),
          viewWidth: window.innerWidth,
          hasScrollContainer: hasScroll,
          parentClass: parent ? (parent.className || '').toString().substring(0, 60) : '',
          firstHeading: table.querySelector('th') ? table.querySelector('th').textContent.trim().substring(0, 30) : '',
        });
      }
    });
    return issues;
  });
  return result;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--disable-web-security'],
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });

  const page = await context.newPage();

  // Login first
  await login(page);

  const results = {};

  for (const pageInfo of PAGES) {
    console.log(`\n=== Testing: ${pageInfo.name} (${pageInfo.url}) ===`);

    try {
      await page.goto(pageInfo.url, { waitUntil: 'networkidle', timeout: 30000 });
      // Wait extra for dynamic content to load
      await page.waitForTimeout(3000);

      const screenshotPath = `${OUT}/${pageInfo.name}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`Screenshot saved: ${screenshotPath}`);

      // Also take full-page screenshot
      const fullScreenshotPath = `${OUT}/${pageInfo.name}-full.png`;
      await page.screenshot({ path: fullScreenshotPath, fullPage: true });

      const overflow = await measureOverflow(page);
      const smallText = await measureSmallText(page);
      const smallButtons = await measureSmallButtons(page);
      const tableIssues = await checkTables(page);

      results[pageInfo.name] = {
        url: pageInfo.url,
        screenshot: screenshotPath,
        overflow,
        smallText,
        smallButtons,
        tableIssues,
      };

      console.log('Overflow:', JSON.stringify(overflow, null, 2));
      console.log('Small text:', JSON.stringify(smallText, null, 2));
      console.log('Small buttons:', JSON.stringify(smallButtons, null, 2));
      console.log('Table issues:', JSON.stringify(tableIssues, null, 2));

    } catch (e) {
      console.log(`ERROR on ${pageInfo.name}:`, e.message);
      results[pageInfo.name] = { error: e.message };
    }
  }

  // Save summary
  const fs = require('fs');
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log('\nAll results saved to /tmp/mobile-test/results.json');

  await browser.close();
})();
