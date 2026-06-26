const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SPREADSHEET = '/Users/jhall/Seismic Archive/archive list.xlsx';
const assets = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets.json'), 'utf8'));
const asset = assets[0];

function markSpreadsheet(name, status) {
  const script = `
import sys
from openpyxl import load_workbook
from openpyxl.styles import Font
from datetime import datetime

wb = load_workbook('${SPREADSHEET}')
ws = wb.active

if ws.cell(1, 2).value != 'Status':
    ws.cell(1, 2).value = 'Status'
    ws.cell(1, 3).value = 'Timestamp'

name = sys.argv[1]
status = sys.argv[2]
for row in ws.iter_rows(min_row=2):
    if str(row[0].value or '').strip() == name:
        row[1].value = status
        row[2].value = datetime.now().strftime('%Y-%m-%d %H:%M')
        break

wb.save('${SPREADSHEET}')
print(f'Updated spreadsheet: {name} -> {status}')
`;
  execSync(`python3 -c "${script.replace(/"/g, '\\"')}" "${name}" "${status}"`);
}

async function main() {
  console.log(`Testing with: ${asset.name}`);
  console.log(`URL: ${asset.url}`);

  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://bmchelix.seismic.com', { waitUntil: 'domcontentloaded' });

  console.log('>>> Log into Seismic in the browser window, then click Resume in the Playwright inspector to continue.');
  await page.pause();
  console.log('Resuming — proceeding with unpublish');

  await page.goto(asset.url, { waitUntil: 'domcontentloaded' });

  const openInLibrary = page.locator('[data-atmt-id="Open In Library"]');
  await openInLibrary.waitFor({ state: 'visible', timeout: 15000 });
  console.log('Found "Open in Library" button');
  await openInLibrary.click();

  const unpublishBtn = page.locator('[data-testid="cm-operations-unpublish-button"]');
  await unpublishBtn.waitFor({ state: 'visible', timeout: 20000 });
  console.log('Found Unpublish button');

  const isDisabled = await unpublishBtn.getAttribute('aria-disabled');
  if (isDisabled === 'true') {
    console.log('Already unpublished — skipping');
    markSpreadsheet(asset.name, 'Already unpublished');
    await browser.close();
    return;
  }

  await unpublishBtn.click();
  console.log('Clicked Unpublish');

  const confirmBtn = page.locator('[data-testid="cm-common-sbp-modal-footer-button-unpublish-confirm"]');
  await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
  console.log('Confirm dialog appeared');
  await confirmBtn.click();
  console.log('Clicked Confirm');

  await confirmBtn.waitFor({ state: 'hidden', timeout: 15000 });
  console.log('Modal closed — waiting for Unpublish button to show as disabled');

  await page.waitForFunction(
    () => document.querySelector('[data-testid="cm-operations-unpublish-button"]')?.getAttribute('aria-disabled') === 'true',
    { timeout: 15000 }
  );
  console.log('SUCCESS — asset is now unpublished');

  markSpreadsheet(asset.name, 'Unpublished');

  await browser.close();
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
