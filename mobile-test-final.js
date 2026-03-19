const { chromium } = require('playwright');

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
    await page.waitForURL(/rusnas|cockpit/, { timeout: 20000 });
  } catch (e) {}
}

async function getFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    if (f === page.mainFrame()) continue;
    try {
      const hasContent = await f.evaluate(() => document.body && document.body.children.length > 2);
      if (hasContent) return f;
    } catch(e) {}
  }
  return page.mainFrame();
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await login(page);

  // 1. Snapshots: scroll to table area
  await page.goto(`${BASE}/rusnas/snapshots`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);
  const snapFrame = await getFrame(page);
  await snapFrame.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/snap-table-area.png` });

  // 2. Snapshots: full scroll to show all action buttons
  await snapFrame.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/snap-action-buttons.png` });

  // 3. Guard events: scroll to show table
  await page.goto(`${BASE}/rusnas/guard`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  const guardFrame = await getFrame(page);
  await guardFrame.click('[data-tab="events"], .tab-btn:nth-child(2)').catch(async () => {
    // Try by text
    const tabs = await guardFrame.$$('.tab-btn, [role="tab"]');
    if (tabs.length >= 2) await tabs[1].click();
  });
  await page.waitForTimeout(2000);
  await guardFrame.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/guard-events-table.png` });

  // 4. Guard settings: scroll to paths table
  await page.goto(`${BASE}/rusnas/guard`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  const guardFrame2 = await getFrame(page);
  const tabs = await guardFrame2.$$('.tab-btn, [role="tab"]');
  if (tabs.length >= 3) await tabs[2].click();
  await page.waitForTimeout(2000);
  await guardFrame2.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/guard-settings-paths.png` });

  // 5. Disks: scroll to physical disks table
  await page.goto(`${BASE}/rusnas/disks`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);
  const disksFrame = await getFrame(page);
  await disksFrame.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/disks-phys-table.png` });

  await disksFrame.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/disks-phys-table2.png` });

  // 6. Storage: scroll to WebDAV / WORM section
  await page.goto(`${BASE}/rusnas/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);
  const stFrame = await getFrame(page);
  await stFrame.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/storage-webdav-section.png` });

  await stFrame.evaluate(() => window.scrollTo(0, 2400));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/storage-worm-section.png` });

  await browser.close();
  console.log('Done');
})();
