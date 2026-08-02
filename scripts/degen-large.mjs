import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = process.argv[2];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-large-'));
const t0 = Date.now();
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, FLARE_PROJECT: dir, FLARE_USERDATA: userData },
  timeout: 60000,
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForSelector('[data-testid="graph-container"]', { timeout: 40000 });
console.log('first canvas at', Date.now() - t0, 'ms');
await page.setViewportSize({ width: 1600, height: 950 });
await page.waitForTimeout(4000);
console.log('stats:', await page.getByTestId('stats').textContent());

// expand everything: 600 nodes worst case
const t1 = Date.now();
await page.getByTestId('collapse-toggle-all').click();
await page.waitForTimeout(4000);
console.log('expanded stats:', await page.getByTestId('stats').textContent(), 'in', Date.now() - t1, 'ms');
await page.screenshot({ path: path.join(path.dirname(dir), 'degen-large-expanded.png') });

// pan/zoom interaction sanity
await page.mouse.move(900, 400);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(500);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(500);
console.log('errors:', errors.length, errors.slice(0, 3));
await app.close();
console.log('large case OK');
