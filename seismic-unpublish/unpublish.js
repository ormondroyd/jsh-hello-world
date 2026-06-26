const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SPREADSHEET = '/Users/jhall/Seismic Archive/archive list.xlsx';
const assets = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets.json'), 'utf8'));
const LOG_FILE = path.join(__dirname, 'results.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function markSpreadsheet(name, status) {
  const script = `
from openpyxl import load_workbook
from datetime import datetime
import sys

wb = load_workbook(sys.argv[1])
ws = wb.active

if ws.cell(1, 2).value != 'Status':
    ws.cell(1, 2).value = 'Status'
    ws.cell(1, 3).value = 'Timestamp'

for row in ws.iter_rows(min_row=2):
    if str(row[0].value or '').strip() == sys.argv[2]:
        row[1].value = sys.argv[3]
        row[2].value = datetime.now().strftime('%Y-%m-%d %H:%M')
        break

wb.save(sys.argv[1])
`.trim();

  try {
    execSync(`python3 -c "${script.replace(/"/g, '\\"')}" "${SPREADSHEET}" "${name.replace(/"/g, '\\"')}" "${status}"`);
  } catch (err) {
    log(`WARNING: Could not update spreadsheet for "${name}": ${err.message}`);
  }
}

async function unpublishAsset(page, asset) {
  await page.goto(asset.url, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/login') || page.url().includes('/signin')) {
    log('ERROR: Not logged in — please log in and restart');
    process.exit(1);
  }

  const openInLibrary = page.locator('[data-atmt-id="Open In Library"]');
  await openInLibrary.waitFor({ state: 'visible', timeout: 15000 });
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

  await page.waitForFunction(
    () => document.querySelector('[data-testid="cm-operations-unpublish-button"]')?.getAttribute('aria-disabled') === 'true',
    { timeout: 15000 }
  );

  log(`DONE: ${asset.name}`);
  markSpreadsheet(asset.name, 'Unpublished');
  return 'done';
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://bmchelix.seismic.com', { waitUntil: 'domcontentloaded' });
  log('>>> Log into Seismic in the browser window, then click Resume in the Playwright inspector to continue.');
  await page.pause();
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
      markSpreadsheet(asset.name, `Error: ${err.message.slice(0, 80)}`);
      results.errors.push({ name: asset.name, url: asset.url, error: err.message });
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
