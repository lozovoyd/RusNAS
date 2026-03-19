const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'test-screenshots', 'ssd-tier');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 }
  });

  const consoleErrors = [];
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push('PAGE ERROR: ' + err.message);
  });

  const log = (msg) => console.log('[TEST] ' + msg);
  const ss = async (name) => {
    const p = path.join(SCREENSHOTS_DIR, name + '.png');
    await page.screenshot({ path: p, fullPage: false });
    log('Screenshot saved: ' + name + '.png');
  };

  try {
    // Step 1: Login
    log('Navigating to Cockpit login...');
    await page.goto('http://10.10.10.72:9090', { waitUntil: 'networkidle', timeout: 30000 });
    await ss('01-login-page');

    log('Logging in...');
    await page.fill('#login-user-input', 'rusnas');
    await page.fill('#login-password-input', 'kl4389qd');
    await page.click('#login-button');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
    await ss('02-after-login');
    log('Logged in. URL: ' + page.url());

    // Step 2: Navigate to disks.html
    log('Navigating to disks.html...');
    await page.goto('http://10.10.10.72:9090/cockpit/@localhost/rusnas/disks.html', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    await page.waitForTimeout(3000);
    await ss('03-disks-page');
    log('Disks page loaded. URL: ' + page.url());

    // Step 3: Check for SSD-кеширование section
    log('Checking for SSD-кеширование section...');
    const ssdSection = await page.$('#ssd-tier-section');
    if (ssdSection) {
      log('SSD-кеширование section found!');
      const isVisible = await ssdSection.isVisible();
      log('Section visible: ' + isVisible);
    } else {
      log('ERROR: SSD-кеширование section NOT found in DOM');
    }

    // Scroll to SSD section
    if (ssdSection) {
      await ssdSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await ss('04-ssd-section');
    }

    // Check the table empty state
    const tbodyText = await page.$eval('#ssd-tiers-body', el => el.textContent.trim()).catch(() => 'NOT FOUND');
    log('SSD tiers tbody content: ' + tbodyText.substring(0, 100));

    // Step 4: Click "+ Добавить SSD-кеш" button
    log('Looking for "+ Добавить SSD-кеш" button...');
    const addBtn = await page.$('#btn-add-ssd-tier');
    if (addBtn) {
      log('Button found, clicking...');
      await addBtn.click();
      await page.waitForTimeout(2000);
      await ss('05-modal-open');

      // Check modal visibility
      const modal = await page.$('#modal-add-ssd-tier');
      if (modal) {
        const modalVisible = await modal.isVisible();
        log('Modal visible: ' + modalVisible);

        // Check modal elements
        const backingSelect = await page.$('#ssd-backing-dev');
        const cacheSelect = await page.$('#ssd-cache-dev');
        const modeWt = await page.$('#ssd-mode-wt');
        const modeWb = await page.$('#ssd-mode-wb');
        const writebackWarn = await page.$('#ssd-writeback-warn');
        const backupWarn = await page.$('#ssd-backup-confirm');

        log('Backing device select found: ' + !!backingSelect);
        log('Cache device select found: ' + !!cacheSelect);
        log('Writethrough radio found: ' + !!modeWt);
        log('Writeback radio found: ' + !!modeWb);
        log('Writeback warning block found: ' + !!writebackWarn);
        log('Backup confirm checkbox found: ' + !!backupWarn);

        // Get options in backing select
        const backingOptions = await page.$$eval('#ssd-backing-dev option', opts =>
          opts.map(o => o.textContent.trim() + ' [' + o.value + ']')
        ).catch(() => []);
        log('Backing device options: ' + JSON.stringify(backingOptions));

        // Get options in cache select
        const cacheOptions = await page.$$eval('#ssd-cache-dev option', opts =>
          opts.map(o => o.textContent.trim() + ' [' + o.value + ']')
        ).catch(() => []);
        log('Cache device options: ' + JSON.stringify(cacheOptions));

        await ss('05b-modal-details');

        // Check writeback warning visibility
        if (writebackWarn) {
          const warnVisible = await writebackWarn.isVisible();
          log('Writeback warning visible (should be hidden): ' + warnVisible);
        }

        // Step 5: Close modal
        log('Closing modal...');
        const cancelBtn = await page.$('#btn-cancel-add-tier');
        if (cancelBtn) {
          await cancelBtn.click();
          await page.waitForTimeout(500);
          await ss('06-modal-closed');
          const modalAfter = await page.$('#modal-add-ssd-tier');
          const modalVisibleAfter = modalAfter ? await modalAfter.isVisible() : false;
          log('Modal visible after close: ' + modalVisibleAfter);
        } else {
          log('Cancel button not found');
        }
      } else {
        log('ERROR: Modal #modal-add-ssd-tier not found in DOM');
      }
    } else {
      log('ERROR: + Добавить SSD-кеш button not found');
    }

    // Final screenshot of full page
    await ss('07-final-state');

    // Report console errors
    if (consoleErrors.length > 0) {
      log('CONSOLE ERRORS (' + consoleErrors.length + '):');
      consoleErrors.forEach(e => log('  ERROR: ' + e));
    } else {
      log('No console errors detected.');
    }

  } catch (err) {
    log('TEST ERROR: ' + err.message);
    await ss('error-state');
    console.error(err);
  } finally {
    await browser.close();
  }
})();
