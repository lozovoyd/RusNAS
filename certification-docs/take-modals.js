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

  // Helper: navigate to rusNAS page and wait for iframe content
  async function goPage(url, wait) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(wait || 4000);
  }

  async function shot(name) {
    await page.screenshot({ path: path.join(DIR, name + '.png'), fullPage: false });
    console.log('  saved: ' + name + '.png');
  }

  // We need to interact with content inside Cockpit iframes
  // Cockpit loads plugins in iframes. Let's find the iframe.
  async function getPluginFrame() {
    const frames = page.frames();
    for (const f of frames) {
      const url = f.url();
      if (url.includes('/rusnas/') && !url.includes('cockpit')) return f;
    }
    return null;
  }

  // ============================================================
  // 1. STORAGE — Create Share modal
  // ============================================================
  console.log('\n--- Storage: Create Share Modal ---');
  await goPage('https://10.10.10.72:9090/rusnas/', 5000);
  let frame = await getPluginFrame();
  if (frame) {
    try {
      // Click "+ Создать шару" button
      const btn = await frame.$('button:has-text("Создать шару"), .btn-success:has-text("Создать")');
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1500);
        await shot('20_modal_create_share');
      } else {
        // Try by text content
        const allBtns = await frame.$$('button');
        for (const b of allBtns) {
          const txt = await b.textContent();
          if (txt && txt.includes('Создать шару')) {
            await b.click();
            await page.waitForTimeout(1500);
            await shot('20_modal_create_share');
            break;
          }
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  } else {
    console.log('  no plugin frame found, trying page directly');
    try {
      await page.click('text=Создать шару', { timeout: 3000 });
      await page.waitForTimeout(1500);
      await shot('20_modal_create_share');
    } catch(e) { console.log('  fallback error: ' + e.message); }
  }

  // Close modal by pressing Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ============================================================
  // 2. STORAGE — iSCSI tab
  // ============================================================
  console.log('\n--- Storage: iSCSI tab ---');
  frame = await getPluginFrame();
  if (frame) {
    try {
      const tabs = await frame.$$('.advisor-tab, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('iSCSI')) {
          await t.click();
          await page.waitForTimeout(3000);
          await shot('21_storage_iscsi');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 3. STORAGE — Services tab (FTP+WebDAV)
  // ============================================================
  console.log('\n--- Storage: Services tab ---');
  if (frame) {
    try {
      const tabs = await frame.$$('.advisor-tab, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && (txt.includes('Сервисы') || txt.includes('Services'))) {
          await t.click();
          await page.waitForTimeout(3000);
          await shot('22_storage_services');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 4. DISKS — Create Array modal
  // ============================================================
  console.log('\n--- Disks: Create Array Modal ---');
  await goPage('https://10.10.10.72:9090/rusnas/disks', 5000);
  frame = await getPluginFrame();
  if (frame) {
    try {
      const allBtns = await frame.$$('button');
      for (const b of allBtns) {
        const txt = await b.textContent();
        if (txt && txt.includes('Создать массив')) {
          await b.click();
          await page.waitForTimeout(2000);
          await shot('23_modal_create_raid');
          break;
        }
      }
      // Close modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 5. DISKS — Subvolumes modal
  // ============================================================
  console.log('\n--- Disks: Subvolumes panel ---');
  if (frame) {
    try {
      const allBtns = await frame.$$('button');
      for (const b of allBtns) {
        const txt = await b.textContent();
        if (txt && txt.includes('Субтома')) {
          await b.click();
          await page.waitForTimeout(2000);
          await shot('24_subvolumes');
          break;
        }
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 6. USERS — Create User modal
  // ============================================================
  console.log('\n--- Users: Create User Modal ---');
  await goPage('https://10.10.10.72:9090/rusnas/users', 4000);
  frame = await getPluginFrame();
  if (frame) {
    try {
      const allBtns = await frame.$$('button');
      for (const b of allBtns) {
        const txt = await b.textContent();
        if (txt && txt.includes('Добавить пользователя')) {
          await b.click();
          await page.waitForTimeout(1500);
          await shot('25_modal_create_user');
          break;
        }
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 7. GUARD — Event Log tab
  // ============================================================
  console.log('\n--- Guard: Event Log tab ---');
  await goPage('https://10.10.10.72:9090/rusnas/guard', 8000);
  frame = await getPluginFrame();
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, [role="tab"]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Журнал событий')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('26_guard_events');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 8. GUARD — Settings tab
  // ============================================================
  console.log('\n--- Guard: Settings tab ---');
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, [role="tab"]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Настройки')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('27_guard_settings');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 9. SNAPSHOTS — Schedule tab
  // ============================================================
  console.log('\n--- Snapshots: Schedule tab ---');
  await goPage('https://10.10.10.72:9090/rusnas/snapshots', 5000);
  frame = await getPluginFrame();
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, .snap-tab, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Расписание')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('28_snapshots_schedule');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 10. SNAPSHOTS — Replication tab
  // ============================================================
  console.log('\n--- Snapshots: Replication tab ---');
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, .snap-tab, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Репликация')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('29_snapshots_replication');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 11. NETWORK — Diagnostics tab
  // ============================================================
  console.log('\n--- Network: Diagnostics tab ---');
  await goPage('https://10.10.10.72:9090/rusnas/network', 5000);
  frame = await getPluginFrame();
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Диагностика')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('30_network_diagnostics');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 12. NETWORK — DNS tab
  // ============================================================
  console.log('\n--- Network: DNS tab ---');
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && (txt.includes('DNS') || txt.includes('хосты'))) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('31_network_dns');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 13. ANALYZER — Shares tab
  // ============================================================
  console.log('\n--- Analyzer: Shares tab ---');
  await goPage('https://10.10.10.72:9090/rusnas/storage-analyzer', 5000);
  frame = await getPluginFrame();
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, .sa-tab, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Шары')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('32_analyzer_shares');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 14. ANALYZER — File Types tab
  // ============================================================
  console.log('\n--- Analyzer: File Types tab ---');
  if (frame) {
    try {
      const tabs = await frame.$$('a, button, .tab-btn, .sa-tab, [data-tab]');
      for (const t of tabs) {
        const txt = await t.textContent();
        if (txt && txt.includes('Типы файлов')) {
          await t.click();
          await page.waitForTimeout(2000);
          await shot('33_analyzer_filetypes');
          break;
        }
      }
    } catch(e) { console.log('  error: ' + e.message); }
  }

  // ============================================================
  // 15. DASHBOARD scrolled down — Night Report
  // ============================================================
  console.log('\n--- Dashboard: Night Report (scrolled) ---');
  await goPage('https://10.10.10.72:9090/rusnas/dashboard', 5000);
  // Night report is at the top, let's capture the top part
  await shot('34_dashboard_nightreport');

  // Scroll to bottom cards
  frame = await getPluginFrame();
  if (frame) {
    try {
      await frame.evaluate(() => window.scrollTo(0, 9999));
      await page.waitForTimeout(1500);
      await shot('35_dashboard_bottom');
    } catch(e) { console.log('  error: ' + e.message); }
  }

  await browser.close();
  console.log('\nAll modal screenshots done!');

  // List new files
  const files = fs.readdirSync(DIR).filter(f => f.match(/^(2|3)\d/)).sort();
  console.log('\nNew screenshots:');
  files.forEach(f => {
    const stat = fs.statSync(path.join(DIR, f));
    console.log(`  ${f} (${Math.round(stat.size/1024)}KB)`);
  });
})();
