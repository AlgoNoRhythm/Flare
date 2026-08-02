import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const outDir = process.argv[2] ?? '.';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-shot-'));
const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    FLARE_PROJECT: process.cwd(),
    FLARE_USERDATA: userData,
  },
});
const page = await app.firstWindow();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200));
});
await page.waitForSelector('[data-testid="graph-container"]', { timeout: 20000 });
await page.setViewportSize({ width: 1600, height: 950 });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(outDir, 'v-collapsed.png') });

// lens on the collapsed cluster view (aggregate coloring)
await page.getByTestId('lens-hotspot').click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, 'v-hotspot.png') });
await page.getByTestId('lens-clusters').click();

// expand two clusters
await page.getByTestId('legend-shared').click();
await page.waitForTimeout(600);
await page.getByTestId('legend-src').click();
await page.waitForTimeout(900);
await page.getByTestId('zoom-fit').click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, 'v-expanded.png') });

// select a file -> details panel + highlight
await page.getByTestId('search-input').fill('CanvasView.tsx');
await page.getByTestId('search-input').press('Enter');
await page.getByTestId('search-input').fill('');
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(outDir, 'v-selected.png') });

// wheel view
await page.getByTestId('view-wheel').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(outDir, 'v-wheel.png') });

// wheel with a pinned node (direction tracing)
await page.locator('[data-testid="wnode-src/App.tsx"] .dot').click();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, 'v-wheel-pinned.png') });

// districts
await page.getByTestId('view-districts').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(outDir, 'v-districts.png') });

await page.getByTestId('lens-risk').click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, 'v-districts-risk.png') });

await app.close();
console.log('done');
