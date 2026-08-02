import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Screenshots each mock repo in several states for UX review.
// Usage: node scripts/shot-mocks.mjs <mocksDir> <outDir>

const mocksDir = process.argv[2];
const outDir = process.argv[3] ?? mocksDir;

for (const name of ['monorepo', 'flat', 'pylib']) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `flare-mock-${name}-`));
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      FLARE_PROJECT: path.join(mocksDir, name),
      FLARE_USERDATA: userData,
    },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.waitForSelector('[data-testid="graph-container"]', { timeout: 20000 });
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, `m-${name}-collapsed.png`) });

  // expand everything (worst case density)
  const toggle = page.getByTestId('collapse-toggle-all');
  if ((await toggle.textContent())?.includes('Expand')) {
    await toggle.click();
    await page.waitForTimeout(1800);
  }
  await page.screenshot({ path: path.join(outDir, `m-${name}-expanded.png`) });

  // one lens state
  const lens = name === 'pylib' ? 'lens-coverage' : 'lens-risk';
  if ((await page.getByTestId(lens).count()) > 0) {
    await page.getByTestId(lens).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `m-${name}-lens.png`) });
  }
  await app.close();
  console.log(`${name} done`);
}
console.log('all mock screenshots done');
