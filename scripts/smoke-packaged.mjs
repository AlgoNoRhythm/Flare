import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Smoke test: the PACKAGED exe (not `electron .`) boots and renders the graph.

/**
 * Where electron-builder left the binary, per platform.
 *
 * This used to be the Windows path and nothing else, so on a mac it launched
 * `release/win-unpacked/Flare.exe`, found nothing, and the one check that the
 * *shipped* build works could never run on the platform being shipped.
 *
 * Several candidates per platform because the output directory carries the
 * arch: `mac` for x64, `mac-arm64`, `mac-universal`.
 */
const candidates = {
  win32: ['release/win-unpacked/Flare.exe'],
  darwin: [
    'release/mac/Flare.app/Contents/MacOS/Flare',
    'release/mac-arm64/Flare.app/Contents/MacOS/Flare',
    'release/mac-universal/Flare.app/Contents/MacOS/Flare',
  ],
  linux: ['release/linux-unpacked/flare'],
}[process.platform];

if (!candidates) throw new Error(`no packaged-app path known for ${process.platform}`);

const executablePath = candidates.map((p) => path.resolve(p)).find((p) => fs.existsSync(p));
if (!executablePath) {
  throw new Error(
    `packaged app not found for ${process.platform} — looked in:\n  ${candidates.join('\n  ')}\nRun \`npm run dist\` first.`,
  );
}
console.log('smoking', executablePath);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-smoke-'));
const app = await electron.launch({
  executablePath,
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
