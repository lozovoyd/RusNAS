const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'screenshots');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();

  // Login
  console.log('Logging in...');
  await page.goto('https://10.10.10.72:9090/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.fill('#login-user-input', 'rusnas');
  await page.fill('#login-password-input', 'kl4389qd');
  await page.click('#login-button');
  await page.waitForTimeout(5000);

  async function shot(name) {
    await page.screenshot({ path: path.join(DIR, name + '.png'), fullPage: false });
    console.log('  saved: ' + name);
  }

  // Helper: find the deeply nested plugin frame
  function findDeepFrame(page, match) {
    const all = page.frames();
    for (const f of all) {
      if (f.url().includes(match)) return f;
    }
    return null;
  }

  async function goAndWait(url, match, waitMs) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(waitMs || 5000);
    // List all frames for debug
    const frames = page.frames();
    console.log('  frames: ' + frames.map(f => f.url().split('/').slice(-2).join('/')).join(' | '));
    return findDeepFrame(page, match);
  }

  // ============================================================
  // STORAGE PAGE
  // ============================================================
  console.log('\n--- Storage page ---');
  let frame = await goAndWait('https://10.10.10.72:9090/rusnas/', 'rusnas/index', 5000);

  if (frame) {
    console.log('  Found plugin frame!');

    // Create Share modal
    try {
      const createBtn = await frame.$('#btn-create-share, button.btn-success');
      if (createBtn) {
        await createBtn.click();
        await page.waitForTimeout(1500);
        await shot('20_modal_create_share');
        // Close
        const closeBtn = await frame.$('.modal .close, .modal-close, button:has-text("Отмена")');
        if (closeBtn) await closeBtn.click();
        else await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      } else {
        console.log('  create share btn not found');
      }
    } catch(e) { console.log('  ' + e.message.slice(0, 80)); }

    // iSCSI tab
    try {
      const iscsiTab = await frame.$('[data-tab="iscsi"], .advisor-tab:nth-child(2)');
      if (iscsiTab) {
        await iscsiTab.click();
        await page.waitForTimeout(3000);
        await shot('21_storage_iscsi');
      } else {
        // try by evaluating JS in frame
        await frame.evaluate(() => {
          const tabs = document.querySelectorAll('.advisor-tab');
          tabs.forEach(t => { if (t.textContent.includes('iSCSI')) t.click(); });
        });
        await page.waitForTimeout(3000);
        await shot('21_storage_iscsi');
      }
    } catch(e) { console.log('  iscsi: ' + e.message.slice(0, 80)); }

    // Services tab
    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.advisor-tab');
        tabs.forEach(t => { if (t.textContent.includes('Сервис')) t.click(); });
      });
      await page.waitForTimeout(3000);
      await shot('22_storage_services');
    } catch(e) { console.log('  services: ' + e.message.slice(0, 80)); }

    // WORM tab
    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.advisor-tab');
        tabs.forEach(t => { if (t.textContent.includes('WORM')) t.click(); });
      });
      await page.waitForTimeout(3000);
      await shot('22b_storage_worm');
    } catch(e) { console.log('  worm: ' + e.message.slice(0, 80)); }

  } else {
    console.log('  Plugin frame not found');
  }

  // ============================================================
  // DISKS PAGE
  // ============================================================
  console.log('\n--- Disks page ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/disks', 'rusnas/disks', 6000);

  if (frame) {
    // Create RAID modal
    try {
      await frame.evaluate(() => {
        const btns = document.querySelectorAll('button');
        btns.forEach(b => { if (b.textContent.includes('Создать массив')) b.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('23_modal_create_raid');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch(e) { console.log('  create raid: ' + e.message.slice(0, 80)); }

    // Subvolumes
    try {
      await frame.evaluate(() => {
        const btns = document.querySelectorAll('button');
        btns.forEach(b => { if (b.textContent.includes('Субтома')) b.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('24_subvolumes');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch(e) { console.log('  subvol: ' + e.message.slice(0, 80)); }

    // Scroll to SSD caching section
    try {
      await frame.evaluate(() => window.scrollTo(0, 9999));
      await page.waitForTimeout(1000);
      await shot('24b_disks_ssd_section');
    } catch(e) { console.log('  ssd: ' + e.message.slice(0, 80)); }
  }

  // ============================================================
  // USERS PAGE
  // ============================================================
  console.log('\n--- Users page ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/users', 'rusnas/users', 4000);

  if (frame) {
    try {
      await frame.evaluate(() => {
        const btns = document.querySelectorAll('button');
        btns.forEach(b => { if (b.textContent.includes('Добавить пользователя')) b.click(); });
      });
      await page.waitForTimeout(1500);
      await shot('25_modal_create_user');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch(e) { console.log('  ' + e.message.slice(0, 80)); }
  }

  // ============================================================
  // GUARD TABS
  // ============================================================
  console.log('\n--- Guard tabs ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/guard', 'rusnas/guard', 8000);

  if (frame) {
    // Events tab
    try {
      await frame.evaluate(() => {
        const links = document.querySelectorAll('a, .tab-btn, [data-tab]');
        links.forEach(l => { if (l.textContent.includes('Журнал событий')) l.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('26_guard_events');
    } catch(e) { console.log('  events: ' + e.message.slice(0, 80)); }

    // Settings tab
    try {
      await frame.evaluate(() => {
        const links = document.querySelectorAll('a, .tab-btn, [data-tab]');
        links.forEach(l => { if (l.textContent.includes('Настройки')) l.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('27_guard_settings');
    } catch(e) { console.log('  settings: ' + e.message.slice(0, 80)); }
  }

  // ============================================================
  // SNAPSHOTS TABS
  // ============================================================
  console.log('\n--- Snapshots tabs ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/snapshots', 'rusnas/snapshots', 5000);

  if (frame) {
    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.snap-tab, .advisor-tab, a, button');
        tabs.forEach(t => { if (t.textContent.trim() === 'Расписание') t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('28_snapshots_schedule');
    } catch(e) { console.log('  schedule: ' + e.message.slice(0, 80)); }

    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.snap-tab, .advisor-tab, a, button');
        tabs.forEach(t => { if (t.textContent.trim() === 'Репликация') t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('29_snapshots_replication');
    } catch(e) { console.log('  replication: ' + e.message.slice(0, 80)); }
  }

  // ============================================================
  // NETWORK TABS
  // ============================================================
  console.log('\n--- Network tabs ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/network', 'rusnas/network', 5000);

  if (frame) {
    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.net-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.includes('DNS')) t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('31_network_dns');
    } catch(e) { console.log('  dns: ' + e.message.slice(0, 80)); }

    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.net-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.includes('Диагностика')) t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('30_network_diagnostics');
    } catch(e) { console.log('  diag: ' + e.message.slice(0, 80)); }

    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.net-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.includes('Маршруты')) t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('31b_network_routes');
    } catch(e) { console.log('  routes: ' + e.message.slice(0, 80)); }
  }

  // ============================================================
  // ANALYZER TABS
  // ============================================================
  console.log('\n--- Analyzer tabs ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/storage-analyzer', 'rusnas/storage-analyzer', 5000);

  if (frame) {
    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.sa-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.trim() === 'Шары') t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('32_analyzer_shares');
    } catch(e) { console.log('  shares: ' + e.message.slice(0, 80)); }

    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.sa-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.includes('Папки')) t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('32b_analyzer_files');
    } catch(e) { console.log('  files: ' + e.message.slice(0, 80)); }

    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.sa-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.includes('Типы файлов')) t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('33_analyzer_filetypes');
    } catch(e) { console.log('  filetypes: ' + e.message.slice(0, 80)); }

    try {
      await frame.evaluate(() => {
        const tabs = document.querySelectorAll('.sa-tab, .tab-btn, a, button');
        tabs.forEach(t => { if (t.textContent.includes('Пользователи')) t.click(); });
      });
      await page.waitForTimeout(2000);
      await shot('33b_analyzer_users');
    } catch(e) { console.log('  users: ' + e.message.slice(0, 80)); }
  }

  // ============================================================
  // DEDUP - scrolled
  // ============================================================
  console.log('\n--- Dedup page full ---');
  frame = await goAndWait('https://10.10.10.72:9090/rusnas/dedup', 'rusnas/dedup', 5000);
  if (frame) {
    try {
      await frame.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1000);
    } catch(e) {}
  }
  await shot('08_dedup'); // re-take with content loaded

  await browser.close();

  // List all screenshots
  const files = fs.readdirSync(DIR).sort();
  console.log('\nAll screenshots (' + files.length + '):');
  files.forEach(f => {
    const stat = fs.statSync(path.join(DIR, f));
    console.log(`  ${f} (${Math.round(stat.size/1024)}KB)`);
  });
})();
