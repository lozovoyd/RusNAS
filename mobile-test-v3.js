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
    await page.waitForURL(/rusnas|cockpit/, { timeout: 20000 });
    console.log('Logged in');
  } catch (e) {
    console.log('Login skip:', e.message);
  }
}

// Get the plugin iframe (rusnas plugin is in an iframe within Cockpit)
async function getPluginFrame(page) {
  // Cockpit loads the plugin in an iframe
  // Wait for iframes to appear
  await page.waitForTimeout(2000);
  const frames = page.frames();
  console.log('All frames:', frames.map(f => f.url()).join('\n  '));
  // Find the rusnas frame
  const pluginFrame = frames.find(f => f.url().includes('rusnas') || f.url().includes('10.10.10.72:9090/rusnas'));
  return pluginFrame || page.mainFrame();
}

async function deepCheck(frame) {
  return await frame.evaluate(() => {
    const vw = window.innerWidth;
    const issues = [];

    // Horizontal overflow
    const docW = document.documentElement.scrollWidth;
    if (docW > vw + 5) {
      issues.push({ type: 'page_horizontal_overflow', docWidth: docW, viewWidth: vw });
    }

    // Elements overflowing right edge
    document.querySelectorAll('*').forEach(el => {
      if (el.offsetParent === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.right > vw + 10 && rect.width > 20) {
        const tag = el.tagName;
        const cls = (el.className || '').toString().substring(0, 60);
        const id = el.id || '';
        const txt = el.textContent.trim().substring(0, 30);
        // Deduplicate by class
        if (!issues.find(i => i.type === 'overflow_element' && i.cls === cls)) {
          issues.push({ type: 'overflow_element', tag, id, cls, txt, right: Math.round(rect.right), vw });
        }
      }
    });

    // Small interactive touch targets
    document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="radio"], select, a.btn').forEach(el => {
      if (el.offsetParent === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5) return;
      if (rect.height < 32) {
        issues.push({
          type: 'small_touch_target',
          element: el.tagName,
          text: el.textContent.trim().substring(0, 40) || el.getAttribute('type') || '',
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          cls: (el.className || '').toString().substring(0, 60),
        });
      }
    });

    // Clipped text (scrollWidth > clientWidth in cells/headings)
    document.querySelectorAll('th, td').forEach(el => {
      if (el.offsetParent === null) return;
      if (el.scrollWidth > el.clientWidth + 5) {
        issues.push({
          type: 'clipped_cell_text',
          tag: el.tagName,
          text: el.textContent.trim().substring(0, 40),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    });

    // Tables wider than viewport without scroll wrapper
    document.querySelectorAll('table').forEach(table => {
      if (table.offsetParent === null) return;
      const rect = table.getBoundingClientRect();
      if (rect.width <= vw) return;
      // Check parent for overflow:auto/scroll
      let parent = table.parentElement;
      let hasScroll = false;
      while (parent && parent !== document.body) {
        const ow = window.getComputedStyle(parent).overflowX;
        if (ow === 'auto' || ow === 'scroll') { hasScroll = true; break; }
        parent = parent.parentElement;
      }
      issues.push({
        type: 'wide_table',
        tableWidth: Math.round(rect.width),
        vw,
        hasScrollContainer: hasScroll,
        firstHeader: table.querySelector('th') ? table.querySelector('th').textContent.trim().substring(0, 30) : '',
      });
    });

    // Small font (< 11px) in rendered visible text
    const textNodes = [];
    document.querySelectorAll('td, th, p, span, label, .badge, .stat-label, small').forEach(el => {
      if (el.offsetParent === null) return;
      const fs = parseFloat(window.getComputedStyle(el).fontSize);
      if (fs < 11 && el.textContent.trim().length > 3) {
        textNodes.push({
          type: 'tiny_font',
          tag: el.tagName,
          fontSize: fs,
          text: el.textContent.trim().substring(0, 40),
          cls: (el.className || '').toString().substring(0, 50),
        });
      }
    });
    // Deduplicate tiny font by class
    const seen = new Set();
    textNodes.forEach(n => {
      const key = n.cls + n.fontSize;
      if (!seen.has(key)) { seen.add(key); issues.push(n); }
    });

    return issues;
  });
}

async function pageInfo(frame) {
  return await frame.evaluate(() => {
    return {
      title: document.title,
      bodyClass: document.body.className,
      isMobile: /Mobi|Android|iPhone/i.test(navigator.userAgent),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      tabs: Array.from(document.querySelectorAll('[role="tab"], .nav-item, .tab-btn')).map(t => t.textContent.trim()),
    };
  });
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
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await login(page);

  const allResults = {};

  // Helper: navigate + get correct frame
  async function testPage(urlPath, name, extraActions) {
    console.log(`\n=== ${name.toUpperCase()} ===`);
    await page.goto(`${BASE}${urlPath}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);

    const frames = page.frames();
    console.log('Frames:', frames.map(f => f.url()));

    // The rusnas plugin will be in an iframe. Try to find it.
    let targetFrame = page.mainFrame();
    for (const f of frames) {
      if (f.url().includes('/rusnas/') || f.url().includes('rusnas')) {
        // Check if this frame has actual content
        try {
          const hasContent = await f.evaluate(() => document.body && document.body.children.length > 2);
          if (hasContent) { targetFrame = f; break; }
        } catch(e) {}
      }
    }

    // If still on main frame, try to find any frame with content
    if (targetFrame === page.mainFrame() && frames.length > 1) {
      for (const f of frames) {
        if (f === page.mainFrame()) continue;
        try {
          const hasContent = await f.evaluate(() => document.body && document.body.children.length > 2);
          if (hasContent) { targetFrame = f; console.log('Using frame:', f.url()); break; }
        } catch(e) {}
      }
    }

    const info = await pageInfo(targetFrame);
    console.log('Page info:', JSON.stringify(info));

    // Screenshot of viewport
    await page.screenshot({ path: `${OUT}/${name}-viewport.png` });
    // Full page
    await page.screenshot({ path: `${OUT}/${name}-fullpage.png`, fullPage: true });

    const issues = await deepCheck(targetFrame);
    console.log(`Found ${issues.length} issues`);
    if (issues.length > 0) console.log(JSON.stringify(issues, null, 2));

    const result = { info, issues };

    if (extraActions) {
      result.subTests = await extraActions(page, targetFrame, name);
    }

    allResults[name] = result;
    return result;
  }

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  await testPage('/rusnas/dashboard', 'dashboard');

  // ── GUARD ──────────────────────────────────────────────────────────────────
  await testPage('/rusnas/guard', 'guard', async (page, frame, name) => {
    const subResults = {};

    // Try clicking tabs inside the frame
    const tabs = await frame.$$('[role="tab"], .tab-btn, .nav-link');
    console.log(`Found ${tabs.length} tab elements`);

    for (const tab of tabs) {
      const text = await tab.textContent();
      console.log('Tab:', text.trim());
    }

    // Журнал событий
    try {
      await frame.click('text=Журнал событий');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/guard-events.png` });
      subResults.eventsIssues = await deepCheck(frame);
      console.log('Guard events issues:', subResults.eventsIssues.length);
    } catch(e) { console.log('Guard events click err:', e.message); }

    // Настройки
    try {
      await frame.click('text=Настройки');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/guard-settings.png` });
      subResults.settingsIssues = await deepCheck(frame);
      console.log('Guard settings issues:', subResults.settingsIssues.length);
    } catch(e) { console.log('Guard settings click err:', e.message); }

    return subResults;
  });

  // ── SNAPSHOTS ──────────────────────────────────────────────────────────────
  await testPage('/rusnas/snapshots', 'snapshots', async (page, frame, name) => {
    const subResults = {};

    // Scroll to show snapshot list
    await frame.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/snapshots-scrolled.png` });

    // Try Расписание tab
    try {
      await frame.click('text=Расписание');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/snapshots-schedule.png` });
      subResults.scheduleIssues = await deepCheck(frame);
      console.log('Snapshots schedule issues:', subResults.scheduleIssues.length);
    } catch(e) { console.log('Snap schedule click err:', e.message); }

    // Try Репликация tab
    try {
      await frame.click('text=Репликация');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/snapshots-replication.png` });
    } catch(e) { console.log('Snap replication click err:', e.message); }

    // Scroll to snapshot list table
    try {
      await frame.click('text=Снапшоты');
      await page.waitForTimeout(1000);
      await frame.evaluate(() => window.scrollTo(0, 600));
      await page.screenshot({ path: `${OUT}/snapshots-list-table.png` });
      subResults.listTableIssues = await deepCheck(frame);
    } catch(e) {}

    return subResults;
  });

  // ── DISKS ──────────────────────────────────────────────────────────────────
  await testPage('/rusnas/disks', 'disks', async (page, frame, name) => {
    const subResults = {};

    // Scroll down to see physical disks section
    await frame.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/disks-scrolled-600.png` });

    await frame.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/disks-scrolled-1200.png` });

    subResults.scrolledIssues = await deepCheck(frame);
    console.log('Disks scrolled issues:', subResults.scrolledIssues.length);

    // Try to open create RAID modal
    try {
      await frame.click('text=+ Создать массив');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/disks-create-modal.png` });
      subResults.createModalIssues = await deepCheck(frame);
      console.log('Disks create modal issues:', subResults.createModalIssues.length);
      await frame.keyboard.press('Escape');
    } catch(e) { console.log('Disks create modal err:', e.message); }

    return subResults;
  });

  // ── STORAGE ────────────────────────────────────────────────────────────────
  await testPage('/rusnas/', 'storage', async (page, frame, name) => {
    const subResults = {};

    // Scroll down to see all sections
    await frame.evaluate(() => window.scrollTo(0, 800));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/storage-scrolled-800.png` });

    await frame.evaluate(() => window.scrollTo(0, 1600));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/storage-scrolled-1600.png` });

    subResults.issues = await deepCheck(frame);
    console.log('Storage scrolled issues:', subResults.issues.length);
    if (subResults.issues.length > 0) console.log(JSON.stringify(subResults.issues, null, 2));

    return subResults;
  });

  fs.writeFileSync(`${OUT}/deep-results.json`, JSON.stringify(allResults, null, 2));
  console.log('\nAll done. Results in /tmp/mobile-test/deep-results.json');
  await browser.close();
})();
