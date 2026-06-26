const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const assets = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets.json'), 'utf8'));

const LOG_FILE = path.join(__dirname, 'results.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function unpublishAsset(page, asset) {
  log(`Processing: ${asset.name}`);

  await page.goto(asset.url, { waitUntil: 'domcontentloaded' });

  // Check if we got redirected to login
  if (page.url().includes('/login') || page.url().includes('/signin')) {
    log('ERROR: Not logged in — please log in and restart');
    process.exit(1);
  }

  // Click "Open in Library"
  const openInLibrary = page.locator('[data-atmt-id="Open In Library"]');
  await openInLibrary.waitFor({ state: 'visible', timeout: 15000 });
  await openInLibrary.click();

  // Wait for library page to fully load
  const unpublishBtn = page.locator('[data-testid="cm-operations-unpublish-button"]');
  await unpublishBtn.waitFor({ state: 'visible', timeout: 20000 });

  // Check if already unpublished (button disabled)
  const isDisabled = await unpublishBtn.getAttribute('aria-disabled');
  if (isDisabled === 'true') {
    log(`SKIPPED (already unpublished): ${asset.name}`);
    return 'skipped';
  }

  await unpublishBtn.click();

  // Wait for modal and confirm
  const confirmBtn = page.locator('[data-testid="cm-common-sbp-modal-footer-button-unpublish-confirm"]');
  await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
  await confirmBtn.click();

  // Wait for modal to close as confirmation the action completed
  await confirmBtn.waitFor({ state: 'hidden', timeout: 15000 });

  log(`DONE: ${asset.name}`);
  return 'done';
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to Seismic first so user can log in if needed
  log('Opening Seismic — please log in if prompted, then the script will continue automatically.');
  await page.goto('https://bmchelix.seismic.com', { waitUntil: 'domcontentloaded' });

  // Wait until we're past the login page (up to 2 minutes)
  await page.waitForFunction(
    () => !window.location.href.includes('/login') && !window.location.href.includes('/signin'),
    { timeout: 120000 }
  );
  log('Logged in — starting unpublish run');

  const results = { done: 0, skipped: 0, errors: [] };

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    log(`[${i + 1}/${assets.length}] ${asset.name}`);
    try {
      const result = await unpublishAsset(page, asset);
      if (result === 'done') results.done++;
      else if (result === 'skipped') results.skipped++;
    } catch (err) {
      log(`ERROR: ${asset.name} — ${err.message}`);
      results.errors.push({ name: asset.name, url: asset.url, error: err.message });
      // Take screenshot for debugging
      await page.screenshot({ path: path.join(__dirname, `error_${i + 1}.png`) }).catch(() => {});
    }
  }

  log(`\n=== COMPLETE ===`);
  log(`Unpublished: ${results.done}`);
  log(`Already unpublished (skipped): ${results.skipped}`);
  log(`Errors: ${results.errors.length}`);
  if (results.errors.length > 0) {
    log('Failed assets:');
    results.errors.forEach(e => log(`  - ${e.name}: ${e.error}`));
  }

  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
