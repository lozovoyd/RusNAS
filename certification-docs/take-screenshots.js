#!/usr/bin/env node
/**
 * rusNAS Screenshot Capture v2 — Playwright
 * Takes 34+ screenshots of all Cockpit pages WITH admin access.
 * Uses data-tab attributes for reliable tab switching.
 */
const { chromium } = require('playwright');
const path = require('path');

const COCKPIT = 'http://10.10.10.72:9090';
const PLUGIN = `${COCKPIT}/cockpit/@localhost/rusnas`;
const OUT = path.join(__dirname, 'screenshots');
const USER = 'rusnas';
const PASS = 'kl4389qd';

let page, browser;

// Get the rusnas plugin frame (iframe name is empty string)
function pluginFrame() {
  const frames = page.frames();
  for (const f of frames) {
    if (f.url().includes('rusnas/')) return f;
  }
  return null;
}

async function screenshot(filename) {
  const frame = pluginFrame();
  if (frame) {
    try {
      const body = frame.locator('body');
      await body.screenshot({ path: path.join(OUT, filename) });
      console.log(`  ✓ ${filename}`);
      return;
    } catch {}
  }
  await page.screenshot({ path: path.join(OUT, filename) });
  console.log(`  ✓ ${filename} (fullpage)`);
}

async function goTo(pageName) {
  await page.goto(`${PLUGIN}/${pageName}.html`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
}

async function clickDataTab(tabId) {
  const frame = pluginFrame();
  if (!frame) { console.log(`    ✗ No frame for tab ${tabId}`); return; }
  try {
    await frame.locator(`[data-tab="${tabId}"]`).first().click();
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`    ⚠ Tab [data-tab="${tabId}"] click failed`);
  }
}

async function clickBtnText(text) {
  const frame = pluginFrame();
  if (!frame) return false;
  try {
    const btn = frame.locator(`button:has-text("${text}"), a:has-text("${text}"), .btn:has-text("${text}")`).first();
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.click();
      await page.waitForTimeout(1500);
      return true;
    }
  } catch {}
  console.log(`    ⚠ Button "${text}" not found`);
  return false;
}

async function scrollTo(position) {
  const frame = pluginFrame();
  if (!frame) return;
  try {
    if (position === 'bottom') {
      await frame.locator('body').evaluate(el => el.scrollTo(0, el.scrollHeight));
    } else if (position === 'middle') {
      await frame.locator('body').evaluate(el => el.scrollTo(0, el.scrollHeight / 2));
    } else if (position === 'top') {
      await frame.locator('body').evaluate(el => el.scrollTo(0, 0));
    }
    await page.waitForTimeout(1000);
  } catch {}
}

async function pressEscape() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

async function run() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  rusNAS Screenshot Capture v2            ║');
  console.log('║  Admin access + data-tab selectors       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  page = await ctx.newPage();

  // 01: Login screen
  console.log('▸ Login...');
  await page.goto(COCKPIT, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, '01_login.png') });
  console.log('  ✓ 01_login.png');

  // Login
  await page.fill('#login-user-input', USER);
  await page.fill('#login-password-input', PASS);
  await page.click('#login-button');
  await page.waitForTimeout(3000);
  console.log('  ✓ Logged in');

  // Enable admin
  console.log('▸ Admin access...');
  try {
    const btn = page.locator('button:has-text("Limited access"), button:has-text("Ограниченный доступ")').first();
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click();
      await page.waitForTimeout(1000);
      await page.locator('input[type="password"]').first().fill(PASS);
      await page.waitForTimeout(300);
      await page.locator('button:has-text("Authenticate"), button:has-text("Аутентификация")').first().click();
      await page.waitForTimeout(2000);
      console.log('  ✓ Admin enabled');
    } else {
      console.log('  ○ Already admin');
    }
  } catch (e) { console.log('  ⚠ ' + e.message.substring(0, 60)); }

  // ── Dashboard ──
  console.log('\n▸ [02] Dashboard');
  await goTo('dashboard');
  await page.waitForTimeout(2000);
  await screenshot('02_dashboard.png');
  await scrollTo('middle');
  await screenshot('34_dashboard_nightreport.png');
  await scrollTo('bottom');
  await screenshot('35_dashboard_bottom.png');

  // ── Storage ──
  console.log('▸ [03] Storage - Shares');
  await goTo('index');
  await screenshot('03_storage_shares.png');

  // Modal create share
  if (await clickBtnText('Создать')) {
    await screenshot('20_modal_create_share.png');
    await pressEscape();
  } else {
    await screenshot('20_modal_create_share.png');
  }

  console.log('▸ [21] Storage - iSCSI');
  await clickDataTab('iscsi');
  await screenshot('21_storage_iscsi.png');

  console.log('▸ [22b] Storage - WORM');
  await clickDataTab('worm');
  await screenshot('22b_storage_worm.png');

  console.log('▸ [22] Storage - Services');
  await clickDataTab('services');
  await screenshot('22_storage_services.png');

  // ── Disks ──
  console.log('▸ [04] Disks & RAID');
  await goTo('disks');
  await screenshot('04_disks_raid.png');

  if (await clickBtnText('Создать массив')) {
    await screenshot('23_modal_create_raid.png');
    await pressEscape();
  } else {
    await screenshot('23_modal_create_raid.png');
  }

  await scrollTo('middle');
  await screenshot('24_subvolumes.png');
  await scrollTo('bottom');
  await screenshot('24b_disks_ssd_section.png');

  // ── Users ──
  console.log('▸ [05] Users');
  await goTo('users');
  await screenshot('05_users.png');
  if (await clickBtnText('Добавить')) {
    await screenshot('25_modal_create_user.png');
    await pressEscape();
  } else {
    await screenshot('25_modal_create_user.png');
  }

  // ── Guard ──
  console.log('▸ [06] Guard');
  await goTo('guard');
  await screenshot('06_guard.png');
  await clickDataTab('events');
  await screenshot('26_guard_events.png');
  await clickDataTab('settings');
  await screenshot('27_guard_settings.png');

  // ── Snapshots ──
  console.log('▸ [07] Snapshots');
  await goTo('snapshots');
  await screenshot('07_snapshots.png');
  await clickDataTab('schedule');
  await screenshot('28_snapshots_schedule.png');
  await clickDataTab('replication');
  await screenshot('29_snapshots_replication.png');

  // ── Dedup ──
  console.log('▸ [08] Dedup');
  await goTo('dedup');
  await screenshot('08_dedup.png');

  // ── UPS ──
  console.log('▸ [09] UPS');
  await goTo('ups');
  await screenshot('09_ups.png');

  // ── Storage Analyzer ──
  console.log('▸ [10] Analyzer');
  await goTo('storage-analyzer');
  await screenshot('10_analyzer.png');
  await clickDataTab('shares');
  await screenshot('32_analyzer_shares.png');
  await clickDataTab('files');
  await screenshot('32b_analyzer_files.png');
  await clickDataTab('users');
  await screenshot('33b_analyzer_users.png');
  await clickDataTab('types');
  await screenshot('33_analyzer_filetypes.png');

  // ── Network ──
  console.log('▸ [11] Network');
  await goTo('network');
  await screenshot('11_network.png');
  await clickDataTab('dns');
  await screenshot('31_network_dns.png');
  await clickDataTab('routes');
  await screenshot('31b_network_routes.png');
  await clickDataTab('diagnostics');
  await screenshot('30_network_diagnostics.png');

  // ── AI ──
  console.log('▸ [12] AI');
  await goTo('ai');
  await screenshot('12_ai.png');

  // ── Performance ──
  console.log('▸ [13] Performance');
  await goTo('performance');
  await screenshot('13_performance.png');

  await browser.close();

  const fs = require('fs');
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png'));
  const totalKB = files.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0) / 1024;
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  ✓ ${files.length} screenshots (${(totalKB/1024).toFixed(1)} MB)             ║`);
  console.log(`╚══════════════════════════════════════════╝`);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
