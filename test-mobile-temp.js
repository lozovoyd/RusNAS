const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const VIEWPORT = { width: 390, height: 844 };
const BASE_URL = 'https://10.10.10.72:9090';
const USER = 'rusnas';
const PASS = 'kl4389qd';
const SCREENSHOT_DIR = '/tmp/mobile-test';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkOverflow(frame, viewWidth) {
  return await frame.evaluate((vw) => {
    const issues = [];
    const bodyWidth = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
    if (bodyWidth > vw + 5) {
      issues.push(`Horizontal scroll: scrollWidth=${bodyWidth}px > viewport=${vw}px (+${bodyWidth - vw}px overflow)`);
    }
    const seen = new Set();
    Array.from(document.querySelectorAll('*')).forEach(el => {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 10 && rect.width > 10 && rect.height > 0) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).slice(0,2).join('.') : '';
          const key = `${tag}${id}.${cls}`;
          if (!seen.has(key)) {
            seen.add(key);
            issues.push(`  Overflows: <${tag}${id} class="${cls}"> right=${Math.round(rect.right)}px, w=${Math.round(rect.width)}px`);
          }
        }
      } catch(e) {}
    });
    return issues;
  }, viewWidth);
}

async function checkButtons(frame) {
  return await frame.evaluate(() => {
    const issues = [];
    const small = [];
    document.querySelectorAll('button, .btn, [role="button"]').forEach(el => {
      try {
        if (el.offsetParent === null) return;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.height < 30) {
          small.push(`    ${el.tagName.toLowerCase()}${el.id ? '#'+el.id : ''} [${typeof el.className === 'string' ? el.className.split(' ')[0] : ''}] ${Math.round(rect.width)}x${Math.round(rect.height)}px "${el.textContent.trim().substring(0,20)}"`);
        }
      } catch(e) {}
    });
    if (small.length) {
      issues.push(`Buttons < 30px tall (${small.length}):`);
      small.slice(0,8).forEach(b => issues.push(b));
    }
    return issues;
  });
}

async function checkTables(frame, viewWidth) {
  return await frame.evaluate((vw) => {
    const issues = [];
    document.querySelectorAll('table').forEach(table => {
      try {
        if (table.offsetParent === null) return;
        const rect = table.getBoundingClientRect();
        if (rect.width > vw + 5) {
          let parent = table.parentElement;
          let hasScroll = false;
          while (parent) {
            const s = window.getComputedStyle(parent);
            if (s.overflowX === 'auto' || s.overflowX === 'scroll') { hasScroll = true; break; }
            parent = parent.parentElement;
          }
          issues.push(`Table${table.id ? '#'+table.id : ''} w=${Math.round(rect.width)}px > ${vw}px — scroll wrapper: ${hasScroll ? 'YES' : 'MISSING (content cut!)'}`);
        }
      } catch(e) {}
    });
    return issues;
  }, viewWidth);
}

async function getPageInfo(frame) {
  return await frame.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim() || '',
    scrollWidth: document.body.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    tables: document.querySelectorAll('table').length,
    buttons: document.querySelectorAll('button, .btn').length,
  }));
}

async function findPluginFrame(page, pageName) {
  // Wait up to 15 seconds for the iframe to appear
  for (let attempt = 0; attempt < 6; attempt++) {
    const frames = page.frames();
    for (const frame of frames) {
      const furl = frame.url();
      if (furl.includes(`cockpit/@localhost/rusnas/${pageName}`)) {
        return frame;
      }
    }
    console.log(`    Waiting for ${pageName} iframe... (attempt ${attempt+1}/6)`);
    console.log(`    Current frames: ${frames.map(f=>f.url()).join(', ')}`);
    await sleep(2500);
  }
  return null;
}

async function doLogin(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  await page.fill('#login-user-input', USER);
  await page.fill('#login-password-input', PASS);
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    page.click('#login-button')
  ]);
  await sleep(3000);

  // Verify login by checking for Cockpit shell elements
  const sessionBtn = await page.$('button:has-text("Session"), [aria-label="Session"], nav').catch(() => null);
  return !!sessionBtn;
}

const PAGES = [
  { name: 'dashboard', file: 'dashboard.html', nav: '/#/rusnas/dashboard' },
  { name: 'guard',     file: 'guard.html',     nav: '/#/rusnas/guard' },
  { name: 'snapshots', file: 'snapshots.html', nav: '/#/rusnas/snapshots' },
  { name: 'disks',     file: 'disks.html',     nav: '/#/rusnas/disks' },
  { name: 'storage',   file: 'index.html',     nav: '/#/rusnas/' },
];

async function main() {
  console.log('RusNAS Mobile Test — iPhone 14 Pro (390x844)\n');

  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  const results = {};

  console.log('--- LOGIN ---');
  const loggedIn = await doLogin(page);
  console.log(`Login: ${loggedIn ? 'OK' : 'FAILED'}`);
  if (!loggedIn) {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-failed.png') });
    await browser.close();
    return;
  }

  // Navigate to the rusnas plugin once, to warm up the shell
  console.log('\nWarming up Cockpit shell...');
  await page.goto(`${BASE_URL}/#/rusnas/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(8000);
  console.log(`After warmup URL: ${page.url()}`);
  console.log(`Frames: ${page.frames().map(f=>f.url()).join('\n  ')}`);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'warmup.png'), fullPage: false });

  // Test each page
  for (const { name, file, nav } of PAGES) {
    console.log(`\n=== ${name.toUpperCase()} (${file}) ===`);
    try {
      // Navigate to page via hash
      await page.goto(`${BASE_URL}${nav}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(8000);

      // Capture shell screenshot
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-shell.png`), fullPage: true });

      // Try to find the plugin iframe
      let targetFrame = await findPluginFrame(page, file);

      // Fallback: check all frames
      if (!targetFrame) {
        const allFrames = page.frames();
        console.log(`  All frames after waiting:`);
        allFrames.forEach((f, i) => console.log(`    [${i}] ${f.url()}`));

        // Check if the current nav frame has the right content
        // In Cockpit, when you navigate between rusnas pages, the ACTIVE iframe switches
        // Let's try to get the page content from whichever frame seems most relevant
        for (const frame of allFrames) {
          const furl = frame.url();
          if (furl.includes('rusnas') && !furl.includes('updates') && !furl.includes('system')) {
            const info = await getPageInfo(frame).catch(() => null);
            if (info && (info.buttons > 4 || info.tables > 0 || info.scrollHeight > 1000)) {
              console.log(`  Using frame: ${furl}`);
              console.log(`  Info: ${JSON.stringify(info)}`);
              targetFrame = frame;
              break;
            }
          }
        }
      }

      if (!targetFrame) {
        results[name] = { screenshot: `${name}-shell.png`, error: 'plugin iframe not found', issues: [] };
        continue;
      }

      await targetFrame.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(2000);

      const info = await getPageInfo(targetFrame);
      console.log(`  Iframe: ${targetFrame.url()}`);
      console.log(`  title: "${info.title}", scrollW: ${info.scrollWidth}, scrollH: ${info.scrollHeight}`);
      console.log(`  tables: ${info.tables}, buttons: ${info.buttons}`);

      const iframeWidth = 390; // plugin iframes span full width on mobile
      const overflow = await checkOverflow(targetFrame, iframeWidth);
      const buttons = await checkButtons(targetFrame);
      const tables = await checkTables(targetFrame, iframeWidth);
      const allIssues = [...overflow, ...buttons, ...tables];

      results[name] = {
        screenshot: `${name}-shell.png`,
        iframeUrl: targetFrame.url(),
        info: { title: info.title, tables: info.tables, buttons: info.buttons, scrollWidth: info.scrollWidth, scrollHeight: info.scrollHeight },
        issues: allIssues
      };

      if (allIssues.length === 0) console.log(`  PASS: No issues`);
      else {
        console.log(`  Issues (${allIssues.length}):`);
        allIssues.forEach(i => console.log(`    ${i}`));
      }

    } catch(e) {
      console.log(`  ERROR: ${e.message}`);
      results[name] = { screenshot: null, error: e.message, issues: [] };
    }
  }

  await browser.close();

  // Final report
  console.log('\n\n' + '='.repeat(60));
  console.log('MOBILE RESPONSIVENESS REPORT — RusNAS Cockpit Plugin');
  console.log('Viewport: 390x844 (iPhone 14 Pro), isMobile: true');
  console.log('='.repeat(60));
  for (const [name, r] of Object.entries(results)) {
    console.log(`\n## ${name.toUpperCase()}`);
    console.log(`   Screenshot: /tmp/mobile-test/${r.screenshot}`);
    if (r.iframeUrl) console.log(`   Iframe: ${r.iframeUrl}`);
    if (r.info) console.log(`   scrollW:${r.info.scrollWidth} scrollH:${r.info.scrollHeight} tables:${r.info.tables} btns:${r.info.buttons}`);
    if (r.error) { console.log(`   ERROR: ${r.error}`); continue; }
    if (r.issues.length === 0) console.log(`   PASS: No automated issues`);
    else {
      console.log(`   ISSUES (${r.issues.length}):`);
      r.issues.forEach(i => console.log(`   ${i}`));
    }
  }

  fs.writeFileSync('/tmp/mobile-test/results.json', JSON.stringify(results, null, 2));
  console.log('\nSaved: /tmp/mobile-test/results.json');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
