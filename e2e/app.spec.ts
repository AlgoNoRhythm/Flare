import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
let fixture: string;
let userData: string;
let mcpRegistryDir: string;

function write(rel: string, content: string) {
  const abs = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function git(...args: string[]) {
  execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
}

test.describe.configure({ mode: 'serial' });

async function readStats(): Promise<{ nodes: number; edges: number }> {
  const text = (await page.getByTestId('stats').textContent()) ?? '';
  const m = /(\d+) nodes · (\d+) edges/.exec(text);
  return { nodes: Number(m?.[1] ?? -1), edges: Number(m?.[2] ?? -1) };
}

/*
 * The lens and view switchers live in dropdown menus at the canvas's top
 * right now — picking one is open-the-menu, then the same testid as before.
 */
async function pickLens(id: string) {
  await page.getByTestId('lens-menu').click();
  await page.getByTestId(`lens-${id}`).click();
}

async function pickView(id: string) {
  await page.getByTestId('view-menu').click();
  await page.getByTestId(`view-${id}`).click();
}

test.beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-proj-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-data-'));
  mcpRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-mcpreg-'));

  write(
    'src/app.ts',
    `import { util } from './util';\nimport { helper } from './lib/helper';\n\nexport function main() {\n  return util() + helper();\n}\n`,
  );
  write('src/util.ts', `export function util() {\n  return 1;\n}\n`);
  write(
    'src/lib/helper.ts',
    `import { util } from '../util';\n\nexport function helper() {\n  return util() * 2;\n}\n`,
  );
  write('tools/common.py', `def shared():\n    return 42\n`);
  write('tools/script.py', `from tools.common import shared\n\nprint(shared())\n`);
  write('README.md', '# fixture\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@test.local');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      FLARE_PROJECT: fixture,
      FLARE_USERDATA: userData,
      FLARE_MCP_PORT: '7411',
      FLARE_MCP_REGISTRY: mcpRegistryDir,
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message, err.stack?.split('\n')[1] ?? ''));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of [fixture, userData]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a lingering process may hold a handle briefly; not a test failure
    }
  }
});

test('a small project boots unfolded; folds all, one, and back via the legend', async () => {
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture));
  await expect(page.getByTestId('graph-container')).toBeVisible();
  // this fixture is far below the fold-on-open threshold, so nothing is hidden:
  // 5 code files; app->util, app->helper, helper->util, script->common = 4 edges
  await expect(page.getByTestId('stats')).toHaveText('5 nodes · 4 edges');
  await expect(page.getByTestId('legend')).toContainText('src');
  await expect(page.getByTestId('legend')).toContainText('0/2 folded');

  // fold everything into cluster meta-nodes, then bring it all back
  await page.getByTestId('legend-fold-all').click();
  await expect(page.getByTestId('stats')).toHaveText('2 nodes · 0 edges');
  await expect(page.getByTestId('legend')).toContainText('2/2 folded');
  await page.getByTestId('legend-unfold-all').click();
  await expect(page.getByTestId('stats')).toHaveText('5 nodes · 4 edges');

  // and a single folder on its own: src/ folds to one card, tools/ stays open
  await page.getByTestId('legend-src').click();
  await expect(page.getByTestId('stats')).toContainText('3 nodes');
  await expect(page.getByTestId('legend')).toContainText('1/2 folded');
  await page.getByTestId('legend-src').click();
  await expect(page.getByTestId('stats')).toHaveText('5 nodes · 4 edges');
});

test('file tree lists files and opens the editor with content', async () => {
  await expect(page.getByTestId('tree-dir-src')).toBeVisible();
  await page.getByTestId('tree-file-src/app.ts').click();
  await expect(page.getByTestId('tab-file:src/app.ts')).toBeVisible();
  const editor = page.getByTestId('editor-src/app.ts');
  await expect(editor.locator('.view-lines')).toContainText(`import { util } from './util'`);
});

test('search selects a node and details show dependencies and blast radius', async () => {
  await page.getByTestId('tab-graph').click();
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('details-panel')).toBeVisible();
  await expect(page.getByTestId('details-panel')).toContainText('src/util.ts');
  // util.ts is imported by app.ts and helper.ts
  await expect(page.getByTestId('blast-radius')).toHaveText('2 files downstream');
  await expect(page.getByTestId('details-panel')).toContainText('src/app.ts');
  await expect(page.getByTestId('details-panel')).toContainText('src/lib/helper.ts');
});

test('an external change is flagged as already applied, and the flag is dismissable', async () => {
  await page.getByTestId('search-input').fill('');
  fs.appendFileSync(path.join(fixture, 'src', 'util.ts'), '\nexport const extra = 99;\n');
  // both waits ride on a filesystem-watcher batch, which under load has taken
  // longer than the default budget
  await expect(page.getByTestId('unreviewed-badge')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('unreviewed-badge')).toContainText('to review', { timeout: 20_000 });

  /*
   * The chip must not imply a gate. The edit is on disk before anyone sees it,
   * so the copy says so and the action is "dismiss", not "approve" — the
   * sentence moved into the tooltip when this stopped being a full-width bar,
   * but it still has to be there and it still must not say "approve".
   */
  const chip = page.getByTestId('review-banner');
  await expect(chip).toHaveAttribute('title', /already written to disk/);
  await expect(chip).toHaveAttribute('title', /not a gate/);
  const dismiss = page.getByTestId('btn-approve-all');
  await expect(dismiss).toHaveAttribute('aria-label', 'Dismiss all markers');
  await expect(dismiss).toHaveAttribute('title', /Nothing is approved by doing this/);

  // dismissing clears the marker and leaves the file exactly as it was
  const before = fs.readFileSync(path.join(fixture, 'src', 'util.ts'), 'utf8');
  await page.getByTestId('btn-approve-all').click();
  await expect(page.getByTestId('unreviewed-badge')).toBeHidden();
  expect(fs.readFileSync(path.join(fixture, 'src', 'util.ts'), 'utf8')).toBe(before);
});

test('graph updates live when a new file with imports appears', async () => {
  const before = await readStats();
  write('src/brand-new.ts', `import { util } from './util';\nexport const brandNew = util();\n`);
  // one node and one edge appear once the watcher batch lands
  await expect.poll(async () => (await readStats()).nodes).toBe(before.nodes + 1);
  await expect.poll(async () => (await readStats()).edges).toBe(before.edges + 1);
  await expect(page.getByTestId('tree-file-src/brand-new.ts')).toBeVisible();
  await page.getByTestId('btn-approve-all').click();
});

test('diff vs HEAD opens for a modified file', async () => {
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await page.getByTestId('btn-diff-head').click();
  const diff = page.getByTestId('diff-src/util.ts');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.view-lines').last()).toContainText('extra = 99');

  // The added line has to be visibly green, not merely present. vs-dark's
  // default diff tints are near-black against this surface, so both panes read
  // as the same code and the reader has to find the change by eye.
  const inserted = await diff.locator('.line-insert').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = inserted.match(/\d+/g)!.map(Number);
  expect(g).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
});

test('shadow timeline records snapshots and restores a file', async () => {
  await page.getByTestId('btn-timeline').click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.locator('.snap-row').first()).toBeVisible();

  const target = path.join(fixture, 'src', 'util.ts');
  const before = fs.readFileSync(target, 'utf8');

  // open the file's history *first*, so the pre-clobber snapshot count is known
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('details-panel')).toContainText('Local history');
  const revertLinks = page.getByTestId('details-panel').getByText('revert to this');
  await expect(revertLinks.first()).toBeVisible({ timeout: 20_000 });
  const wasCount = await revertLinks.count();

  fs.writeFileSync(target, before + '\nexport const clobbered = true;\n');
  await expect(page.getByTestId('unreviewed-badge')).toBeVisible();
  await expect
    .poll(async () => fs.readFileSync(target, 'utf8').includes('clobbered'), { timeout: 5000 })
    .toBe(true);

  /*
   * Wait for the clobber's own snapshot before picking one to revert to.
   *
   * This used to read the count and click `nth(min(1, count - 1))` on the
   * assumption that the newest entry was the clobber — but the snapshot is
   * taken on a debounce, so the list was often still one short and index 1
   * pointed at a state that already contained the clobber. Waiting for the
   * count to grow is what makes index 0 the clobber and index 1 the state
   * before it, which is the whole point of the assertion below.
   */
  await expect.poll(() => revertLinks.count(), { timeout: 20_000 }).toBeGreaterThan(wasCount);
  await revertLinks.nth(1).click();
  await expect
    .poll(async () => fs.readFileSync(target, 'utf8').includes('clobbered'), { timeout: 10_000 })
    .toBe(false);
});

test('terminal runs a real shell', async () => {
  const panel = page.getByTestId('terminal-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.xterm')).toBeVisible();
  // wait for the shell prompt to initialize, then run a command
  await page.waitForTimeout(3000);
  await panel.locator('.terminal-body').click();
  await page.keyboard.type('echo flare_e2e_ok');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText('flare_e2e_ok', { timeout: 20_000 });
});

test('terminal and command log are one tab group, switchable in both directions', async () => {
  const panel = page.getByTestId('terminal-panel');
  const termTab = page.locator('[data-testid^="terminal-tab-"]').first();
  const body = panel.locator('.terminal-body');

  await page.getByTestId('commands-toggle').click();
  await expect(page.getByTestId('command-log')).toBeVisible();
  await expect(body).toBeHidden();
  // the terminal tab must not still claim to be the selected view
  await expect(termTab).not.toHaveClass(/\bactive\b/);
  await expect(termTab).toHaveClass(/\bcurrent\b/);

  // clicking the terminal is the way back — it used to only set which terminal
  // was active, behind a view still showing the command log
  await termTab.click();
  await expect(body).toBeVisible();
  await expect(page.getByTestId('command-log')).toBeHidden();
  await expect(termTab).toHaveClass(/\bactive\b/);

  // and the old route still works
  await page.getByTestId('commands-toggle').click();
  await expect(page.getByTestId('command-log')).toBeVisible();
  await page.getByTestId('commands-toggle').click();
  await expect(body).toBeVisible();
});

test('connect dialog gives the setup for all three agents, and the line to open with', async () => {
  await page.getByTestId('mcp-connect-toggle').click();
  const url = (await page.getByTestId('mcp-url').textContent()) ?? '';
  // the project-scoped path is the one that keeps working with several windows
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);

  // ---- step 1: Claude Code is a command; the other two are config files, in
  // different formats and different places, and guessing either is worse than
  // no help
  await expect(page.getByTestId('mcp-snippet')).toContainText('claude mcp add --transport http');
  await page.getByTestId('mcp-target-codex').click();
  await expect(page.getByTestId('mcp-snippet')).toContainText('[mcp_servers.flare]');
  await expect(page.getByTestId('mcp-snippet')).toContainText(url);
  await page.getByTestId('mcp-target-opencode').click();
  await expect(page.getByTestId('mcp-snippet')).toContainText('"type": "remote"');
  await expect(page.getByTestId('mcp-snippet')).toContainText(url);

  /*
   * ---- step 2: the part registering the server does not do.
   *
   * Attaching the tools does not make an agent read them, and everything this
   * project expects lives behind one call. So the dialog carries the sentence
   * that starts it, with the endpoint in it.
   */
  const prompt = page.getByTestId('mcp-prompt');
  await expect(prompt).toContainText(url);
  await expect(prompt).toContainText('working_agreement');

  await page.getByTestId('mcp-copy-url').click();
  await expect.poll(() => page.evaluate(() => window.flare!.invoke('clipboard:read', []) as Promise<string>)).toBe(url);

  // the snippet copies without dismissing: you have not done the second step yet
  await page.getByTestId('mcp-copy-snippet').click();
  await expect(page.getByTestId('mcp-connect')).toBeVisible();
  expect(
    await page.evaluate(() => window.flare!.invoke('clipboard:read', []) as Promise<string>),
  ).toContain('"type": "remote"');

  // Escape gets it out of the way, and hands the terminal back for the paste
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mcp-connect')).toBeHidden();
  await expect(page.locator('.terminal-body .xterm-helper-textarea').first()).toBeFocused();

  // and the opening line is the one action that copies *and* closes, because
  // pasting it is the very next thing you do
  await page.getByTestId('mcp-connect-toggle').click();
  await page.getByTestId('mcp-copy-prompt').click();
  await expect(page.getByTestId('mcp-connect')).toBeHidden();
  const copied = await page.evaluate(
    () => window.flare!.invoke('clipboard:read', []) as Promise<string>,
  );
  expect(copied).toContain(url);
  expect(copied).toContain('working_agreement');
});

test('markdown and images render, with the source one click away', async () => {
  // a 1x1 transparent PNG, so the image case is a real binary file
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.mkdirSync(path.join(fixture, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'docs', 'dot.png'), png);
  write(
    'GUIDE.md',
    [
      '# Guide',
      '',
      'Some **bold** text with `code` and a [link](https://x.test).',
      '',
      '![a dot](docs/dot.png)',
      '',
      '- one',
      '- two',
      '',
      '```sh',
      'npm test',
      '```',
    ].join('\n'),
  );
  // re-read the tree from disk rather than racing the watcher mid-suite
  await page.getByTestId('explorer-refresh').click();
  await expect(page.getByTestId('tree-file-GUIDE.md')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('tree-file-GUIDE.md').dblclick();

  // rendered by default: this is what the file is for
  const doc = page.getByTestId('doc-render');
  await expect(doc.locator('h1')).toHaveText('Guide', { timeout: 20_000 });
  await expect(doc.locator('strong')).toHaveText('bold');
  await expect(doc.locator('li')).toHaveCount(2);
  await expect(doc.locator('pre code')).toHaveText('npm test');
  // a relative image resolves against the document, not the repo root
  await expect(doc.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);

  // and the source slides out from the left, live in the same editor
  await expect(page.getByTestId('doc-source-show')).toBeVisible();
  await page.getByTestId('doc-source-show').click();
  await expect(page.getByTestId('editor-GUIDE.md').locator('.view-lines')).toContainText('# Guide');
  // the rendered view stays: this is a split, not a mode switch
  await expect(doc.locator('h1')).toHaveText('Guide');
  await page.getByTestId('doc-source-hide').click();
  await expect(page.getByTestId('doc-source-show')).toBeVisible();

  // an image file renders as an image rather than as bytes in an editor.
  // A folder that did not exist a moment ago arrives collapsed, like any
  // other, so it has to be opened before its files are on screen.
  await expect(page.getByTestId('tree-dir-docs')).toBeVisible();
  await page.getByTestId('tree-dir-docs').click();
  await expect(page.getByTestId('tree-file-docs/dot.png')).toBeVisible();
  await page.getByTestId('tree-file-docs/dot.png').dblclick();
  await expect(page.locator('.doc-image img')).toHaveAttribute('src', /^data:image\/png;base64,/, {
    timeout: 20_000,
  });
});

test('lenses and layout controls switch without breaking the graph', async () => {
  await page.getByTestId('tab-graph').click();
  const before = await readStats();
  await pickLens('hotspot');
  await expect(page.getByTestId('lens-hotspot')).toHaveClass(/active/);
  await pickLens('tests');
  await pickLens('clusters');
  await page.getByTestId('layout-reset').click();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('graph-container')).toBeVisible();
  await expect.poll(async () => (await readStats()).nodes).toBe(before.nodes);
});

test('canvas, wheel and districts views all render the same graph', async () => {
  await page.getByTestId('tab-graph').click();
  const before = await readStats();
  // canvas is the default: file cards live in the DOM, not a canvas element
  await expect(page.getByTestId('view-canvas')).toHaveClass(/active/);
  await expect(page.getByTestId('gcard-src/app.ts')).toBeVisible();

  await pickView('wheel');
  await expect(page.getByTestId('view-wheel')).toHaveClass(/active/);
  await expect(page.locator('.wnode').first()).toBeVisible();
  await expect.poll(async () => (await readStats()).nodes).toBe(before.nodes);
  // clicking a node pins its dependency directions
  await page.locator('[data-testid="wnode-src/app.ts"] .dot').click();
  await expect(page.getByTestId('details-panel')).toContainText('src/app.ts');

  await pickView('districts');
  await expect(page.getByTestId('view-districts')).toHaveClass(/active/);
  await expect(page.getByTestId('dtile-src/app.ts')).toBeVisible();

  await pickView('canvas');
  await expect(page.getByTestId('gcard-src/app.ts')).toBeVisible();
  await expect.poll(async () => (await readStats()).nodes).toBe(before.nodes);
});

test('the view explains itself: lens reading, zoom readout, centre, cheat sheet', async () => {
  await page.getByTestId('tab-graph').click();
  /*
   * The strip carries the name and the scale; the prose is behind the ⓘ.
   *
   * Asserted with `useInnerText` throughout, because the explanation is still
   * in the DOM inside the popover — a plain toContainText reads textContent
   * and would pass whether or not any of this is visible, which is how a test
   * goes on looking green after it has stopped testing anything.
   */
  await pickLens('risk');
  await expect(page.getByTestId('lens-reading')).toContainText('Risk', { useInnerText: true });
  await expect(page.getByTestId('lens-reading')).not.toContainText('blast radius', {
    useInnerText: true,
  });
  await expect(page.getByTestId('lens-scale')).toBeVisible();

  // …and one hover surfaces it
  await page.getByTestId('lens-info').hover();
  await expect(page.locator('.lens-info-pop')).toBeVisible();
  await expect(page.locator('.lens-info-pop')).toContainText('blast radius');
  await page.getByTestId('lens-scale').hover();
  await expect(page.locator('.lens-info-pop')).toBeHidden();

  await pickLens('instability');
  await page.getByTestId('lens-info').hover();
  await expect(page.locator('.lens-info-pop')).toContainText('foundations');

  /*
   * A lens with nothing to colour keeps its note *inline*. That is not an
   * explanation of the lens — it is a fact about this repo, and the reason
   * there is no scale beside it, so hiding it would leave an empty legend.
   */
  await pickLens('tests');
  await expect(page.getByTestId('lens-reading')).toContainText('No test imports any file', {
    useInnerText: true,
  });
  await pickLens('clusters');

  // zoom controls report where they landed
  const readout = page.getByTestId('zoom-readout');
  const before = await readout.textContent();
  await page.getByTestId('zoom-fit').click();
  await expect.poll(async () => (await readout.textContent()) !== null).toBe(true);
  expect(before).toMatch(/%$/);

  // centring keeps the zoom it found — only the position moves
  const zoomBefore = await readout.textContent();
  await page.getByTestId('tool-center').click();
  await expect(readout).toHaveText(zoomBefore ?? '');

  // the cheat sheet is per-view and opens from the keyboard too
  await page.getByTestId('btn-help').click();
  await expect(page.getByTestId('help-overlay')).toContainText('Canvas view');
  await expect(page.getByTestId('help-overlay')).toContainText('shift + click');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help-overlay')).toBeHidden();
});

test('menu bar drives the app: submenu picks a lens, View switches tabs', async () => {
  await page.getByTestId('tab-graph').click();
  await page.getByTestId('menu-graph').click();
  await expect(page.getByTestId('menu-panel-graph')).toBeVisible();
  // hovering the bar switches menus, like a real menu bar
  await page.getByTestId('menu-view').hover();
  await expect(page.getByTestId('menu-panel-view')).toBeVisible();
  await expect(page.getByTestId('menu-panel-graph')).toBeHidden();

  // submenu: Graph > Colour by > Hotspots
  await page.getByTestId('menu-graph').hover();
  await page.getByTestId('menu-item-lens').hover();
  await page.getByTestId('menu-item-lens-hotspot').click();
  await expect(page.getByTestId('lens-hotspot')).toHaveClass(/active/);
  await expect(page.getByTestId('menu-panel-graph')).toBeHidden();
  await pickLens('clusters');

  // View > Insights switches the tab
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-item-tab-insights').click();
  await expect(page.getByTestId('insights-panel')).toBeVisible();
  await page.getByTestId('tab-graph').click();
});

test('a lens with nothing to colour says so instead of going blank', async () => {
  await page.getByTestId('tab-graph').click();
  // the fixture has no import cycles, so the graph would otherwise be a
  // uniform grey that reads as a broken lens
  await pickLens('cycles');
  await expect(page.getByTestId('lens-reading')).toContainText('No import cycles');
  await expect(page.getByTestId('lens-scale')).toHaveCount(0);

  // …and one that does have something to say keeps its scale
  await pickLens('risk');
  await expect(page.getByTestId('lens-scale')).toBeVisible();
  await pickLens('clusters');
});

test('explorer opens a terminal in the folder you right-clicked', async () => {
  await page.getByTestId('tree-dir-src').click({ button: 'right' });
  await expect(page.getByTestId('ctx-open-terminal')).toBeVisible();
  await page.getByTestId('ctx-open-terminal').click();
  // a second terminal appears, and its shell starts in src/. Terminal ids
  // carry a per-client prefix, so address the tabs by position.
  const tabs = page.locator('[data-testid^="terminal-tab-"]');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('terminal-panel').locator('.xterm-rows').last()).toContainText('src', {
    timeout: 25_000,
  });

  // leave the shared session as we found it: later tests drive terminal 1
  await tabs.nth(1).locator('.close').click();
  await expect(tabs).toHaveCount(1);
  await tabs.first().click();
});

test('legend click collapses a directory into a meta-node', async () => {
  const before = await readStats();
  await page.getByTestId('legend-src').click();
  // src files fold into one meta node
  await expect.poll(async () => (await readStats()).nodes).toBeLessThan(before.nodes);
  await page.getByTestId('legend-src').click();
  await expect.poll(async () => (await readStats()).nodes).toBe(before.nodes);
});

test('a card click selects, a folder double-click unfolds, and a drag moves it', async () => {
  // A drag takes the board out of hit-testing so the hover highlight is not
  // recomputed on every card the cursor crosses. That must not start until the
  // pointer has actually travelled: a click is a mousedown and a mouseup on the
  // same element, so disabling it any earlier turns every click into a miss.
  const card = page.getByTestId('gcard-src/app.ts');
  await card.click();
  await expect(card).toHaveClass(/\bsel\b/);

  const before = await card.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(before!.x + before!.width / 2 + i * 6, before!.y + before!.height / 2 + i * 3);
  }
  await page.mouse.up();
  await expect
    .poll(async () => Math.round(((await card.boundingBox())?.x ?? 0) - before!.x))
    .toBeGreaterThan(40);
  // dragging is not clicking elsewhere: the selection survives
  await expect(card).toHaveClass(/\bsel\b/);
  // and nothing is left in the drag skin once the button is up
  await expect(page.locator('.gcard.dragging')).toHaveCount(0);

  // folding, then re-opening by double-clicking the folder card itself
  const unfolded = await readStats();
  await page.getByTestId('legend-fold-all').click();
  await expect(page.getByTestId('stats')).toHaveText('2 nodes · 0 edges');
  await expect(page.getByTestId('legend')).toContainText('2/2 folded');
  await page.getByTestId('gcard-@dir:src').dblclick();
  // src alone comes back; tools stays a single card
  await expect(page.getByTestId('legend')).toContainText('1/2 folded');
  await expect(page.getByTestId('legend')).toContainText('▾ src');
  await expect(page.getByTestId('legend')).toContainText('▣ tools');
  await page.getByTestId('legend-unfold-all').click();
  await expect.poll(async () => (await readStats()).nodes).toBe(unfolded.nodes);
  // drop the drag override so later tests see the deterministic layout
  await page.getByTestId('layout-reset').click();
});

test('ctrl+drag selects a set, keeps the graph still, and offers what to do with it', async () => {
  await page.getByTestId('tab-graph').click();
  // start from no selection: earlier tests leave one
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bulk-bar')).toBeHidden();

  const positions = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.gcard')].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.getAttribute('data-id')!, `${Math.round(r.x)},${Math.round(r.y)}`];
        }),
      ),
    );
  // a known board: everything unfolded and framed, so the rectangle has
  // something to catch wherever earlier tests left the view
  if (await page.getByTestId('legend-unfold-all').isEnabled()) {
    await page.getByTestId('legend-unfold-all').click();
  }
  await page.getByTestId('zoom-fit').click();
  await page.waitForTimeout(600);

  // the baseline is the settled board, not whatever was on screen before it
  // was normalised — unfolding and framing move cards, and are meant to
  const before = await positions();

  const box = (await page.locator('.canvas-view').boundingBox())!;
  // start well below the toolbar overlay: a mousedown on it is not a box drag,
  // and that is deliberate
  const top = box.y + 200;
  await page.keyboard.down('Control');
  await page.mouse.move(box.x + 20, top);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 20 + (i * (box.width - 60)) / 12, top + (i * (box.y + box.height - 40 - top)) / 12);
  }
  await page.mouse.up();
  await page.keyboard.up('Control');

  // the set is offered actions where the set is, rather than only behind a
  // right-click nobody tries after dragging a rectangle
  await expect(page.getByTestId('bulk-bar')).toBeVisible();
  await expect(page.getByTestId('bulk-bar')).toContainText('selected');
  await expect(page.getByTestId('bulk-copy')).toBeVisible();
  await expect(page.getByTestId('bulk-delete')).toBeVisible();

  /*
   * Nothing moved. Selecting used to set the primary selection too, which
   * opened the details panel, narrowed the canvas and re-wrapped the layout —
   * so every card jumped out from under the rectangle just drawn.
   */
  const after = await positions();
  const moved = Object.keys(before).filter((id) => after[id] && after[id] !== before[id]);
  expect(moved, 'cards that moved during a box-select').toEqual([]);

  // the selection survives, and copying it yields the structured brief
  const count = Number(/(\d+) file/.exec((await page.getByTestId('bulk-bar').textContent()) ?? '')?.[1] ?? 0);
  expect(count).toBeGreaterThan(1);
  expect(await page.locator('.gcard.msel, .gcard.sel').count()).toBe(count);

  await page.getByTestId('bulk-copy').click();
  await expect
    .poll(() => page.evaluate(() => window.flare!.invoke('clipboard:read', []) as Promise<string>), { timeout: 8000 })
    .toContain('/');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bulk-bar')).toBeHidden();
});

test('symbol drill-down explodes a file and collapses back', async () => {
  const before = await readStats();
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await page.getByTestId('btn-expand-symbols').click();
  // util.ts becomes hub + its symbols -> node count grows
  await expect.poll(async () => (await readStats()).nodes).toBeGreaterThan(before.nodes);
  await page.getByTestId('btn-collapse-symbols').click();
  await expect.poll(async () => (await readStats()).nodes).toBe(before.nodes);
});

test('command palette jumps to a file', async () => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('helper');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toBeHidden();
  await expect(page.getByTestId('tab-file:src/lib/helper.ts')).toBeVisible();
  await page.getByTestId('tab-graph').click();
});

test('multi-select with structured copy-paths, create and delete via context menu', async () => {
  // plain-click selects the first file; the extend-selection modifier adds to it
  // (wrapped in toPass — modifier clicks can be racy right after heavy churn)
  //
  // `ControlOrMeta`, not `Control`: the app takes either (`e.ctrlKey ||
  // e.metaKey`), but macOS turns a literal ctrl+click into a *secondary*
  // click, so the row would open its context menu instead of joining the
  // selection and the chip would never say "2 selected".
  await expect(async () => {
    await page.getByTestId('tree-file-src/app.ts').click();
    await page.getByTestId('tree-file-src/util.ts').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('selection-chip')).toContainText('2 selected', { timeout: 2500 });
  }).toPass({ timeout: 25_000 });
  await page.getByTestId('tab-graph').click();

  // context menu on a selected row → structured copy of the whole selection
  await page.getByTestId('tree-file-src/app.ts').click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await expect(page.getByTestId('ctx-copy-paths')).toContainText('Copy 2 paths');
  await page.getByTestId('ctx-copy-paths').click();
  await expect
    .poll(() => page.evaluate(() => window.flare!.invoke('clipboard:read', []) as Promise<string>), { timeout: 8000 })
    .toBe('src/\n  app.ts\n  util.ts');

  // create a file inside src via the folder's context menu
  await page.getByTestId('tree-dir-src').click({ button: 'right' });
  await page.getByTestId('ctx-new-file').click();
  const input = page.getByTestId('modal-input');
  await expect(input).toHaveValue('src/');
  await input.fill('src/fresh.ts');
  await page.getByTestId('modal-confirm').click();
  await expect(page.getByTestId('tree-file-src/fresh.ts')).toBeVisible({ timeout: 20_000 });

  // Delete it again. This takes a shadow snapshot first so the delete stays
  // restorable, and under a loaded machine that has run within a second of the
  // old 10s budget — long enough to fail the suite for no real reason.
  await page.getByTestId('tree-file-src/fresh.ts').click({ button: 'right' });
  await page.getByTestId('ctx-delete').click();
  await page.getByTestId('modal-confirm').click();
  await expect(page.getByTestId('tree-file-src/fresh.ts')).toBeHidden({ timeout: 20_000 });
  await page.getByTestId('btn-approve-all').click();
});

test('explorer header creates folders, targets the selection, and collapses the tree', async () => {
  // with a file selected, "new" means "next to that file", and the header says so
  await page.getByTestId('tree-file-src/app.ts').click();
  await expect(page.getByTestId('explorer-head')).toContainText('src/');

  await page.getByTestId('explorer-new-folder').click();
  const input = page.getByTestId('modal-input');
  await expect(input).toHaveValue('src/');
  await input.fill('src/widgets');
  await page.getByTestId('modal-confirm').click();
  // an empty folder has no files, so only the tree can show it
  await expect(page.getByTestId('tree-dir-src/widgets')).toBeVisible({ timeout: 10_000 });

  // collapse-all folds the whole tree, including the top level
  await page.getByTestId('explorer-collapse-all').click();
  await expect(page.getByTestId('tree-file-src/app.ts')).toBeHidden();
  await page.getByTestId('tree-dir-src').click();
  await expect(page.getByTestId('tree-file-src/app.ts')).toBeVisible();

  // clean up: the folder is empty, so this leaves no git noise
  await page.getByTestId('tree-dir-src/widgets').click({ button: 'right' });
  await page.getByTestId('ctx-delete').click();
  await page.getByTestId('modal-confirm').click();
  await expect(page.getByTestId('tree-dir-src/widgets')).toBeHidden({ timeout: 10_000 });
});

test('ingests lcov coverage: lens appears live and details show percentages', async () => {
  await page.getByTestId('tab-graph').click();
  // no coverage file yet -> no coverage lens
  await expect(page.getByTestId('lens-coverage')).toHaveCount(0);
  write(
    'coverage/lcov.info',
    'SF:src/util.ts\nDA:1,1\nDA:2,0\nend_of_record\nSF:src/app.ts\nLF:4\nLH:4\nend_of_record\n',
  );
  // the dedicated lcov watcher picks it up without a restart. The option
  // lives in the Lens menu now, so "appears" means it joins the menu.
  await expect(page.getByTestId('lens-coverage')).toHaveCount(1, { timeout: 15_000 });
  await pickLens('coverage');
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('coverage-row')).toContainText('50% (1/2 lines)');
  await pickLens('clusters');
});

test('insights: unified metrics table, issue feed, live todo-debt alert', async () => {
  await page.getByTestId('tab-insights').click();
  await expect(page.getByTestId('insights-summary')).toBeVisible();
  await expect(page.getByTestId('insights-summary')).toContainText('files');
  // metrics table covers the code files
  expect(await page.getByTestId('metrics-table').locator('tbody tr').count()).toBeGreaterThanOrEqual(5);
  // deterministic issue: tools/script.py is an orphan (nothing imports it)
  await expect(page.getByTestId('issue-orphan').filter({ hasText: 'script.py' }).first()).toBeVisible();

  // live rule evaluation: TODO debt appears after an external edit
  fs.appendFileSync(path.join(fixture, 'src', 'util.ts'), '\n// TODO a\n// FIXME b\n// TODO c\n');
  await expect(page.getByTestId('issue-todo-debt').first()).toContainText('util.ts', { timeout: 20_000 });

  // Every metric column reads on one 0–100 scale, so a row can be scanned
  // across; the raw counts are one click away, not gone.
  const sizeCell = page.getByTestId('metrics-row-src/util.ts').locator('td').nth(5);
  await expect(sizeCell).toHaveText(/^\d+$/);
  await page.getByTestId('units-raw').click();
  await expect(sizeCell).toContainText('lines');
  await page.getByTestId('units-scaled').click();
  await expect(sizeCell).toHaveText(/^\d+$/);

  // clicking a metrics row selects the file in the details panel
  await page.getByTestId('metrics-row-src/util.ts').click();
  await expect(page.getByTestId('details-panel')).toContainText('src/util.ts');

  // The details panel and the table must quote the same risk. They used to
  // disagree — a raw unbounded score in one, a 0-100 composite in the other,
  // both labelled "risk" — and a number you cannot reconcile is worse than no
  // number. The panel also has to state the scale, not just the value.
  const tableRisk = (
    await page.getByTestId('metrics-row-src/util.ts').locator('td').nth(1).textContent()
  )?.trim();
  await expect(page.getByTestId('risk-score')).toHaveText(new RegExp(`^${tableRisk}/100 · `));

  await page.getByTestId('btn-approve-all').click();
  await page.getByTestId('tab-graph').click();
});

test('review cockpit: burst evidence, smells, tiering and walkthrough', async () => {
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('review-panel')).toBeVisible();

  // an edit that weakens its own test is exactly what the smell rules are for
  fs.writeFileSync(
    path.join(fixture, 'src', 'util.ts'),
    `export function util() {\n  // @ts-ignore\n  return 1 as any;\n}\n`,
  );
  fs.writeFileSync(
    path.join(fixture, 'src', 'util.test.ts'),
    `import { util } from './util';\nit.skip('util', () => { expect(util()).toBe(1); });\n`,
  );

  const burst = page.locator('.burst').first();
  await expect(burst).toBeVisible({ timeout: 20_000 });
  // nothing ran after the edit, so the change is explicitly unverified
  await expect(burst.locator('.verify-pill')).toHaveText('never checked', { timeout: 20_000 });
  await expect(burst).toContainText('No intent recorded');

  // the shortcuts an agent takes are named, not just counted
  await expect(page.getByTestId('smell-test-disabled')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('smell-suppression-added')).toBeVisible();
  await expect(page.getByTestId('smell-test-follows-source')).toBeVisible();

  // risk tiering: every file says why it got the attention it did, and the
  // load-bearing one sorts above the brand-new test that nothing imports
  const utilRow = page.getByTestId('brow-src/util.ts');
  await expect(utilRow).toBeVisible();
  await expect(utilRow).toContainText(/break if this is wrong|imports? it/);
  const order = await burst.locator('.brow .brow-path').allTextContents();
  expect(order.indexOf('src/util.ts')).toBeLessThan(order.indexOf('src/util.test.ts'));

  // walkthrough steps the graph through the files, worst-risk first
  await burst.getByRole('button', { name: /Walk through/ }).click();
  await expect(page.getByTestId('walkbar')).toContainText('1 / ');
  await page.getByTestId('walk-next').click();
  await expect(page.getByTestId('walkbar')).toContainText('2 / ');
  await page.getByTestId('walk-exit').click();
  await expect(page.getByTestId('walkbar')).toBeHidden();

  // opening a file is what clears "unread" — approving alone is only a claim.
  // The option sits in the Lens menu, so present-in-the-menu is the check.
  await expect(page.getByTestId('lens-unread')).toHaveCount(1);
  await page.getByTestId('btn-approve-all').click();
  await page.getByTestId('tab-graph').click();
});

test('task board: file from a selection, customizable lanes, copy carries graph context', async () => {
  await page.getByTestId('tab-graph').click();
  // file the current graph selection as a task without leaving the graph
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await page.getByTestId('tree-file-src/util.ts').click({ button: 'right' });
  await page.getByTestId('ctx-new-task').click();
  await expect(page.getByTestId('board-panel')).toBeVisible();

  const card = page.locator('.task-card').first();
  await expect(card).toContainText('util.ts');

  // the copy payload is the whole point: brief plus what the graph knows
  await card.locator('.task-title').click();
  await page.getByTestId('task-title-input').fill('Harden the util helper');
  await page.getByTestId('task-brief-input').fill('Callers assume it never throws.');
  await page.getByTestId('task-save').click();
  const brief = await page.evaluate(async () => {
    const board = (await window.flare!.invoke('board:get', [])) as { tasks: { id: string }[] } | null;
    return board ? window.flare!.invoke('board:format', [board.tasks[0].id]) : null;
  });
  expect(brief).toContain('# Harden the util helper');
  expect(brief).toContain('Callers assume it never throws.');
  expect(brief).toContain('src/util.ts');
  // util.ts is imported by app.ts, helper.ts and brand-new.ts
  expect(brief).toMatch(/downstream|importer/);

  // lanes are customizable, and removing one rehomes its tasks rather than
  // dropping them
  await page.getByTestId('board-add-lane').click();
  await page.getByTestId('modal-input').fill('Blocked');
  await page.getByTestId('modal-confirm').click();
  await expect(page.getByTestId('lane-blocked')).toBeVisible();
  await page.getByTestId('lane-remove-blocked').click();
  await expect(page.getByTestId('lane-blocked')).toBeHidden();
  await expect(page.locator('.task-card')).toHaveCount(1);
});

test('MCP exposes the board by lane and an agent can move a task', async () => {
  const url = 'http://127.0.0.1:7411/mcp';
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    return json.result?.content?.[0]?.text ?? '';
  };

  // an agent files follow-up work it should not do right now
  const filed = await call('task_create', {
    title: 'Add a regression test for the resolver',
    brief: 'Scoped imports are unresolved.',
    paths: ['src/util.ts'],
  });
  expect(filed).toContain('filed');

  // …then pulls its next task by lane
  const todo = await call('tasks_list', { lane: 'to do' });
  expect(todo).toContain('Add a regression test for the resolver');
  expect(todo).toContain('Harden the util helper');

  // a bad lane name explains itself instead of failing silently
  expect(await call('tasks_list', { lane: 'nowhere' })).toContain('no lane called');

  // task_get returns exactly what a human would have pasted
  const id = 'add-a-regression-test-for-the-resolver';
  const brief = await call('task_get', { id });
  expect(brief).toContain('# Add a regression test for the resolver');
  expect(brief).toContain('src/util.ts');

  // moving it to review shows up in the UI without a reload
  expect(await call('task_update', { id, lane: 'to review', note: 'Test added, awaiting eyes.' })).toContain(
    'moved to To review',
  );
  await page.getByTestId('tab-board').click();
  await expect(page.getByTestId('lane-review').locator('.task-card')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId('lane-review')).toContainText('1 note');
  await page.getByTestId('tab-graph').click();
});

/**
 * A theme is one block of tokens, and everything follows it.
 *
 * Three things in the app draw outside CSS — the graph, the editor and the
 * terminal — and each of them used to carry its own hard-coded palette. So the
 * assertions here are deliberately not "the stylesheet changed": they check a
 * colour that comes from the stylesheet, one that Monaco resolved, and one the
 * canvas painted, because those are the three that can independently fail.
 */
test('the theme switches the whole app, and is remembered', async () => {
  const bg = (selector: string) =>
    page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const cardColour = () =>
    page.locator('.gcard').first().evaluate((el) => getComputedStyle(el).backgroundColor);

  const pick = async (id: 'system' | 'dark' | 'light') => {
    await page.getByTestId('menu-view').click();
    await page.getByTestId('menu-item-theme').hover();
    await page.getByTestId(`menu-item-theme-${id}`).click();
  };

  await page.getByTestId('tab-graph').click();
  await expect(page.locator('.gcard').first()).toBeVisible();
  /*
   * Pin dark first rather than assuming it.
   *
   * The default follows the desktop, so on a machine set to light this test
   * used to start light and then "switch" to light — and pass by measuring
   * nothing at all.
   */
  await pick('dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  const darkApp = await bg('body');
  const darkCard = await cardColour();
  const darkEditor = await bg('.monaco-editor .monaco-editor-background').catch(() => '');

  await pick('light');

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe('light');
  // the stylesheet: every rule resolves against the palette that matches
  await expect.poll(() => bg('body')).not.toBe(darkApp);
  // the canvas: colours it read out of the tokens, through a memo that has to
  // know the theme changed or it keeps the palette it was built with
  await expect.poll(cardColour).not.toBe(darkCard);

  // a light theme is only light if it is actually light
  const lightApp = await bg('body');
  const channels = /(\d+), (\d+), (\d+)/.exec(lightApp)!.slice(1).map(Number);
  expect(channels.every((c) => c > 200)).toBe(true);

  // and it survives the app being reopened
  await page.reload();
  await page.waitForSelector('[data-testid="menubar"]', { timeout: 40_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe('light');

  await page.getByTestId('tab-graph').click();
  if (darkEditor) {
    // the editor is themed from the same tokens rather than from vs-dark
    await expect.poll(() => bg('.monaco-editor .monaco-editor-background')).not.toBe(darkEditor);
  }

  // back to dark, so the rest of the suite sees what it expects
  await pick('dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

test('the control panel carries decisions and questions, and the routine says what to do next', async () => {
  const url = 'http://127.0.0.1:7411/mcp';
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    return json.result?.content?.[0]?.text ?? '';
  };

  // ---- the human sets the routine, in the wizard
  await page.getByTestId('tab-board').click();
  await page.getByTestId('board-routine').click();
  await expect(page.getByTestId('routine-wizard')).toBeVisible();
  await page.getByTestId('routine-notes').fill('never touch shared/types.ts without asking');
  // the decision rule is a choice, not a switch: flag it and keep building, or
  // park the work that rests on it. The preview has to change with it.
  await page.getByTestId('routine-decisions-park').click();
  await page.getByTestId('routine-next').click();
  // the agreement is generated from the switches, so it already reads as the rules
  const agreementBox = page.getByTestId('routine-preview');
  await expect(agreementBox).toHaveValue(/Look at the board again/);
  await expect(agreementBox).toHaveValue(/leave the work that rests on it/);
  await expect(agreementBox).toHaveValue(/never touch shared\/types\.ts/);
  await page.getByTestId('routine-back').click();
  await page.getByTestId('routine-decisions-flag').click();
  await page.getByTestId('routine-next').click();
  await expect(agreementBox).toHaveValue(/carry on and build on it/);
  await page.getByTestId('routine-save').click();
  await expect(page.getByTestId('routine-wizard')).toHaveCount(0);

  // ---- and the agent reads it back, with the state of the board attached
  const agreement = await call('working_agreement');
  expect(agreement).toContain('# Working agreement');
  expect(agreement).toContain('Park questions instead of halting');
  expect(agreement).toContain('never touch shared/types.ts');

  /*
   * ---- and it can be rewritten, because the switches cover what every
   * project wants and nothing of what this one wants said in its own words.
   * What is not editable is the board state Flare appends: that is counted
   * when the agent asks, so a hand-written copy would go stale immediately.
   */
  await page.getByTestId('board-routine').click();
  await page.getByTestId('routine-next').click();
  await page.getByTestId('routine-preview').fill('# How we work here\n\nSmall commits. Ask before touching the parser.');
  await page.getByTestId('routine-save').click();

  const mine = await call('working_agreement');
  expect(mine).toContain('Ask before touching the parser');
  expect(mine).not.toContain('Look at the board again');
  expect(mine).toContain('## Right now');

  // and it goes back to being generated when the edits are thrown away
  await page.getByTestId('board-routine').click();
  await page.getByTestId('routine-next').click();
  await page.getByTestId('routine-reset').click();
  await expect(page.getByTestId('routine-preview')).toHaveValue(/Look at the board again/);
  await page.getByTestId('routine-save').click();
  expect(await call('working_agreement')).toContain('Look at the board again');

  // ---- a decision arrives proposed, and the agent cannot agree with itself
  const recorded = await call('decision_record', {
    title: 'Resolve scoped imports in the resolver',
    detail: 'Keeps the parser dependency-free.',
    alternatives: 'A resolver plugin — rejected, one more moving part.',
    paths: ['src/util.ts'],
  });
  expect(recorded).toContain('waiting for a human to agree');
  // and the reply repeats the project's own rule at the moment it matters
  expect(recorded).toContain('carry on and build on it');
  expect(await call('decisions_list', { status: 'proposed' })).toContain('[proposed]');

  await page.getByTestId('collab-nav-decisions').click();
  const decision = page.getByTestId('decision-resolve-scoped-imports-in-the-resolver');
  await expect(decision).toBeVisible();
  await expect(decision).toContainText('waiting on you');
  await expect(decision).toContainText('Keeps the parser dependency-free');

  // ---- a question parks the work it names and nothing else
  // its own task, so the block is this test's rather than another one's
  await call('task_create', { title: 'Teach the resolver about symlinks' });
  const asked = await call('question_ask', {
    text: 'Should the resolver follow symlinks?',
    detail: 'Changes what counts as one file.',
    blocks: ['teach-the-resolver-about-symlinks'],
  });
  // the answer to "what now" comes back with the question, not afterwards
  expect(asked).toContain('asked');
  expect(asked).toMatch(/Take "|No work left|waiting on an answer/);

  await page.getByTestId('collab-nav-questions').click();
  const question = page.getByTestId('question-should-the-resolver-follow-symlinks');
  await expect(question).toBeVisible();
  await expect(question).toContainText('waiting on you');
  await expect(question).toContainText('Holds up');

  // ---- the human answers, and the agent sees it and the unblocked task
  await page.getByTestId('question-answer-input-should-the-resolver-follow-symlinks').fill(
    'No — treat a symlink as an ordinary file.',
  );
  await page.getByTestId('question-answer-should-the-resolver-follow-symlinks').click();
  await expect(question).toContainText('answered');

  const answers = await call('questions_list');
  expect(answers).toContain('No — treat a symlink as an ordinary file.');
  expect(await call('working_agreement')).toContain('0 blocked by an unanswered question');

  // ---- agreeing to the decision clears it from what the agent is waiting on
  await page.getByTestId('collab-nav-decisions').click();
  await page
    .getByTestId('decision-verdict-resolve-scoped-imports-in-the-resolver')
    .fill('Agreed — keep the parser clean.');
  await page.getByTestId('decision-agree-resolve-scoped-imports-in-the-resolver').click();
  await expect(decision).toContainText('agreed');
  expect(await call('decisions_list', { status: 'agreed' })).toContain('Human said: Agreed');
  expect(await call('working_agreement')).toContain('0 design decisions waiting to be agreed');

  await page.getByTestId('collab-nav-tasks').click();
  await page.getByTestId('tab-graph').click();
});

/**
 * The heartbeat, end to end: switching it on writes a stop hook into the
 * project, and the endpoint that hook calls answers with the board.
 *
 * This is the one rule that does not rely on the agent having read anything,
 * so it is also the one that has to work without it — which means testing the
 * plain HTTP endpoint a `curl` in a hook would hit, not an MCP tool.
 */
test('the heartbeat installs a stop hook and answers it from the board', async () => {
  const stopHook = async (body: unknown = {}): Promise<Record<string, unknown>> => {
    const res = await fetch('http://127.0.0.1:7411/hook/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const settings = path.join(fixture, '.claude', 'settings.local.json');

  // off by default: nothing written into the project, and no session held open
  expect(fs.existsSync(settings)).toBe(false);
  expect(await stopHook()).not.toHaveProperty('decision');

  await page.getByTestId('tab-board').click();
  await page.getByTestId('board-routine').click();
  // one setting, three values: switching it on picks the stop hook, and the
  // timer is the other radio rather than a second switch that could also be on
  await page.getByTestId('routine-heartbeat-on').click();
  await expect(page.getByTestId('routine-heartbeat-stop-hook')).toBeVisible();
  await expect(page.getByTestId('routine-heartbeat-timer')).toBeVisible();
  await page.getByTestId('routine-next').click();
  await expect(page.getByTestId('routine-preview')).toContainText('when you try to stop');
  await page.getByTestId('routine-save').click();

  await expect.poll(() => fs.existsSync(settings), { timeout: 5000 }).toBe(true);
  const hook = JSON.parse(fs.readFileSync(settings, 'utf8'));
  expect(hook.hooks.Stop[0].hooks[0].command).toContain('/hook/');

  // a board with workable cards hands one back instead of letting it stop
  await page.getByTestId('collab-nav-tasks').click();
  await page.getByTestId('lane-add-todo').click();
  await page.getByTestId('task-title-input').fill('Teach the resolver about symlinks');
  await page.getByTestId('task-save').click();

  const blocked = await stopHook();
  expect(blocked.decision).toBe('block');
  // and it names a card, because "keep going" on its own is an instruction to
  // guess. Which card depends on what else this run left on the board.
  expect(String(blocked.reason)).toMatch(/nobody has started/);
  expect(String(blocked.reason)).toMatch(/Take "[^"]+"/);

  // …but never twice in a row for the same stop, or the session cannot end
  expect(await stopHook({ stop_hook_active: true })).not.toHaveProperty('decision');

  /*
   * And never a card another agent has already started.
   *
   * The hook has no idea which agent it is answering, so the only safe answer
   * is one nobody has claimed. Claiming each card it offers must therefore
   * empty it out — if a claimed card could come back, two agents would be sent
   * at the same brief, over and over.
   */
  const mcp = async (name: string, args: Record<string, unknown>): Promise<void> => {
    await fetch('http://127.0.0.1:7411/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  };
  const offered = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const answer = await stopHook();
    if (answer.decision !== 'block') break;
    const id = /Take "[^"]+" \(([^)]+)\)/.exec(String(answer.reason))?.[1];
    expect(id).toBeTruthy();
    // the same card must never be offered twice once it has been claimed
    expect(offered.has(id!)).toBe(false);
    offered.add(id!);
    await mcp('task_update', { id, lane: 'in progress' });
  }
  expect(offered.size).toBeGreaterThan(0);
  expect(await stopHook()).not.toHaveProperty('decision');

  // choosing the timer instead takes the hook out of the project: the two
  // mechanisms are exclusive, so picking one is switching the other off
  await page.getByTestId('board-routine').click();
  await page.getByTestId('routine-heartbeat-timer').click();
  await page.getByTestId('routine-next').click();
  await page.getByTestId('routine-save').click();
  await expect
    .poll(() => JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.Stop ?? null, { timeout: 5000 })
    .toBe(null);
  expect(await stopHook()).not.toHaveProperty('decision');

  // and switching the whole thing off leaves nothing behind either
  await page.getByTestId('board-routine').click();
  await page.getByTestId('routine-heartbeat-on').click();
  await page.getByTestId('routine-next').click();
  await page.getByTestId('routine-save').click();
  await expect
    .poll(() => JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.Stop ?? null, { timeout: 5000 })
    .toBe(null);
  expect(await stopHook()).not.toHaveProperty('decision');

  await page.getByTestId('tab-graph').click();
});

/**
 * Two agents in one repo, coordinating in the room.
 *
 * The whole feature rests on a chain no unit test can span end to end: two MCP
 * sessions become two *named* agents, what one of them says lands in the panel
 * a human is looking at, and the second one is told about it when it goes for
 * the same file. Nothing is blocked anywhere along that chain — the point is
 * that the crossing is *visible*, not that it is prevented.
 */
test('two agents coordinate in the channel, and the panel shows who is where', async () => {
  const url = 'http://127.0.0.1:7411/mcp';
  /** Open a session the way a real client does, and keep its id. */
  const connect = async (client: string): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: client, version: '1' } },
      }),
    });
    await res.json();
    return res.headers.get('mcp-session-id') ?? '';
  };
  const asAgent = async (
    session: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    return json.result?.content?.[0]?.text ?? '';
  };

  const one = await connect('claude-code');
  const two = await connect('codex');
  expect(one).not.toBe(two);

  // two sessions of two different tools get two names a person can say aloud
  expect(await asAgent(one, 'chat_post', {
    kind: 'taking',
    paths: ['src/util.ts'],
    text: 'splitting the date helpers out',
  })).toContain('Claude 1');

  // the second agent going for the same file is told who is in it — and is not
  // stopped, because there is no lock here to stop it with
  const answer = await asAgent(two, 'chat_post', {
    kind: 'taking',
    paths: ['src/util.ts'],
    text: 'need the same file for the parser fix',
  });
  expect(answer).toContain('Codex 1');
  expect(answer).toContain('HEADS UP');
  expect(answer).toContain('Claude 1');

  // ---- and all of it is on screen, without a reload
  await page.getByTestId('tab-channel').click();
  const room = page.getByTestId('channel-panel');
  await expect(page.getByTestId('channel-feed')).toContainText('splitting the date helpers out');
  await expect(page.getByTestId('channel-roster')).toContainText('Claude 1');
  await expect(page.getByTestId('channel-roster')).toContainText('Codex 1');
  // the one thing neither agent can see for itself: both of them heading for
  // the same file, before either has written anything
  await expect(page.getByTestId('channel-clash')).toContainText('src/util.ts');

  // the filters narrow the transcript to one voice
  await page.getByTestId('channel-filter-mcp:' + one).click();
  await expect(page.getByTestId('channel-feed')).not.toContainText('need the same file');
  await page.getByTestId('channel-filter-all').click();
  await expect(page.getByTestId('channel-feed')).toContainText('need the same file');

  // the human is in the same room on the same terms, and the agents read it
  await page.getByTestId('chat-input').fill('leave src/util.ts to Claude 1 please');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('channel-feed')).toContainText('leave src/util.ts to Claude 1');
  expect(await asAgent(two, 'chat_read')).toContain('leave src/util.ts to Claude 1');

  // handing it back clears the mark, and only its own owner can do that
  expect(await asAgent(two, 'chat_post', { kind: 'done', paths: ['src/util.ts'], text: 'all yours' })).toContain(
    'posted as Codex 1',
  );
  await expect(page.getByTestId('channel-clash')).toHaveCount(0);
  await expect(room).toContainText('Claude 1');

  await page.getByTestId('tab-graph').click();
});

test('MCP server answers graph queries over HTTP', async () => {
  const url = 'http://127.0.0.1:7411/mcp';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = async (method: string, params?: unknown, id: number | null = 1): Promise<any> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    });
    if (id === null) return res.status;
    return res.json();
  };

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  expect(init.result.serverInfo.name).toBe('flare');
  expect(await rpc('notifications/initialized', {}, null)).toBe(202);

  const tools = await rpc('tools/list', {}, 2);
  const names = tools.result.tools.map((t: { name: string }) => t.name);
  for (const expected of ['graph_overview', 'file_info', 'dependents', 'find_path', 'issues', 'top_files', 'search', 'impact_of', 'recent_activity']) {
    expect(names).toContain(expected);
  }

  const overview = await rpc('tools/call', { name: 'graph_overview', arguments: {} }, 3);
  expect(overview.result.content[0].text).toContain('clusters:');
  expect(overview.result.content[0].text).toContain('src');

  const info = await rpc('tools/call', { name: 'file_info', arguments: { path: 'src/util.ts' } }, 4);
  expect(info.result.content[0].text).toContain('imported by');

  const impact = await rpc('tools/call', { name: 'impact_of', arguments: { paths: ['src/util.ts'] } }, 5);
  expect(impact.result.content[0].text).toContain('downstream impact');

  const chain = await rpc('tools/call', { name: 'find_path', arguments: { from: 'src/app.ts', to: 'src/util.ts' } }, 6);
  expect(chain.result.content[0].text).toContain('src/app.ts');

  // graceful failure for unknown tool
  const bad = await rpc('tools/call', { name: 'nope', arguments: {} }, 7);
  expect(bad.error.code).toBe(-32602);
});

test('multiple sessions share one gateway with stable per-project routing', async () => {
  test.setTimeout(120_000);
  const url = 'http://127.0.0.1:7411/mcp';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcAt = async (endpoint: string, name: string, args: unknown = {}, id = 1): Promise<any> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    return res.json();
  };

  // a second Flare instance on a second project, same public port + registry
  const fixture2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-proj2-'));
  const userData2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-data2-'));
  fs.writeFileSync(path.join(fixture2, 'solo.ts'), 'export const solo = 1;\n');
  const app2 = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      FLARE_PROJECT: fixture2,
      FLARE_USERDATA: userData2,
      FLARE_MCP_PORT: '7411',
      FLARE_MCP_REGISTRY: mcpRegistryDir,
    },
  });
  try {
    await (await app2.firstWindow()).waitForSelector('[data-testid="statusbar"]', { timeout: 25_000 });

    // list_projects sees both sessions with their stable URLs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listText = '';
    await expect
      .poll(async () => {
        listText = (await rpcAt(url, 'list_projects')).result.content[0].text as string;
        return listText;
      }, { timeout: 20_000 })
      .toContain('proj2');
    const slugs = [...listText.matchAll(/\/mcp\/([\w-]+)/g)].map((m) => m[1]);
    expect(slugs.length).toBe(2);
    const lines = listText.split('\n');
    const proj2Line = lines.findIndex((l) => l.includes('proj2'));
    const slug2 = /\/mcp\/([\w-]+)/.exec(lines[proj2Line + 1])![1];
    const slug1 = slugs.find((s) => s !== slug2)!;

    // bare /mcp is now ambiguous and says so
    const amb = await rpcAt(url, 'graph_overview');
    expect(amb.result.content[0].text).toContain('projects are open');

    // each stable slug URL reaches its own project (one of these is proxied)
    const o1 = await rpcAt(`${url}/${slug1}`, 'graph_overview');
    expect(o1.result.content[0].text).toContain(path.basename(fixture));
    const o2 = await rpcAt(`${url}/${slug2}`, 'graph_overview');
    expect(o2.result.content[0].text).toContain(path.basename(fixture2));
    expect(o2.result.content[0].text).toContain('files: 1');
  } finally {
    await app2.close();
    fs.rmSync(fixture2, { recursive: true, force: true });
    fs.rmSync(userData2, { recursive: true, force: true });
  }

  // with the second instance gone, its registry entry is pruned and the
  // bare endpoint routes to the surviving session again
  await expect
    .poll(async () => (await rpcAt(url, 'graph_overview')).result.content[0].text as string, {
      timeout: 20_000,
    })
    .toContain(path.basename(fixture));
});

test('detects an agent in the terminal, attributes its changes, logs its commands', async () => {
  test.setTimeout(120_000);
  /*
   * A fake agent: something called `claude` that stays alive for a while.
   *
   * Written per platform because the detection being tested is itself per
   * platform — a `.cmd` is not executable on Linux or macOS, so this test used
   * to pass on Windows and silently prove nothing anywhere else. It is the
   * unix branch (`ps`) that has the least coverage, so it is the one most
   * worth actually running.
   */
  const windows = process.platform === 'win32';
  const agent = windows
    ? { file: 'claude.cmd', body: '@echo off\r\nnode -e "setTimeout(function(){}, 25000)"\r\n', run: '.\\claude.cmd' }
    : { file: 'claude', body: '#!/bin/sh\nnode -e "setTimeout(function(){}, 25000)"\n', run: './claude' };
  write(agent.file, agent.body);
  if (!windows) fs.chmodSync(path.join(fixture, agent.file), 0o755);

  const panel = page.getByTestId('terminal-panel');
  await panel.locator('.terminal-body').click();
  await page.keyboard.type(agent.run);
  await page.keyboard.press('Enter');

  // agent badge appears on the terminal tab
  // terminal ids carry a per-client prefix, so match the badge by its role
  await expect(page.locator('[data-testid^="agent-badge-term-"]').first()).toContainText('claude', {
    timeout: 25_000,
  });

  // a change made while the agent is active is attributed to it
  fs.appendFileSync(path.join(fixture, 'src', 'util.ts'), '\nexport const agentTouched = 1;\n');
  await page.getByTestId('search-input').fill('util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('changed-by')).toContainText('claude', { timeout: 15_000 });

  // the command log recorded the invocation, whatever it was called
  await page.getByTestId('commands-toggle').click();
  await expect(page.getByTestId('command-log')).toContainText(agent.file, { timeout: 15_000 });
  const rows = page.getByTestId('command-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  await page.getByTestId('commands-toggle').click();
  await page.getByTestId('btn-approve-all').click();
});

test('opens to a start screen listing recent projects', async () => {
  // A separate launch with no FLARE_PROJECT: this is what a normal open
  // looks like. Launch used to restore the last project silently, which made
  // this screen — and every way to reach a different project — unreachable.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-start-data-'));
  const older = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-start-older-'));
  const now = Date.now();
  fs.writeFileSync(
    path.join(data, 'settings.json'),
    JSON.stringify({
      lastProject: fixture,
      recents: [
        { path: fixture, openedAt: now - 60_000 },
        older, // a bare string, the shape older builds wrote
      ],
    }),
  );

  const second = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      FLARE_PROJECT: '',
      FLARE_USERDATA: data,
      FLARE_MCP_PORT: '7412',
      FLARE_MCP_REGISTRY: mcpRegistryDir,
    },
  });
  try {
    const win = await second.firstWindow();
    await expect(win.getByTestId('start-screen')).toBeVisible({ timeout: 20_000 });
    await expect(win.getByTestId('open-folder')).toBeVisible();

    // both stored shapes are listed, newest first
    const rows = win.locator('.start-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(path.basename(fixture));
    await expect(rows.first()).toContainText('min ago');
    await expect(rows.nth(1)).toContainText(path.basename(older));

    // clicking one opens it, and the app leaves the start screen
    await rows.first().click();
    await expect(win.getByTestId('graph-container')).toBeVisible({ timeout: 20_000 });
    await expect(win.getByTestId('project-name')).toHaveText(path.basename(fixture));
  } finally {
    await second.close();
    for (const dir of [data, older]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // a lingering handle is not a test failure
      }
    }
  }
});

test('reuse: the metric, the lens and the blockers agree with each other', async () => {
  // enough logic in it to be worth asking the question, and nothing to stop it
  // being lifted out: no host, no framework, no project imports
  write(
    'src/pure.ts',
    `export function classify(n: number): string {\n  if (n < 0) return 'neg';\n  if (n === 0) return 'zero';\n  for (let i = 2; i < n; i += 1) {\n    if (n % i === 0) return 'composite';\n  }\n  return n > 1 ? 'prime' : 'one';\n}\n`,
  );
  await expect(page.getByTestId('tree-file-src/pure.ts')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('tab-insights').click();
  await expect(page.getByTestId('insights-summary')).toContainText('reuse');

  const pure = page.getByTestId('metrics-row-src/pure.ts').locator('td').nth(10);
  await expect(pure).toHaveText('100', { timeout: 20_000 });

  // src/util.ts is three lines: the question does not apply, which is not the
  // same as scoring badly, so it reads as "·" rather than as a number
  const thin = page.getByTestId('metrics-row-src/util.ts').locator('td').nth(10);
  await expect(thin).toHaveText('·');

  // and the details panel says the same number as the table
  await page.getByTestId('tab-graph').click();
  await page.getByTestId('search-input').fill('src/pure.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('reuse-score')).toContainText('100/100');
  await expect(page.getByTestId('reuse-score')).toContainText('self-contained');

  // the lens exists and says how to read itself, behind its ⓘ
  await pickLens('reuse');
  await page.getByTestId('lens-info').hover();
  await expect(page.locator('.lens-info-pop')).toContainText('come out as a package');
  await pickLens('clusters');
});

test('a file welded to the host scores low and names what welds it', async () => {
  write('src/io.ts', `import * as fs from 'node:fs';\nimport { util } from './util';\n\nexport function save(p: string) {\n  if (p) fs.writeFileSync(p, String(util()));\n  else if (p === '') throw new Error('no');\n  for (let i = 0; i < 3; i += 1) fs.appendFileSync(p, 'x');\n}\n`);
  await expect(page.getByTestId('tree-file-src/io.ts')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('tab-insights').click();
  const cell = page.getByTestId('metrics-row-src/io.ts').locator('td').nth(10);
  await expect(cell).toBeVisible({ timeout: 20_000 });
  const score = Number(await cell.innerText());
  expect(score).toBeLessThan(60);
  // and it says which import did it, rather than only that something did
  await expect(cell.locator('span')).toHaveAttribute('title', /fs/);
});

test('a task opens at full size, and Save is not where Delete was', async () => {
  await page.getByTestId('tab-board').click();
  const card = page.locator('.task-card').first();
  const id = (await card.getAttribute('data-testid'))!.replace('task-', '');

  // editing used to be reachable only by clicking the title, undiscoverably —
  // and then happened inside a 240px lane, which is not a size you can read a
  // brief or a progress log at
  await page.getByTestId(`task-edit-${id}`).click();
  await expect(page.getByTestId('task-modal')).toBeVisible();
  await expect(page.getByTestId('task-title-input')).toBeVisible();

  // the destructive action is at the far end from the primary one
  const actions = page.locator('.task-modal .task-actions button');
  await expect(actions.first()).toHaveText('Delete');
  await expect(actions.last()).toHaveText('Save');

  await page.getByTestId('task-title-input').fill('Edited from the button');
  await page.getByTestId('task-save').click();
  await expect(page.getByTestId('task-modal')).toHaveCount(0);
  await expect(page.locator('.task-card').first()).toContainText('Edited from the button');
});

test('the whole card opens the task, and Escape leaves it alone', async () => {
  await page.getByTestId('tab-board').click();
  const card = page.locator('.task-card').first();
  const before = await card.locator('.task-title-text').innerText();

  await card.dblclick();
  await expect(page.getByTestId('task-modal')).toBeVisible();

  // a typed-then-abandoned edit must not survive: the card is the truth
  await page.getByTestId('task-title-input').fill('Abandoned');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-modal')).toHaveCount(0);
  await expect(page.locator('.task-card').first().locator('.task-title-text')).toHaveText(before);
});

test('a selected node offers to start a task on it', async () => {
  await page.getByTestId('tab-graph').click();
  await page.getByTestId('search-input').fill('src/util.ts');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('details-panel')).toBeVisible();

  await page.getByTestId('btn-new-task').click();
  await expect(page.getByTestId('board-panel')).toBeVisible();
  // the new card is the one carrying the file we selected
  await expect(page.locator('.task-card').first()).toContainText('util.ts');
});

/**
 * Delete a temp folder, and do not fail the test if Windows will not yet.
 *
 * A folder the app has had open is still held by its watcher for a moment
 * after the project is closed, and `rmSync` answers EPERM — which failed the
 * test *after* every assertion in it had already passed. Cleaning up is not
 * the thing under test, so it retries briefly and then leaves it to the OS.
 */
function removeTemp(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // a handle is still open; give it a moment
      const until = Date.now() + 200;
      while (Date.now() < until) {
        /* spin: this is teardown, and the alternative is failing on it */
      }
    }
  }
}

test('New Project creates the folder and opens it', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-new-'));
  try {
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menu-panel-file')).toBeVisible();
    await page.getByTestId('menu-item-new-project').click();
    await expect(page.getByTestId('new-project-dialog')).toBeVisible();
    // opening an existing folder is the common case and leads; creating an
    // empty one is the second tab
    await expect(page.getByTestId('wizard-tab-open')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('wizard-tab-create').click();

    // the picker walks the backend's own filesystem, so it works the same in a
    // window and in a browser tab
    await page.getByTestId('picker-path').fill(parent);
    await page.getByTestId('picker-path').press('Enter');
    await expect(page.getByTestId('picker-list')).toBeVisible();

    await page.getByTestId('new-project-name').fill('fresh-service');
    await expect(page.getByTestId('new-project-target')).toContainText('fresh-service');
    await page.getByTestId('new-project-here').click();

    // the folder is created before anything is written into it, and the app is
    // now open on it
    await expect(page.getByTestId('project-name')).toHaveText('fresh-service', { timeout: 30_000 });
    expect(fs.existsSync(path.join(parent, 'fresh-service'))).toBe(true);
  } finally {
    // back to the fixture, which every later test assumes is open
    await page.evaluate((root) => window.flare!.invoke('project:open', [root]), fixture);
    await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture), {
      timeout: 30_000,
    });
    removeTemp(parent);
  }
});

test('New Project refuses a name that is a path, or a folder already in use', async () => {
  await page.getByTestId('menu-file').click();
  await expect(page.getByTestId('menu-panel-file')).toBeVisible();
  await page.getByTestId('menu-item-new-project').click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
  await page.getByTestId('wizard-tab-create').click();
  await page.getByTestId('picker-path').fill(fixture);
  await page.getByTestId('picker-path').press('Enter');

  await page.getByTestId('new-project-name').fill('nested/deep');
  await page.getByTestId('new-project-here').click();
  await expect(page.getByTestId('new-project-error')).toContainText('no slashes');

  // src/ exists in the fixture and has files in it
  await page.getByTestId('new-project-name').fill('src');
  await page.getByTestId('new-project-here').click();
  await expect(page.getByTestId('new-project-error')).toContainText('already exists');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-project-dialog')).toBeHidden();
});

test('the canvas offers drag-to-select without a modifier, and says which mode it is in', async () => {
  await page.getByTestId('tab-graph').click();
  // the mode lives on the canvas, as a tool palette, not in the toolbar
  const pan = page.getByTestId('tool-pan');
  const select = page.getByTestId('tool-select');
  await expect(page.getByTestId('canvas-tools')).toBeVisible();
  await expect(pan).toHaveAttribute('aria-checked', 'true');
  // each tool explains itself on hover, including the modifier that gets the other
  await expect(select).toHaveAttribute('title', /Ctrl/);
  await expect(pan).toHaveAttribute('title', /Ctrl/);

  await select.click();
  await expect(select).toHaveAttribute('aria-checked', 'true');
  await expect(pan).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('graph-container')).toHaveClass(/picking/);

  // a plain drag now picks files — no key held
  if (await page.getByTestId('legend-unfold-all').isEnabled()) {
    await page.getByTestId('legend-unfold-all').click();
  }
  await page.getByTestId('zoom-fit').click();
  await page.waitForTimeout(600);
  const box = (await page.locator('.canvas-view').boundingBox())!;
  // below the toolbar overlay, which is deliberately not a drag surface
  await page.mouse.move(box.x + 20, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 14 });
  await page.mouse.up();
  await expect(page.getByTestId('bulk-bar')).toBeVisible();
  const picked = await page.locator('.gcard.msel, .gcard.sel').count();
  expect(picked).toBeGreaterThan(1);

  await page.keyboard.press('Escape');
  // V swaps the tool, as it does in every other canvas
  await page.getByTestId('stats').click();
  await page.keyboard.press('v');
  await expect(pan).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('graph-container')).not.toHaveClass(/picking/);
});

test('an empty project says so, rather than rendering a blank canvas', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-empty-'));
  try {
    await page.evaluate((root) => window.flare!.invoke('project:open', [root]), empty);
    await expect(page.getByTestId('project-name')).toHaveText(path.basename(empty), {
      timeout: 30_000,
    });
    // a graph of nothing looks exactly like a broken one, and "New project"
    // lands here by definition
    await expect(page.getByTestId('graph-empty')).toBeVisible();
    await expect(page.getByTestId('graph-empty')).toContainText('No code here yet');
    await expect(page.getByTestId('graph-empty')).toContainText('being watched');
  } finally {
    await page.evaluate((root) => window.flare!.invoke('project:open', [root]), fixture);
    await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture), {
      timeout: 30_000,
    });
    try {
      fs.rmSync(empty, { recursive: true, force: true });
    } catch {
      // the watcher can still hold it briefly on Windows; not a test failure
    }
  }
});

test('the terminal copies and pastes with plain Ctrl+C / Ctrl+V, and still interrupts', async () => {
  await page.getByTestId('tab-graph').click();
  const panel = page.getByTestId('terminal-panel');
  await expect(panel.locator('.xterm')).toBeVisible();
  await panel.locator('.terminal-body').click();

  // paste puts the clipboard on the command line, unquoted and unbuttoned
  await page.evaluate(() => window.flare!.invoke('clipboard:write', ['echo pasted_by_ctrl_v']));
  await page.keyboard.press('Control+v');
  await expect(panel.locator('.xterm-rows')).toContainText('pasted_by_ctrl_v', { timeout: 20_000 });
  await page.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText('pasted_by_ctrl_v', { timeout: 20_000 });

  // with a selection, Ctrl+C copies it rather than interrupting
  await page.evaluate(() => window.flare!.invoke('clipboard:write', ['']));
  const rows = (await panel.locator('.xterm-screen').boundingBox())!;
  await page.mouse.move(rows.x + 4, rows.y + 6);
  await page.mouse.down();
  await page.mouse.move(rows.x + rows.width - 8, rows.y + rows.height - 8, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  await expect
    .poll(() => page.evaluate(() => window.flare!.invoke('clipboard:read', [])), { timeout: 10_000 })
    .toContain('pasted_by_ctrl_v');

  // and with nothing selected it is still an interrupt: start something that
  // does not end on its own, then stop it
  await panel.locator('.terminal-body').click();
  await page.keyboard.type('node -e "setInterval(()=>{},1000)"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Control+c');
  // the shell eats keystrokes typed before it has drawn its prompt again
  await page.waitForTimeout(2500);
  await page.keyboard.type('echo interrupt_worked');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText('interrupt_worked', { timeout: 25_000 });
});

test('the wizard opens an existing folder, which is the common case', async () => {
  await page.getByTestId('menu-file').click();
  await expect(page.getByTestId('menu-panel-file')).toBeVisible();
  await page.getByTestId('menu-item-new-project').click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
  // no folder name field on this tab: nothing is being created
  await expect(page.getByTestId('new-project-name')).toHaveCount(0);

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-e2e-existing-'));
  fs.mkdirSync(path.join(other, 'src'));
  fs.writeFileSync(path.join(other, 'src', 'thing.ts'), 'export const thing = 1;\n');
  try {
    // the dialog takes the path as it is typed, and the picker's own first
    // listing — still on its way — must not land on top of it
    await page.getByTestId('picker-path').fill(other);
    await expect(page.getByTestId('picker-list')).not.toContainText('reading…');
    await expect(page.getByTestId('picker-path')).toHaveValue(other);
    await expect(page.getByTestId('new-project-here')).toBeEnabled();
    await page.getByTestId('new-project-here').click();
    await expect(page.getByTestId('project-name')).toHaveText(path.basename(other), {
      timeout: 30_000,
    });
    await expect(page.getByTestId('tree-file-src/thing.ts')).toBeVisible();
  } finally {
    await page.evaluate((root) => window.flare!.invoke('project:open', [root]), fixture);
    await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture), {
      timeout: 30_000,
    });
    try {
      fs.rmSync(other, { recursive: true, force: true });
    } catch {
      // the watcher can still hold it briefly on Windows; not a test failure
    }
  }
});

test('a dropped card lands where it was dropped, without flying back first', async () => {
  await page.getByTestId('tab-graph').click();
  await page.keyboard.press('Escape');
  if (await page.getByTestId('legend-unfold-all').isEnabled()) {
    await page.getByTestId('legend-unfold-all').click();
  }
  await page.getByTestId('zoom-fit').click();
  await page.waitForTimeout(500);

  const card = page.locator('.gcard').first();
  const id = (await card.getAttribute('data-id'))!;
  const before = (await card.boundingBox())!;

  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 180, before.y + before.height / 2 + 90, {
    steps: 12,
  });

  /*
   * Watch every frame after the release.
   *
   * A card carries a 110ms transform transition, switched off only while it
   * is being dragged. Undoing the drag in the wrong order re-enables that
   * transition while the transform is still applied, so the card jumps past
   * the drop point by the whole drag distance and then eases back into it.
   * That overshoot-and-settle is the ricochet, and it is invisible to any
   * assertion that only looks at where things end up — so this checks that
   * no frame in between is anywhere other than the landing spot.
   */
  await page.evaluate((cardId) => {
    const w = window as unknown as { __drops: number[] };
    w.__drops = [];
    const el = document.querySelector(`.gcard[data-id="${CSS.escape(cardId)}"]`)!;
    window.addEventListener(
      'mouseup',
      () => {
        const started = performance.now();
        const sample = (): void => {
          w.__drops.push(Math.round(el.getBoundingClientRect().x));
          if (performance.now() - started < 300) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { once: true },
    );
  }, id);

  await page.mouse.up();
  await page.waitForTimeout(500);

  const samples = await page.evaluate(() => (window as unknown as { __drops: number[] }).__drops);
  const after = (await card.boundingBox())!;
  // the canvas is zoomed, so the screen distance is not the drag distance
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(50);
  expect(samples.length).toBeGreaterThan(4);
  const strays = samples.filter((x) => Math.abs(x - after.x) > 8);
  expect(strays, `frames away from the landing spot: ${samples.join(',')}`).toEqual([]);
});

test('the folder bar can be put away, and stays that way', async () => {
  await page.getByTestId('tab-graph').click();
  const legend = page.getByTestId('legend');
  await expect(page.getByTestId('legend-src')).toBeVisible();
  await expect(legend).toContainText('folded');

  await page.getByTestId('legend-collapse').click();
  // the chips and their actions go; the summary stays, so it is still clear
  // what the bar is and how many folders are folded
  await expect(page.getByTestId('legend-src')).toHaveCount(0);
  await expect(page.getByTestId('legend-fold-all')).toHaveCount(0);
  await expect(legend).toContainText('Folders');
  await expect(legend).toContainText('folded');
  await expect(page.getByTestId('legend-collapse')).toHaveAttribute('aria-expanded', 'false');

  // and the preference is written, so it survives reopening the project
  await expect
    .poll(() => page.evaluate(() => window.flare!.invoke('ui:load', [])), { timeout: 10_000 })
    .toMatchObject({ legendCollapsed: true });

  await page.getByTestId('legend-collapse').click();
  await expect(page.getByTestId('legend-src')).toBeVisible();
  await expect(page.getByTestId('legend-fold-all')).toBeVisible();
});

test('opening another project offers a second window rather than assuming', async () => {
  await page.getByTestId('menu-file').click();
  await expect(page.getByTestId('menu-panel-file')).toBeVisible();
  await page.getByTestId('menu-item-new-project').click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();

  /*
   * A window holds one session, so opening a project here ends the one that
   * is running — agents, terminals and all. That has to be a choice, not the
   * only option, and the wording has to say which is which.
   *
   * The second window is a second process, so clicking it is left to the web
   * spec, where "elsewhere" is a tab and the whole thing is observable.
   */
  const elsewhere = page.getByTestId('new-project-elsewhere');
  await expect(elsewhere).toBeVisible();
  await expect(elsewhere).toContainText('new window');
  await expect(page.getByTestId('new-project-here')).toContainText('here');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-project-dialog')).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture));
});

test('risky changes queue as alerts that wait to be reviewed or dismissed', async () => {
  await page.getByTestId('tab-graph').click();
  /*
   * The queue is a chip in the top bar, and the cards are one click under it.
   *
   * It used to be a stack of cards floating in a corner, and there is no
   * corner for one: the bottom-right is the terminal, the top-right is where
   * every tab keeps its own controls. So the chip is what is always visible,
   * and `open()` is what this test does before touching a card — the same
   * gesture a person makes.
   */
  const stack = page.getByTestId('risk-alerts');
  const open = async (): Promise<void> => {
    if ((await page.locator('.ra-pop').count()) === 0) await page.getByTestId('ra-chip').click();
  };
  // clear whatever earlier tests left queued, so this starts from nothing
  if (await stack.isVisible()) {
    await open();
    await page.getByTestId('ra-dismiss-all').click();
  }
  await expect(stack).toHaveCount(0);

  // two modules the rest of src/ depends on: the shape of change that is worth
  // interrupting someone for, and the only one that should raise a card here
  write('src/core.ts', `export const core = 1;\n`);
  write('src/base.ts', `export const base = 2;\n`);
  write(
    'src/app.ts',
    `import { core } from './core';\nimport { base } from './base';\nimport { util } from './util';\nimport { helper } from './lib/helper';\n\nexport function main() {\n  return util() + helper() + core + base;\n}\n`,
  );
  write(
    'src/lib/helper.ts',
    `import { core } from '../core';\nimport { base } from '../base';\nimport { util } from '../util';\n\nexport function helper() {\n  return util() * 2 + core + base;\n}\n`,
  );
  write(
    'src/util.ts',
    `import { core } from './core';\nimport { base } from './base';\n\nexport function util() {\n  return 1 + core + base;\n}\n`,
  );

  // the chip carries the count; the cards are behind it
  await expect(stack).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ra-chip')).toContainText('3');
  await open();

  // the queue names the file and says what makes it risky, in the same words
  // the review rows use
  const card = page.getByTestId('ra-card-src/core.ts');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('break if this is wrong');
  await expect(page.getByTestId('ra-card-src/base.ts')).toBeVisible();
  // util.ts is in there too — this edit made it depend on both new modules
  // while the rest of src/ still depends on it
  await expect(page.getByTestId('ra-card-src/util.ts')).toBeVisible();
  await expect(page.locator('.ra-pop')).toContainText('3 risky changes');
  // app.ts changed as much as any of them, and nothing imports it
  await expect(page.getByTestId('ra-card-src/app.ts')).toHaveCount(0);

  /*
   * Review lands on the change itself.
   *
   * "A risky file was rewritten" is half a sentence; the other half is the
   * diff. So answering the card opens it against the state before the burst —
   * which has to be a *real* diff, with lines marked as added. Diffing against
   * the burst's own snapshot (taken after the writes) rendered an empty one.
   */
  await page.getByTestId('ra-review-src/core.ts').click();
  const diff = page.getByTestId('diff-src/core.ts');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.line-insert').first()).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveCount(0);
  // answering a card closes the popover and takes you to the change, so the
  // count is read off the chip
  await expect(page.getByTestId('ra-chip')).toContainText('2');

  // dismissing is not approving: the card goes, the review queue does not
  const flagged = await page.getByTestId('unreviewed-badge').textContent();
  await open();
  await page.getByTestId('ra-dismiss-src/base.ts').click();
  await expect(page.getByTestId('ra-card-src/base.ts')).toHaveCount(0);
  await expect(page.getByTestId('unreviewed-badge')).toHaveText(flagged ?? '');

  /*
   * One button clears the rest of the queue.
   *
   * That the same file queues again when a *later* burst touches it is a unit
   * test: bursts group writes within 25 seconds of each other, so proving it
   * here would mean a test that mostly sleeps.
   */
  await page.getByTestId('ra-dismiss-all').click();
  await expect(stack).toHaveCount(0);
});

test('clicking a changed file in the review shows the red and green of it', async () => {
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('review-panel')).toBeVisible();

  // rewrite a file that already exists, so the diff has both sides
  write('src/util.ts', `import { core } from './core';\n\nexport function util() {\n  return 41 + core;\n}\n`);
  const row = page.getByTestId('brow-src/util.ts');
  await expect(row.first()).toBeVisible({ timeout: 30_000 });

  // the row itself, not a button hidden on it: the whole reason the row exists
  // is that something was edited
  await row.first().click();
  const diff = page.getByTestId('diff-src/util.ts');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.line-insert').first()).toBeVisible({ timeout: 15_000 });
  await expect(diff.locator('.line-delete').first()).toBeVisible();

  await page.getByTestId('tab-graph').click();
});

test('the source and the rendered document stay on the same part of the file', async () => {
  /*
   * They used to scroll independently, which meant reading what an agent wrote
   * involved finding your place twice — the source at section seven while the
   * preview beside it still showed section one.
   */
  // into the README the fixture already has, rather than a new file: a file
  // created before the first scan has finished is not in the tree yet, and
  // this test is the first thing to run when the suite is filtered
  const long = ['# Long', ''];
  for (let n = 1; n <= 40; n++) long.push(`## Chapter ${n}`, '', `Body of chapter ${n}.`, '');
  write('README.md', long.join('\n'));

  await page.getByTestId('tree-file-README.md').dblclick();
  const doc = page.getByTestId('doc-README.md');
  await expect(doc).toBeVisible({ timeout: 15_000 });
  await doc.getByTestId('doc-source-show').click();
  await expect(doc.locator('.doc-source-body .monaco-editor')).toBeVisible({ timeout: 15_000 });

  /** The source line of the block sitting at the top of the rendered pane. */
  const renderTopLine = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-testid="doc-README.md"] .doc-render');
      if (!host) return -1;
      const box = host.getBoundingClientRect();
      for (const el of host.querySelectorAll<HTMLElement>('.md-block[data-line]')) {
        if (el.getBoundingClientRect().bottom > box.top + 4) return Number(el.dataset.line);
      }
      return -1;
    });

  /** The 1-based line at the top of the source editor, read off the gutter. */
  const editorTopLine = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-testid="doc-README.md"] .doc-source-body');
      const view = host?.querySelector('.monaco-editor');
      if (!view) return -1;
      // Monaco positions rows absolutely, so DOM order is not visual order
      const top = view.getBoundingClientRect().top;
      let best: { y: number; n: number } | null = null;
      for (const el of host!.querySelectorAll<HTMLElement>('.line-numbers')) {
        const box = el.getBoundingClientRect();
        if (box.bottom <= top + 2) continue;
        if (!best || box.top < best.y) best = { y: box.top, n: Number(el.textContent) };
      }
      return best?.n ?? -1;
    });

  expect(await renderTopLine()).toBe(0);

  // scrolling the source drags the preview to the same place — not roughly the
  // same proportion of the way down, the same *line*
  const editorBox = await doc.locator('.doc-source-body .monaco-editor').boundingBox();
  await page.mouse.move(editorBox!.x + editorBox!.width / 2, editorBox!.y + editorBox!.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
  await expect.poll(renderTopLine, { timeout: 10_000 }).toBeGreaterThan(4);
  const sourceLine = await editorTopLine();
  const shownLine = await renderTopLine();
  // within a block: the preview scrolls to whole blocks, the editor to lines
  expect(Math.abs(sourceLine - 1 - shownLine)).toBeLessThanOrEqual(4);

  // …and scrolling the preview drags the source with it, the other way round
  const renderBox = await doc.locator('.doc-render').boundingBox();
  await page.mouse.move(renderBox!.x + renderBox!.width / 2, renderBox!.y + renderBox!.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 400);
  await expect.poll(editorTopLine, { timeout: 10_000 }).toBeGreaterThan(sourceLine);
  /*
   * Polled, not read once.
   *
   * The preview scrolls natively and lands immediately; the editor is *sent*
   * there and Monaco smooth-scrolls the rest of the way. The poll above is
   * satisfied by the first frame of that animation, so reading both panes
   * straight after it compares an editor still in flight against a preview
   * that already arrived — off by the whole gesture (~60 lines) on a machine
   * slow enough to still be animating. What this test is about is where they
   * come to rest.
   */
  await expect
    .poll(async () => Math.abs((await editorTopLine()) - 1 - (await renderTopLine())), {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(6);

  /*
   * And back to the very top, in one burst with no pauses.
   *
   * The end of the document is where this used to break: the preview stops
   * emitting scroll events the moment it reaches zero, so a sync that lost the
   * race to the editor's own smooth-scrolling was simply never retried, and
   * the source stayed a dozen lines down while the preview showed the title.
   */
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -400);
  await expect.poll(renderTopLine, { timeout: 10_000 }).toBe(0);
  await expect.poll(editorTopLine, { timeout: 10_000 }).toBe(1);

  await page.getByTestId('tab-graph').click();
});

test('a rendered document follows the file, and the images it embeds', async () => {
  // a README is mostly the pictures in it, and those are separate files: a
  // change to one used to leave the page showing an image that was gone
  write('shot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#111"/></svg>');
  write('README.md', '# fixture\n\nFIRST_TEXT here.\n\n![shot](shot.svg)\n');

  await page.getByTestId('tree-file-README.md').dblclick();
  // scoped to this document: earlier tests leave their own doc tabs open
  const render = page.getByTestId('doc-README.md').getByTestId('doc-render');
  await expect(render).toContainText('FIRST_TEXT', { timeout: 15_000 });
  const firstSrc = await render.locator('img').first().getAttribute('src');
  expect(firstSrc).toMatch(/^data:image\/svg/);

  // the text follows the file on disk…
  write('README.md', '# fixture\n\nSECOND_TEXT, rewritten on disk.\n\n![shot](shot.svg)\n');
  await expect(render).toContainText('SECOND_TEXT', { timeout: 15_000 });

  // …and so does an image the document merely points at
  write('shot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#eee"/></svg>');
  await expect
    .poll(() => render.locator('img').first().getAttribute('src'), { timeout: 15_000 })
    .not.toBe(firstSrc);

  await page.getByTestId('tab-graph').click();
});

/**
 * The session as the agent tells it, checked against what Flare watched.
 *
 * The chain no unit test can span: an agent announces work, writes files,
 * writes the session down over MCP — and the reply it gets back names the
 * three ways its story and the session disagree, while the same story lands
 * at the top of the review panel over the diff it is about.
 */
test('an agent writes the session down, and Flare checks it against the writes', async () => {
  const url = 'http://127.0.0.1:7411/mcp';
  const connect = async (): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'claude-code' } },
      }),
    });
    await res.json();
    return res.headers.get('mcp-session-id') ?? '';
  };
  const asAgent = async (session: string, name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    return json.result?.content?.[0]?.text ?? '';
  };

  const agent = await connect();
  // announcing is what puts this agent's name on the writes that follow
  await asAgent(agent, 'chat_post', {
    kind: 'taking',
    paths: ['src/core.ts'],
    text: 'pulling the shared constant out into its own module',
  });
  write('src/core.ts', `export const core = 7;
`);
  // the burst only closes once the shadow snapshot lands behind it, and the
  // audit below reads the attributed write — so wait for the attribution
  // itself rather than a fixed pause that a loaded machine outlasts
  await expect(page.getByTestId('unreviewed-badge')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => asAgent(agent, 'recent_activity', {}), { timeout: 20_000 })
    .toMatch(/src\/core\.ts[^\n]*\(by claude/);

  const reply = await asAgent(agent, 'session_summary', {
    headline: 'Pulled the shared constant into its own module',
    chapters: [
      {
        title: 'core.ts holds the constant now',
        detail: 'Two callers were each declaring it, so changing it meant changing it twice.',
        paths: ['src/core.ts', 'src/nowhere.ts'],
        outcome: 'done',
      },
    ],
  });

  // the reply is written to be acted on: it names what the story got wrong
  expect(reply).toContain('recorded');
  expect(reply).toContain('src/nowhere.ts');
  expect(reply).toMatch(/never changed/);

  // and the same story is on screen, over the diff it is about
  await page.getByTestId('tab-review').click();
  const story = page.getByTestId('session-story');
  await expect(story).toBeVisible();
  await expect(story).toContainText('Pulled the shared constant into its own module');
  await expect(story).toContainText('Two callers were each declaring it');
  // a file the prose named and never touched is struck through rather than dropped
  await expect(story.locator('.story-absent')).toContainText('src/nowhere.ts');

  await page.getByTestId('tab-graph').click();
});

/**
 * Find in files: the palette's Text mode, the top bar's way into it, and
 * replace-all one confirmation away. Search is a solved problem, so this
 * checks the shape people expect — matches grouped by file, Enter opens the
 * match at its line, and nothing is replaced without being asked twice.
 */
test('find in files: matches open at their line, and replace-all is one confirmation away', async () => {
  await page.getByTestId('tab-graph').click();
  write('src/needle.ts', ['export const needle = 1;', '// a needle in the comment too', ''].join('\n'));
  await page.getByTestId('explorer-refresh').click();
  await expect(page.getByTestId('tree-file-src/needle.ts')).toBeVisible({ timeout: 20_000 });

  // the top bar suggests files as you type, and hands the query to text search
  await page.getByTestId('search-input').click();
  await page.getByTestId('search-input').fill('needle');
  await expect(page.getByTestId('search-hints')).toContainText('src/needle.ts');
  await page.getByTestId('search-hint-find').click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette-mode-search')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('palette-input')).toHaveValue('needle');
  await expect(page.getByTestId('search-count')).toContainText('2 matches in 1 file');
  // a file with several matches is one row until unfolded
  await expect(page.getByTestId('search-file-src/needle.ts')).toContainText('2');
  await expect(page.getByTestId('search-hit-src/needle.ts-2')).toHaveCount(0);
  await page.getByTestId('search-file-src/needle.ts').click();
  await expect(page.getByTestId('search-hit-src/needle.ts-2')).toContainText('needle in the comment');

  // Enter opens the selected match at its line
  await page.getByTestId('palette-input').press('Enter');
  await expect(page.getByTestId('palette')).toBeHidden();
  await expect(page.getByTestId('editor-src/needle.ts').locator('.view-lines')).toContainText(
    'export const needle',
  );

  // replace-all, asked twice: once to open it, once to confirm it
  await page.getByTestId('tab-graph').click();
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByTestId('palette-mode-search')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('palette-input').fill('needle');
  await expect(page.getByTestId('search-count')).toContainText('2 matches');
  await page.getByTestId('search-replace-toggle').click();
  await page.getByTestId('search-replace-input').fill('pin');
  await page.getByTestId('search-replace-all').click();
  await page.getByTestId('search-replace-confirm').click();
  await expect(page.getByTestId('search-count')).toContainText('replaced 2 in 1 file');
  await expect
    .poll(() => fs.readFileSync(path.join(fixture, 'src', 'needle.ts'), 'utf8'))
    .toContain('const pin = 1');
  await page.keyboard.press('Escape');
  await page.getByTestId('search-input').fill('');
});
