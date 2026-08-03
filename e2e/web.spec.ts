import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { expect, test, type Page } from '@playwright/test';

/**
 * Flare served to a browser.
 *
 * The point is not that the UI works — `app.spec.ts` covers that against this
 * same build. It is that the transport is interchangeable: the same React app,
 * over a websocket instead of Electron IPC, does the same things. So this
 * exercises what actually crosses the wire (the graph, a file read, a live
 * event, a real terminal), the routing that lets two projects share one port,
 * and the affordances that have to disappear when there is no native shell.
 */

const PORT = 7413;
/** Fixed rather than generated, so every url in this file is predictable. */
const TOKEN = 'e2e-token-abc';
const BASE = `http://127.0.0.1:${PORT}`;

/** A url that lets you straight in: what the startup banner prints. */
const enter = (rest = '/'): string => `${BASE}${rest}?token=${TOKEN}`;

const servers: ChildProcess[] = [];
const fixtures: string[] = [];
let registryDir = '';
let dataDir = '';
let slugA = '';
let slugB = '';
let rootA = '';
let rootB = '';

test.describe.configure({ mode: 'serial' });

function makeFixture(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `flare-web-${name}-`)));
  const write = (rel: string, content: string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('src/app.ts', `import { util } from './util';\n\nexport function main() {\n  return util();\n}\n`);
  write('src/util.ts', `export function util() {\n  return 1;\n}\n`);
  write('README.md', `# ${name}\n\nServed over a **websocket**.\n`);
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'e2e@test.local'],
    ['config', 'user.name', 'E2E'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.'],
    ['commit', '-q', '-m', 'init'],
  ]) {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  }
  fixtures.push(dir);
  return dir;
}

/**
 * Start the supervisor, optionally asking it to open a project straight away.
 * Resolves with the slug it reports for that project, if any.
 */
function serve(root?: string, opts: { port?: number; args?: string[] } = {}): Promise<string> {
  const proc = spawn(
    process.execPath,
    [path.join('dist-server', 'index.cjs'), ...(root ? [root] : []), ...(opts.args ?? [])],
    {
      env: {
        ...process.env,
        FLARE_PORT: String(opts.port ?? PORT),
        FLARE_TOKEN: TOKEN,
        FLARE_USERDATA: dataDir,
        FLARE_MCP_REGISTRY: registryDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  servers.push(proc);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 60_000);
    proc.stdout?.on('data', (chunk) => {
      out += String(chunk);
      /*
       * The last line of the banner, not the first: the url is printed before
       * the port is actually bound, so matching it would hand back a supervisor
       * that refuses the next connection.
       */
      const done = root
        ? /→ http:\/\/[\d.]+:\d+\/([\w-]+)\//.exec(out)
        : /open it to pick a project/.exec(out);
      if (done) {
        clearTimeout(timer);
        resolve(root ? done[1] : '');
      }
    });
    proc.stderr?.on('data', (chunk) => console.log('[server]', String(chunk).trim()));
  });
}

/** Sessions are separate processes; the registry is the only handle on them. */
function killEverySession(): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(registryDir, file), 'utf8'));
      process.kill(entry.pid);
    } catch {
      // already gone
    }
  }
}

async function open(page: Page, slug: string): Promise<void> {
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
  });
  // the token goes in once per browser; everything after this rides the cookie
  await page.goto(enter(`/${slug}/`));
  await expect(page.getByTestId('project-name')).toBeVisible();
}

test.beforeAll(async () => {
  /*
   * A fixed registry rather than a fresh temp one: sessions deliberately
   * outlive the supervisor that started them, so a run that dies before its
   * cleanup would leave processes squatting on the port. Reusing the registry
   * means the next run can find them and clear them out.
   */
  registryDir = path.join(os.tmpdir(), `flare-web-e2e-${PORT}`);
  fs.mkdirSync(registryDir, { recursive: true });
  killEverySession();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-web-data-'));
  rootA = makeFixture('alpha');
  rootB = makeFixture('beta');
  // one supervisor holds the port; each project it is given becomes a session
  slugA = await serve(rootA);
  slugB = await serve(rootB);
});

test.afterAll(() => {
  killEverySession();
  for (const proc of servers) proc.kill();
  for (const dir of [...fixtures, dataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a lingering watcher may hold a handle briefly; not a test failure
    }
  }
});

test('the graph loads in a browser tab, over the websocket', async ({ page }) => {
  await open(page, slugA);
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(rootA));
  await expect(page.getByTestId('stats')).toContainText('2 nodes · 1 edges');
  await expect(page.getByTestId('graph-container')).toBeVisible();
});

test('keyboard shortcuts still reach the app, not the browser', async ({ page }) => {
  await open(page, slugA);
  // The handlers listen on the window, but the page needs focus before the
  // browser routes keys into it at all. Any click will do, so this one is
  // forced: we are not testing that the canvas is clickable, and waiting for
  // it to be unobstructed makes the test hostage to whatever banner or toast
  // happens to be up.
  const focusPage = () =>
    page.getByTestId('graph-container').click({ position: { x: 400, y: 300 }, force: true });

  await focusPage();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.keyboard.press('Escape');

  await focusPage();
  await page.keyboard.press('?');
  await expect(page.getByTestId('help-overlay')).toBeVisible();
  await page.keyboard.press('Escape');

  await focusPage();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeHidden();
});

test('the tree opens a file in the editor, and markdown renders', async ({ page }) => {
  await open(page, slugA);
  await page.getByTestId('tree-file-src/app.ts').click();
  await expect(page.getByTestId('editor-src/app.ts').locator('.view-lines')).toContainText(
    `import { util } from './util'`,
  );

  await page.getByTestId('tree-file-README.md').dblclick();
  await expect(page.getByTestId('doc-render')).toContainText('Served over a websocket');
});

test('a change on disk arrives as a live event', async ({ page }) => {
  await open(page, slugA);
  await expect(page.getByTestId('stats')).toContainText('2 nodes');
  fs.writeFileSync(
    path.join(rootA, 'src', 'extra.ts'),
    `import { util } from './util';\n\nexport const extra = util() + 1;\n`,
  );
  await expect(page.getByTestId('stats')).toContainText('3 nodes · 2 edges', { timeout: 30_000 });
  await expect(page.getByTestId('tree-file-src/extra.ts')).toBeVisible();
});

test('the terminal runs a real shell on the server', async ({ page }) => {
  await open(page, slugA);
  const panel = page.getByTestId('terminal-panel');
  await expect(panel.locator('.xterm')).toBeVisible();
  // wait for the shell to print a prompt, and for xterm to be ready to take
  // input — a fixed pause is not enough on a loaded machine
  await expect(panel.locator('.xterm-rows')).toContainText(/[$>#]/, { timeout: 30_000 });
  await panel.locator('.terminal-body').click();
  await expect(panel.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('echo flare_over_the_wire');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText('flare_over_the_wire', {
    timeout: 30_000,
  });
});

test('two tabs on one project keep their own terminals', async ({ browser }) => {
  // one backend, two UIs — something the desktop app can never be. Terminals
  // are keyed by id server-side and creating a duplicate kills the original,
  // so without per-client ids the second tab silently killed the first's shell.
  const first = await browser.newPage();
  const second = await browser.newPage();
  try {
    await open(first, slugA);
    const firstTerm = first.getByTestId('terminal-panel');
    await expect(firstTerm.locator('.xterm-rows')).toContainText(/[$>#]/, { timeout: 30_000 });
    await firstTerm.locator('.terminal-body').click();
    await first.keyboard.type('echo first_tab_marker');
    await first.keyboard.press('Enter');
    await expect(firstTerm.locator('.xterm-rows')).toContainText('first_tab_marker', {
      timeout: 30_000,
    });

    // the second tab opens its own terminal
    await open(second, slugA);
    await expect(second.getByTestId('terminal-panel').locator('.xterm-rows')).toContainText(
      /[$>#]/,
      { timeout: 30_000 },
    );

    // the first tab's shell is untouched and still takes input
    await expect(firstTerm.locator('.xterm-rows')).not.toContainText('process exited');
    await firstTerm.locator('.terminal-body').click();
    await first.keyboard.type('echo still_alive');
    await first.keyboard.press('Enter');
    await expect(firstTerm.locator('.xterm-rows')).toContainText('still_alive', {
      timeout: 30_000,
    });
  } finally {
    await first.close();
    await second.close();
  }
});

test('a second project is reachable at its own url on the same port', async ({ page }) => {
  await open(page, slugB);
  await expect(page.getByTestId('project-name')).toHaveText(/beta/);
  await expect(page.getByTestId('stats')).toContainText('2 nodes · 1 edges');
});

test('the port itself is the start screen — the real one, not a stand-in', async ({ page }) => {
  await page.goto(enter());
  // Flare's own start screen, the same component the desktop app opens to
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await expect(page.getByTestId('folder-picker')).toBeVisible();
  await expect(page.getByTestId('picker-list')).toBeVisible();
  // no native folder dialog to offer in a tab
  await expect(page.getByTestId('open-folder')).toHaveCount(0);
  // projects opened so far are listed, newest first
  await expect(page.getByTestId(`recent-${path.basename(rootB)}`)).toBeVisible();
  await expect(page.getByTestId(`recent-${path.basename(rootA)}`)).toBeVisible();
});

test('picking a project from the start screen spawns its session and goes there', async ({
  page,
}) => {
  const fresh = makeFixture('gamma');
  await page.goto(enter());
  await expect(page.getByTestId('start-screen')).toBeVisible();

  // typing the path is enough: the confirm opens whatever is in the box
  await page.getByTestId('picker-path').fill(fresh);
  await expect(page.getByTestId('picker-open')).toBeEnabled();
  await page.getByTestId('picker-open').click();

  // the browser lands on a url of its own, and that url is the project
  await page.waitForURL(/\/[\w-]+\/$/, { timeout: 60_000 });
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(fresh));
  expect(new URL(page.url()).pathname).not.toBe('/');

  // and it is a session of its own, not this project swapped into another
  const slug = new URL(page.url()).pathname.replace(/\//g, '');
  expect(slug).not.toBe(slugA);
  expect(slug).not.toBe(slugB);

  // going back to a project already running reuses it rather than duplicating
  await page.goto(enter());
  await page.getByTestId('picker-path').fill(fresh);
  await expect(page.getByTestId('picker-open')).toBeEnabled();
  await page.getByTestId('picker-open').click();
  await page.waitForURL(new RegExp(`/${slug}/$`), { timeout: 60_000 });
});

test('a recent project opens at its own url from inside another one', async ({ page }) => {
  await open(page, slugA);
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-item-recent').hover();
  await page
    .locator('[data-testid^="menu-item-recent-"]')
    .filter({ hasText: path.basename(rootB) })
    .first()
    .click();

  // switching project is a navigation, not a swap: this session keeps its url
  await page.waitForURL(new RegExp(`/${slugB}/$`), { timeout: 60_000 });
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(rootB));
});

test('a url whose session has gone says so instead of hanging', async ({ page }) => {
  const response = await page.goto(enter('/no-such-abc123/'));
  expect(response?.status()).toBe(404);
  await expect(page.getByText('No Flare session is running')).toBeVisible();
});

test('the review cockpit works over the wire, smells and all', async ({ page }) => {
  await open(page, slugA);
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('review-panel')).toBeVisible();

  // an edit that weakens its own test is what the smell rules are for, and it
  // exercises the whole chain: watcher → session → event → panel
  fs.writeFileSync(
    path.join(rootA, 'src', 'util.ts'),
    `export function util() {\n  // @ts-ignore\n  return 1 as any;\n}\n`,
  );
  fs.writeFileSync(
    path.join(rootA, 'src', 'util.test.ts'),
    `import { util } from './util';\nit.skip('util', () => { expect(util()).toBe(1); });\n`,
  );

  const burst = page.locator('.burst').first();
  await expect(burst).toBeVisible({ timeout: 30_000 });
  await expect(burst.locator('.verify-pill')).toHaveText('never checked', { timeout: 30_000 });
  await expect(page.getByTestId('smell-test-disabled')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('smell-suppression-added')).toBeVisible();
});

test('insights compute the same metrics in a tab', async ({ page }) => {
  await open(page, slugA);
  await page.getByTestId('tab-insights').click();
  await expect(page.getByTestId('insights-summary')).toContainText('files');
  expect(await page.getByTestId('metrics-table').locator('tbody tr').count()).toBeGreaterThan(0);
});

test('an agent reaches the same session on the same port', async ({ request }) => {
  // the human's tab is /<slug>/ and the agent's endpoint is /mcp/<slug>: one
  // port to forward, one project, the same open session behind both
  const response = await request.post(`http://127.0.0.1:${PORT}/mcp/${slugA}`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'file_info', arguments: { path: 'src/app.ts' } },
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.result.content[0].text).toContain('src/app.ts');
});

test('nothing is served without the token, and the agent endpoint is unaffected', async ({
  request,
}) => {
  // behind this port are the files and a shell, so an unauthenticated GET has
  // to be a 401 and not a start screen
  const bare = await request.get(`${BASE}/${slugA}/`);
  expect(bare.status()).toBe(401);
  expect(await bare.text()).toContain('needs its token');
  expect((await request.get(`${BASE}/${slugA}/?token=wrong`)).status()).toBe(401);
  expect((await request.get(`${BASE}/`)).status()).toBe(401);

  // a script does not have to go through the form
  const withHeader = await request.get(`${BASE}/${slugA}/`, {
    headers: { 'x-flare-token': TOKEN },
  });
  expect(withHeader.status()).toBe(200);

  // and the agent's endpoint is deliberately outside all of it: putting a
  // browser cookie in front of it would break every `claude mcp add` already
  // written into a config file
  const mcp = await request.post(`${BASE}/mcp/${slugA}`, {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'graph_overview' } },
  });
  expect(mcp.ok()).toBe(true);
});

test('the websocket is refused without the token, and says so', async () => {
  // a socket that is merely reset looks like a backend that crashed, and the
  // tab would reconnect to it for ever without ever saying why
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: `/${slugA}/ws`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        'sec-websocket-version': '13',
      },
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('upgrade', () => resolve(101));
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(401);
});

test('the token can be typed in, for a url that arrived without one', async ({ page }) => {
  await page.goto(`${BASE}/${slugA}/`);
  await page.getByPlaceholder('token').fill(TOKEN);
  await page.getByRole('button', { name: 'Open' }).click();

  // through the form, into the app, on the same url it was asked for
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(rootA));
  expect(new URL(page.url()).pathname).toBe(`/${slugA}/`);

  // and the cookie it was given carries the next request, with nothing in the
  // address bar to leak into a bookmark or a screenshot
  await page.goto(`${BASE}/${slugA}/`);
  await expect(page.getByTestId('project-name')).toBeVisible();
});

test('--no-token serves the UI to anyone who can reach the port', async ({ request }) => {
  const port = PORT + 1;
  await serve(undefined, { port, args: ['--no-token'] });
  const response = await request.get(`http://127.0.0.1:${port}/`);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('<div id="root">');
});

test('the browser is served the same build the desktop app loads', async ({ request }) => {
  // "same look and feel" is not a promise to keep in step by hand — it is the
  // same bundle, and this fails the moment that stops being true
  const served = await (await request.get(enter(`/${slugA}/`))).text();
  const onDisk = fs.readFileSync(path.join('dist', 'index.html'), 'utf8');
  expect(served).toBe(onDisk);
});

test('what needs a native shell is absent, not broken', async ({ page }) => {
  await open(page, slugA);
  // no window buttons: the browser draws the frame
  await expect(page.locator('.win-btn')).toHaveCount(0);
  // and the File menu offers nothing that would silently do nothing
  await page.getByText('File', { exact: true }).first().click();
  const menu = page.getByTestId('menu-panel-file');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('New File');
  await expect(menu).not.toContainText('Open Folder');
  await expect(menu).not.toContainText('Reveal Project');
  await expect(menu).not.toContainText('Exit');
});

test('a page with no backend says so, instead of pretending to be empty', async ({ page }) => {
  // exactly what happens when the Vite dev server is opened in a browser: the
  // interface is served, nothing is behind it. Every call resolves empty, so
  // without this the app renders "no project, no recents, no such folder" —
  // all of it untrue, and indistinguishable from a hang.
  const dead = await new Promise<number>((resolve) => {
    const srv = createServer((req, res) => {
      const rel = (req.url ?? '/').split('?')[0];
      const file = rel === '/' ? 'index.html' : rel.slice(1);
      try {
        const body = fs.readFileSync(path.join('dist', file));
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    // no upgrade handler at all: websockets are refused
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
    servers.push({ kill: () => srv.close() } as never);
  });

  await page.goto(`http://127.0.0.1:${dead}/`);
  await expect(page.getByTestId('connection-gate')).toBeVisible();
  await expect(page.getByTestId('spinner').first()).toBeVisible();
  // and after a moment it stops being a spinner and starts being an answer
  await expect(page.getByTestId('connection-detail')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('connection-detail')).toContainText('npm run serve');
  // the misleading start screen is precisely what must not be shown
  await expect(page.getByTestId('start-screen')).toHaveCount(0);
});

test('the terminal pastes in a browser tab too, using the viewer clipboard', async ({
  page,
  context,
}) => {
  // a served terminal is on another machine; the clipboard that matters is the
  // one in front of the person typing, so the browser's own is asked first
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, slugA);
  const panel = page.getByTestId('terminal-panel');
  await expect(panel.locator('.xterm-rows')).toContainText(/[$>#]/, { timeout: 30_000 });

  await page.evaluate(() => navigator.clipboard.writeText('echo pasted_in_browser'));
  await panel.locator('.terminal-body').click();
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText('pasted_in_browser', {
    timeout: 30_000,
  });
});

test('opening another project in a new tab leaves this one exactly as it was', async ({ page, context }) => {
  await open(page, slugA);
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(rootA));

  await page.getByText('File', { exact: true }).first().click();
  await page.getByTestId('menu-item-new-project').click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
  // served, "elsewhere" is a tab rather than a window, and the wording says so
  const elsewhere = page.getByTestId('new-project-elsewhere');
  await expect(elsewhere).toContainText('new tab');

  // typing the path is enough — the dialog takes it as you type. The picker's
  // first listing is still on its way, and used to land on top of this: the
  // box said one folder and the tab opened another.
  await page.getByTestId('picker-path').fill(rootB);
  await expect(page.getByTestId('picker-list')).not.toContainText('reading…');
  await expect(page.getByTestId('picker-path')).toHaveValue(rootB);
  await expect(page.getByTestId('new-project-elsewhere')).toBeEnabled();

  const opened = context.waitForEvent('page');
  await elsewhere.click();
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  // the new tab is on the other project… two waits rather than one, so a slow
  // session boot is not mistaken for a tab that never went anywhere
  await second.waitForURL(`**/${slugB}/`, { timeout: 30_000 });
  await expect(second.getByTestId('project-name')).toHaveText(path.basename(rootB), {
    timeout: 60_000,
  });

  // …and nothing removed the project from the tab we were in
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(rootA));
  expect(new URL(page.url()).pathname).toBe(`/${slugA}/`);
  await expect(page.getByTestId('new-project-dialog')).toHaveCount(0);
  await second.close();
});

test('the start screen never offers "elsewhere", because nothing is open to lose', async ({ page }) => {
  await page.goto(enter());
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
  await expect(page.getByTestId('new-project-elsewhere')).toHaveCount(0);
  await expect(page.getByTestId('new-project-here')).toBeVisible();
});
