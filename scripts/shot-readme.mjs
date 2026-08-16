/*
 * The two stills in the README, retaken.
 *
 * They are the first thing anyone sees, so they go stale the moment the UI
 * moves — the pair they replace still showed the folders bar as a horizontal
 * strip across the top, which has not existed for a while. This reproduces the
 * exact two frames the README captions describe, so retaking them is one
 * command rather than an afternoon of clicking:
 *
 *   docs/flare-graph.png  the Activity lens after an agent edited seven files,
 *                         one node hovered so its importers light up
 *   docs/flare-wheel.png  the Wheel, cropped to the canvas
 *
 * Like the demo recorder, it shoots a clone at C:\Demo\Flare rather than the
 * working copy: the project name is the folder name and the status bar shows
 * the full path, so shooting out of ...\Desktop\repos\Flare would put a real
 * username in a picture on the front page.
 *
 *   node scripts/shot-readme.mjs            write into docs/
 *   node scripts/shot-readme.mjs <dir>      write somewhere else first
 */
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs'));
const STAGE = 'C:\\Demo\\Flare';

/* Shot at the size the old pair were taken at, so the README's layout does not
   shift when these land. The display scale factor does the rest. */
const WIDTH = 1600;
const HEIGHT = 950;

/*
 * Seven, because the caption says seven.
 *
 * They are also the seven the picture wants: files with importers, spread
 * across three folders, so the Activity gradient has somewhere to run and the
 * hovered node has edges to light up.
 */
const EDITS = [
  'shared/preview.ts',
  'shared/markdown.ts',
  'src/components/Toasts.tsx',
  'src/format.ts',
  'electron/session.ts',
  'src/components/BurstStrip.tsx',
  // last, so Activity paints it the brightest, and the one the shot hovers
  'shared/insights.ts',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A clean clone: the working copy's own dirt would be counted as the edits. */
function stage() {
  fs.mkdirSync(path.dirname(STAGE), { recursive: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', ROOT, STAGE], { stdio: 'pipe' });
  // carry the uncommitted work: the graph should be the source as it is now,
  // not as it was at the last commit
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  for (const line of dirty.split('\n')) {
    const rel = line.slice(3).trim();
    if (!rel || line.startsWith(' D') || rel.includes('->')) continue;
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue;
    const to = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  execFileSync('git', ['add', '-A'], { cwd: STAGE, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.email=demo@flare', '-c', 'user.name=Flare', 'commit', '-qm', 'state'], {
    cwd: STAGE,
    stdio: 'pipe',
  });
  console.log(`staged ${STAGE}`);
}

/*
 * The edits themselves, made while the app is open.
 *
 * Activity colours by when a file was written this session — it is the file
 * watcher's order, not git's — so they have to land one at a time, after the
 * window is up, or the lens has nothing to grade.
 */
async function edit(rel) {
  const file = path.join(STAGE, rel);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${text}\n// touched\n`);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-shot-'));
stage();

const app = await electron.launch({
  args: [ROOT],
  cwd: ROOT,
  env: {
    ...process.env,
    FLARE_PROJECT: STAGE,
    FLARE_USERDATA: userData,
    FLARE_MCP_REGISTRY: fs.mkdtempSync(path.join(os.tmpdir(), 'flare-shot-reg-')),
  },
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForSelector('[data-testid="graph-container"]', { timeout: 40000 });

// size the real window, not just the emulated viewport — see demo/record.mjs
await app.evaluate(({ BrowserWindow }, s) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  win.setPosition(40, 12);
  win.setContentSize(s.w, s.h);
}, { w: WIDTH, h: HEIGHT });
await page.waitForTimeout(1200);

for (const rel of EDITS) {
  await edit(rel);
  await sleep(700);
}
await page.waitForTimeout(3500);
console.log(`edited ${EDITS.length} files`);

/*
 * Two folders open, the rest folded.
 *
 * Unfolding everything is 156 cards at a zoom where none of the names can be
 * read, which is a picture of a mess rather than of a map. Opening the two
 * folders the edits are in keeps the file names legible and leaves the other
 * folders as the single cards that make the point about folding.
 */
async function open(folder) {
  const chip = page.getByTestId(`legend-${folder}`);
  if (await chip.count()) {
    await chip.click();
    await page.waitForTimeout(700);
  }
}

await page.getByTestId('lens-activity').click();
await page.waitForTimeout(500);
const foldAll = page.getByTestId('legend-fold-all');
if ((await foldAll.count()) && (await foldAll.isEnabled())) {
  await foldAll.click();
  await page.waitForTimeout(900);
}
await open('shared');
await open('src');
await page.keyboard.press('Control+0');
await page.waitForTimeout(1200);

// unfolding says so in a toast; give it time to go, or the still is of a
// message about the shot being set up
await page.waitForTimeout(7000);

/*
 * Fit puts 83 cards on screen at 37%, where not one file name can be read —
 * a picture of a graph rather than of this graph. Jump to the file the shot is
 * about and zoom back in to where the labels are legible, which is roughly
 * where anyone actually works.
 */
await page.getByTestId('search-input').fill('shared/insights.ts');
await page.getByTestId('search-input').press('Enter');
await page.getByTestId('search-input').fill('');
await page.waitForTimeout(900);
// the jump lands at 100%, which is one folder's worth of screen; settle on the
// zoom the shot it replaces was taken at, where names still read
const pctNow = async () => parseInt((await page.getByTestId('zoom-readout').textContent()) ?? '0', 10);
for (let i = 0; i < 14; i++) {
  const pct = await pctNow();
  if (pct >= 68 && pct <= 78) break;
  await page.getByRole('button', { name: pct > 78 ? 'Zoom out' : 'Zoom in' }).click();
  await page.waitForTimeout(220);
}
await page.waitForTimeout(800);
console.log('zoom', await page.getByTestId('zoom-readout').textContent());

/*
 * Jumping selects, and a selection brings the details panel and the selection
 * bar with it — two panels of chrome in a picture that is meant to be of the
 * graph. Click empty canvas to drop it; the framing it set up stays.
 */
const area = await page.locator('[data-testid="graph-container"]').boundingBox();
await page.mouse.click(area.x + 60, area.y + area.height - 60);
await page.waitForTimeout(700);

/*
 * Hover one of the edited files, so the picture shows the thing the caption
 * promises: who imports it, lit up. A changed file is the right one to pick —
 * it is also the brightest node on screen.
 */
const hovered = page.getByTestId('gcard-shared/insights.ts');
if (await hovered.count()) {
  await hovered.hover();
} else {
  await page.locator('.gcard').nth(8).hover();
}
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, 'flare-graph.png') });
console.log('wrote flare-graph.png');

/*
 * The wheel is cropped to the canvas: the explorer and the terminal are the
 * subject of the other shot, and the ring reads better without them.
 */
/*
 * Safe to clear the markers now the first shot is written: they stack down the
 * right-hand side, and on the ring that is the half where shared/ is labelled.
 * Unfolding everything is tempting here and wrong — 156 spokes is past the
 * point where the ring can label any of them.
 */
const dismiss = page.getByTestId('ra-dismiss-all');
if (await dismiss.count()) {
  await dismiss.click();
  await page.waitForTimeout(800);
}
await page.getByTestId('lens-clusters').click();
await page.waitForTimeout(300);
await page.getByTestId('view-wheel').click();
await page.waitForTimeout(2000);
await page.keyboard.press('Control+0');
await page.waitForTimeout(2000);

const overlay = await page.locator('.graph-overlay').boundingBox();
const canvas = await page.locator('[data-testid="graph-container"]').boundingBox();
const top = Math.min(overlay?.y ?? canvas.y, canvas.y);
const clip = {
  x: Math.round(canvas.x),
  y: Math.round(top),
  width: Math.round(canvas.width),
  height: Math.round(canvas.y + canvas.height - top),
};
await page.screenshot({ path: path.join(OUT, 'flare-wheel.png'), clip });
console.log('wrote flare-wheel.png', JSON.stringify(clip));

await app.close();
