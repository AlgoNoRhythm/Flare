import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Generates realistic mock repositories for UX testing across layout shapes.
// Usage: node scripts/make-mocks.mjs <outDir>

const outRoot = process.argv[2];
if (!outRoot) throw new Error('usage: node scripts/make-mocks.mjs <outDir>');

function repo(name, files, opts = {}) {
  const dir = path.join(outRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'mock@mock'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'mock'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  if (opts.lcov) fs.writeFileSync(path.join(dir, 'lcov.info'), opts.lcov);
  console.log(`${name}: ${Object.keys(files).length} files`);
  return dir;
}

const ts = (imports, body = '') =>
  imports.map((i) => `import { x as _${Math.random().toString(36).slice(2, 6)} } from '${i}';`).join('\n') +
  `\nexport const x = 1;\nexport function handle(a: number) {\n  if (a > 0 && a < 10) return a;\n  for (let i = 0; i < a; i++) a += i % 3 ? 1 : 2;\n  return a;\n}\n${body}`;

const py = (imports, body = '') =>
  imports.map((i) => `from ${i} import x`).join('\n') + `\n\nx = 1\n\ndef handle(a):\n    if a and a > 1:\n        return a\n    return 0\n${body}`;

// ---------------------------------------------------------------------------
// 1. monorepo — deep nesting, several packages, a cycle, an orphan
// ---------------------------------------------------------------------------
repo('monorepo', {
  'apps/web/src/pages/Home.tsx': ts(['../components/Layout', '../components/Button', '@core/models']),
  'apps/web/src/pages/Settings.tsx': ts(['../components/Layout', '../hooks/useAuth']),
  'apps/web/src/pages/Dashboard.tsx': ts(['../components/Layout', '../components/Chart', '../hooks/useData']),
  'apps/web/src/components/Layout.tsx': ts(['./Nav', '@ui/theme']),
  'apps/web/src/components/Nav.tsx': ts(['@ui/theme', '../hooks/useAuth']),
  'apps/web/src/components/Button.tsx': ts(['@ui/theme']),
  'apps/web/src/components/Chart.tsx': ts(['@ui/theme', '@core/models']),
  'apps/web/src/hooks/useAuth.ts': ts(['@core/api-client']),
  'apps/web/src/hooks/useData.ts': ts(['@core/api-client', '@core/models']),
  'apps/web/src/main.tsx': ts(['./pages/Home', './pages/Settings', './pages/Dashboard']),
  'apps/web/tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: {} },
  }),
  'apps/api/src/routes/users.ts': ts(['../services/userService', '@core/models']),
  'apps/api/src/routes/billing.ts': ts(['../services/billingService', '@core/models']),
  'apps/api/src/services/userService.ts': ts(['@core/db', '@core/models']),
  'apps/api/src/services/billingService.ts': ts(['@core/db', './userService']),
  'apps/api/src/server.ts': ts(['./routes/users', './routes/billing']),
  'packages/core/src/models.ts': ts([]),
  'packages/core/src/db.ts': ts(['./models', './config']),
  'packages/core/src/config.ts': ts(['./db']), // cycle: db <-> config
  'packages/core/src/api-client.ts': ts(['./models', './config']),
  'packages/ui/src/theme.ts': ts([]),
  'packages/ui/src/tokens.ts': ts(['./theme']),
  'packages/ui/src/legacy-grid.ts': ts(['./theme']), // orphan-ish
  'services/worker/tasks.py': py(['services.worker.queue']),
  'services/worker/queue.py': py([]),
  'services/worker/pipeline.py': py(['services.worker.tasks', 'services.worker.queue']),
  'tests/web/pages.test.tsx': ts(['../../apps/web/src/pages/Home']),
  'tests/api/users.test.ts': ts(['../../apps/api/src/routes/users']),
  'tests/core/models.test.ts': ts(['../../packages/core/src/models']),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@core/*': ['packages/core/src/*'], '@ui/*': ['packages/ui/src/*'] },
    },
  }),
  'README.md': '# monorepo mock\n',
});

// ---------------------------------------------------------------------------
// 2. flat — scripts-style repo, everything at the root
// ---------------------------------------------------------------------------
const flatFiles = { 'README.md': '# flat mock\n' };
const flatNames = ['cli', 'config', 'logger', 'utils', 'parser', 'runner', 'report', 'cache', 'http', 'auth', 'db', 'main'];
for (const [i, name] of flatNames.entries()) {
  const deps = [];
  if (i > 0) deps.push(`./${flatNames[Math.floor(i / 2)]}`);
  if (i > 4) deps.push('./utils');
  if (name === 'main') deps.push('./cli', './runner', './report');
  flatFiles[`${name}.ts`] = ts(deps);
}
flatFiles['main.test.ts'] = ts(['./main']);
repo('flat', flatFiles);

// ---------------------------------------------------------------------------
// 3. pylib — a python package with subpackages and tests + coverage
// ---------------------------------------------------------------------------
repo(
  'pylib',
  {
    'mylib/__init__.py': py(['mylib.core.engine']),
    'mylib/core/__init__.py': py([]),
    'mylib/core/engine.py': py(['mylib.core.state', 'mylib.utils.log']),
    'mylib/core/state.py': py([]),
    'mylib/io/reader.py': py(['mylib.core.state', 'mylib.utils.log']),
    'mylib/io/writer.py': py(['mylib.core.state']),
    'mylib/utils/log.py': py([]),
    'mylib/utils/timing.py': py(['mylib.utils.log']),
    'tests/test_engine.py': py(['mylib.core.engine']),
    'tests/test_reader.py': py(['mylib.io.reader']),
    'setup.py': py([]),
    'README.md': '# pylib mock\n',
  },
  {
    lcov: [
      'SF:mylib/core/engine.py\nLF:40\nLH:36\nend_of_record',
      'SF:mylib/core/state.py\nLF:20\nLH:20\nend_of_record',
      'SF:mylib/io/reader.py\nLF:30\nLH:9\nend_of_record',
      'SF:mylib/io/writer.py\nLF:22\nLH:0\nend_of_record',
      'SF:mylib/utils/log.py\nLF:12\nLH:12\nend_of_record',
      '',
    ].join('\n'),
  },
);
console.log('mocks ready at', outRoot);
