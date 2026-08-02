import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const outDir = process.argv[2] ?? '.';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-ins-'));
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, FLARE_PROJECT: process.cwd(), FLARE_USERDATA: userData },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid="graph-container"]', { timeout: 20000 });
await page.setViewportSize({ width: 1600, height: 950 });

// create some session activity so agent-era rules have data
fs.appendFileSync('src/components/GraphView.tsx', '\n// TODO screenshot-marker tune halo falloff\n');
await page.waitForTimeout(2500);
fs.appendFileSync('src/App.tsx', '\n// FIXME screenshot-marker split App state\n');
await page.waitForTimeout(3500);

await page.getByTestId('tab-insights').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(outDir, 'insights.png') });
await app.close();

// revert the marker comments
for (const f of ['src/components/GraphView.tsx', 'src/App.tsx']) {
  const t = fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => !l.includes('screenshot-marker'))
    .join('\n');
  fs.writeFileSync(f, t);
}
console.log('done');
