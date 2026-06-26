const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const SPREADSHEET = '/Users/jhall/Seismic Archive/archive list.xlsx';
const START_FROM_ROW = 100; // 1-based row number in spreadsheet (row 1 = header)
const assets = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets.json'), 'utf8'));
const LOG_FILE = path.join(__dirname, 'results.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sanitize(str) {
  // Strip ANSI escape codes and control characters, keep printable ASCII
  return str.replace(/\x1B\[[0-9;]*m/g, '').replace(/[^\x20-\x7E]/g, ' ').slice(0, 100);
}

const MARK_SCRIPT = path.join(__dirname, 'mark_spreadsheet.py');
const GET_SCRIPT = path.join(__dirname, 'get_processed.py');

function markSpreadsheet(name, status) {
  const safeStatus = sanitize(status);
  try {
    execSync(`python3 ${JSON.stringify(MARK_SCRIPT)} ${JSON.stringify(SPREADSHEET)} ${JSON.stringify(name)} ${JSON.stringify(safeStatus)}`);
  } catch (err) {
    log(`WARNING: Could not update spreadsheet for "${name}": ${err.message.slice(0, 200)}`);
  }
}

function getProcessedNames() {
  try {
    const output = execSync(`python3 ${JSON.stringify(GET_SCRIPT)} ${JSON.stringify(SPREADSHEET)}`).toString();
    return new Set(JSON.parse(output));
  } catch {
    return new Set();
  }
}

async function waitForLogin(page) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('>>> Session expired — log in again in the browser, then press Enter...', () => { rl.close(); resolve(); }));
}

async function unpublishAsset(page, asset) {
  if (!asset.url.includes('seismic.com')) {
    log(`SKIPPED (not in Seismic): ${asset.name} — ${asset.url}`);
    markSpreadsheet(asset.name, 'Not in Seismic');
    return 'skipped';
  }

  await page.goto(asset.url, { waitUntil: 'domcontentloaded' });

  const url = page.url();

  // Session expired
  if (url.includes('/login') || url.includes('/signin')) {
    log('Session expired — pausing for re-login');
    await waitForLogin(page);
    await page.goto(asset.url, { waitUntil: 'domcontentloaded' });
  }

  // Already unpublished or expired — URL tells us directly
  if (page.url().includes('/unpublished/')) {
    log(`SKIPPED (already unpublished): ${asset.name}`);
    markSpreadsheet(asset.name, 'Already unpublished');
    return 'skipped';
  }
  if (page.url().includes('/expireContent/')) {
    log(`SKIPPED (expired): ${asset.name}`);
    markSpreadsheet(asset.name, 'Expired');
    return 'skipped';
  }

  // Wait for either the Open in Library button or a known dead-end page
  const arrived = await Promise.race([
    page.locator('[data-atmt-id="Open In Library"]').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'open'),
    page.locator(':text("no longer published")').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'notfound'),
    page.locator(':text("no longer available")').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'notfound'),
    page.locator(':text("has expired")').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'notfound'),
  ]).catch(() => 'timeout');

  if (arrived === 'notfound') {
    log(`SKIPPED (already unpublished - content not found page): ${asset.name}`);
    markSpreadsheet(asset.name, 'Already unpublished');
    return 'skipped';
  }
  if (arrived === 'timeout') {
    log(`SKIPPED (content not accessible - blank page): ${asset.name}`);
    markSpreadsheet(asset.name, 'Not accessible');
    return 'skipped';
  }

  const openInLibrary = page.locator('[data-atmt-id="Open In Library"]');
  await openInLibrary.click();

  const unpublishBtn = page.locator('[data-testid="cm-operations-unpublish-button"]');
  await unpublishBtn.waitFor({ state: 'visible', timeout: 20000 });

  const isDisabled = await unpublishBtn.getAttribute('aria-disabled');
  if (isDisabled === 'true') {
    log(`SKIPPED (already unpublished): ${asset.name}`);
    markSpreadsheet(asset.name, 'Already unpublished');
    return 'skipped';
  }

  await unpublishBtn.click();

  const confirmBtn = page.locator('[data-testid="cm-common-sbp-modal-footer-button-unpublish-confirm"]');
  await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
  await confirmBtn.click();

  await confirmBtn.waitFor({ state: 'hidden', timeout: 15000 });

  const toast = page.locator(':text("is unpublished")');
  await toast.waitFor({ state: 'visible', timeout: 15000 });

  log(`DONE: ${asset.name}`);
  markSpreadsheet(asset.name, 'Unpublished');
  return 'done';
}

async function main() {
  const alreadyDone = getProcessedNames();
  if (alreadyDone.size > 0) {
    log(`Resuming — skipping ${alreadyDone.size} already-processed assets`);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://bmchelix.seismic.com', { waitUntil: 'domcontentloaded' });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('>>> Log into Seismic in the browser, then press Enter to continue...', () => { rl.close(); resolve(); }));
  log('Logged in — starting unpublish run');

  const results = { done: 0, skipped: 0, errors: [] };

  for (let i = START_FROM_ROW - 2; i < assets.length; i++) {
    const asset = assets[i];

    if (alreadyDone.has(asset.name.trim())) {
      log(`[${i + 1}/${assets.length}] SKIPPED (already done): ${asset.name}`);
      results.skipped++;
      continue;
    }

    log(`[${i + 1}/${assets.length}] ${asset.name}`);
    try {
      const result = await unpublishAsset(page, asset);
      if (result === 'done') results.done++;
      else if (result === 'skipped') results.skipped++;
    } catch (err) {
      const msg = sanitize(err.message.split('\n')[0]);
      log(`ERROR: ${asset.name} — ${msg}`);
      markSpreadsheet(asset.name, `Error: ${msg}`);
      results.errors.push({ name: asset.name, url: asset.url, error: msg });
      await page.screenshot({ path: path.join(__dirname, `error_${i + 1}.png`) }).catch(() => {});
    }
  }

  log(`\n=== COMPLETE ===`);
  log(`Unpublished: ${results.done}`);
  log(`Skipped: ${results.skipped}`);
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
