import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Degenerate-case harness: open pathological repos, assert the app survives.
// Usage: node scripts/degen.mjs <outDir>

const outRoot = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flare-degen-'));
fs.mkdirSync(outRoot, { recursive: true });

function makeRepo(name, build, { git = true } = {}) {
  const dir = path.join(outRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  build(dir);
  if (git) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'd@d'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'd'], { cwd: dir });
    try {
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'init', '--allow-empty'], { cwd: dir, stdio: 'pipe' });
    } catch {
      // empty repos etc.
    }
  }
  return dir;
}

const write = (dir, rel, content) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

const cases = [];

cases.push(['empty', makeRepo('empty', () => {})]);
cases.push(['no-git', makeRepo('no-git', (d) => write(d, 'solo.ts', 'export const x = 1;'), { git: false })]);
cases.push(['no-code', makeRepo('no-code', (d) => {
  write(d, 'README.md', '# docs only\n');
  write(d, 'data.json', '{"a":1}');
  write(d, 'notes/todo.txt', 'hi');
})]);
cases.push(['deep-nest', makeRepo('deep-nest', (d) => {
  const deep = 'a/b/c/d/e/f/g/h';
  write(d, `${deep}/leaf.ts`, `export const leaf = 1;`);
  write(d, `${deep}/mid.ts`, `import { leaf } from './leaf';\nexport const mid = leaf;`);
  write(d, 'a/top.ts', `import { mid } from './b/c/d/e/f/g/h/mid';\nexport const top = mid;`);
})]);
cases.push(['weird-names', makeRepo('weird-names', (d) => {
  write(d, 'my file with spaces.ts', `export const a = 1;`);
  write(d, 'ünïcödé-файл.ts', `import { a } from './my file with spaces';\nexport const b = a;`);
  write(d, 'sub dir/nested file.ts', `import { b } from '../ünïcödé-файл';\nexport const c = b;`);
  write(d, `${'x'.repeat(120)}.ts`, 'export const long = 1;');
})]);
cases.push(['big-ring', makeRepo('big-ring', (d) => {
  // one giant 14-file import cycle plus satellites
  for (let i = 0; i < 14; i++) {
    write(d, `ring/n${i}.ts`, `import './n${(i + 1) % 14}';\nexport const v${i} = ${i};`);
  }
  write(d, 'entry.ts', `import './ring/n0';`);
})]);
cases.push(['large', makeRepo('large', (d) => {
  // 600 files across 30 packages, chained imports
  for (let p = 0; p < 30; p++) {
    for (let f = 0; f < 20; f++) {
      const imports = [];
      if (f > 0) imports.push(`import './f${f - 1}';`);
      if (p > 0 && f === 0) imports.push(`import '../pkg${p - 1}/f19';`);
      write(d, `pkg${p}/f${f}.ts`, `${imports.join('\n')}\nexport const v = ${p * 100 + f};\nexport function fn${f}(a: number) { if (a > 1 && a < 5) return a; return 0; }`);
    }
  }
})]);

let failures = 0;
for (const [name, dir] of cases) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `flare-degen-${name}-`));
  const errors = [];
  const t0 = Date.now();
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FLARE_PROJECT: dir, FLARE_USERDATA: userData },
    timeout: 90000,
  });
  const page = await app.firstWindow({ timeout: 90000 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`);
  });
  try {
    await page.waitForSelector('[data-testid="statusbar"]', { timeout: 25000 });
    await page.waitForTimeout(name === 'large' ? 6000 : 2500);
    const bootMs = Date.now() - t0;
    const stats = await page.getByTestId('stats').textContent().catch(() => 'NO STATS');
    const canvas = await page.locator('[data-testid="graph-container"]').count();
    // interact a little: search + palette + terminal presence
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    const term = await page.getByTestId('terminal-panel').count();
    console.log(
      `${name.padEnd(12)} boot=${bootMs}ms stats="${stats}" canvases=${canvas} terminal=${term} errors=${errors.length}`,
    );
    if (errors.length > 0) {
      failures++;
      for (const e of errors.slice(0, 4)) console.log(`   ! ${e}`);
    }
  } catch (err) {
    failures++;
    console.log(`${name.padEnd(12)} FAILED: ${err.message.split('\n')[0]}`);
    for (const e of errors.slice(0, 4)) console.log(`   ! ${e}`);
  }
  await app.close().catch(() => {});
}
console.log(failures === 0 ? 'ALL DEGENERATE CASES OK' : `${failures} CASES WITH ISSUES`);
process.exit(failures === 0 ? 0 : 1);
