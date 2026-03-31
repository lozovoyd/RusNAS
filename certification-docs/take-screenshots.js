const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PAGES = [
  { name: '01_login', url: 'https://10.10.10.72:9090/', wait: 2000 },
  { name: '02_dashboard', url: 'https://10.10.10.72:9090/rusnas/dashboard', wait: 5000, needLogin: true },
  { name: '03_storage_shares', url: 'https://10.10.10.72:9090/rusnas/', wait: 4000 },
  { name: '04_disks_raid', url: 'https://10.10.10.72:9090/rusnas/disks', wait: 5000 },
  { name: '05_users', url: 'https://10.10.10.72:9090/rusnas/users', wait: 4000 },
  { name: '06_guard', url: 'https://10.10.10.72:9090/rusnas/guard', wait: 8000 },
  { name: '07_snapshots', url: 'https://10.10.10.72:9090/rusnas/snapshots', wait: 5000 },
  { name: '08_dedup', url: 'https://10.10.10.72:9090/rusnas/dedup', wait: 5000 },
  { name: '09_ups', url: 'https://10.10.10.72:9090/rusnas/ups', wait: 5000 },
  { name: '10_analyzer', url: 'https://10.10.10.72:9090/rusnas/storage-analyzer', wait: 5000 },
  { name: '11_network', url: 'https://10.10.10.72:9090/rusnas/network', wait: 5000 },
  { name: '12_ai', url: 'https://10.10.10.72:9090/rusnas/ai', wait: 4000 },
  { name: '13_performance', url: 'https://10.10.10.72:9090/rusnas/performance', wait: 5000 },
];

(async () => {
  const dir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 900 },
  });
  const page = await context.newPage();

  // Login page screenshot
  console.log('Taking: 01_login');
  await page.goto('https://10.10.10.72:9090/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(dir, '01_login.png'), fullPage: false });

  // Login
  console.log('Logging in...');
  await page.fill('#login-user-input', 'rusnas');
  await page.fill('#login-password-input', 'kl4389qd');
  await page.click('#login-button');
  await page.waitForTimeout(5000);

  // Dashboard
  for (const pg of PAGES.slice(1)) {
    console.log('Taking: ' + pg.name);
    try {
      await page.goto(pg.url, { waitUntil: 'networkidle', timeout: 20000 });
    } catch(e) {
      await page.goto(pg.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(pg.wait);
    await page.screenshot({ path: path.join(dir, pg.name + '.png'), fullPage: false });
    console.log('  saved: ' + pg.name + '.png');
  }

  await browser.close();
  console.log('\nAll screenshots saved to: ' + dir);
})();
