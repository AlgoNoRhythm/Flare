import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Coverage-lens screenshot against this repo's own vitest coverage output.
const outDir = process.argv[2] ?? '.';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-shotcov-'));
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, FLARE_PROJECT: process.cwd(), FLARE_USERDATA: userData },
});
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="graph-container"]', { timeout: 20000 });
await page.setViewportSize({ width: 1600, height: 950 });
await page.waitForTimeout(3000);
await page.getByTestId('lens-menu').click();
await page.getByTestId('lens-coverage').click();
await page.getByTestId('legend-shared').click();
await page.waitForTimeout(1500);
await page.getByTestId('search-input').fill('shared/parser.ts');
await page.getByTestId('search-input').press('Enter');
await page.getByTestId('search-input').fill('');
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outDir, 'v-coverage.png') });
await app.close();
console.log('done');
