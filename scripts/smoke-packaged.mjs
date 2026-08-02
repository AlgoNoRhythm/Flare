import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Smoke test: the PACKAGED exe (not `electron .`) boots and renders the graph.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-smoke-'));
const app = await electron.launch({
  executablePath: path.resolve('release/win-unpacked/Flare.exe'),
  args: [],
  env: {
    ...process.env,
    FLARE_PROJECT: process.cwd(),
    FLARE_USERDATA: userData,
  },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid="graph-container"]', { timeout: 30000 });
const stats = await page.getByTestId('stats').textContent();
console.log('packaged app booted, stats:', stats);
// verify the pty works in the packaged build (native module unpacked correctly)
await page.waitForTimeout(2500);
await page.locator('.terminal-body').click();
await page.keyboard.type('echo packaged_ok');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.querySelector('.xterm-rows')?.textContent?.includes('packaged_ok'),
  undefined,
  { timeout: 20000 },
);
console.log('packaged pty works');
await app.close();
console.log('smoke ok');
