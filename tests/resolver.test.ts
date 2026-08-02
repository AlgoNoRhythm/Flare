import { describe, expect, it } from 'vitest';
import {
  parseJsonc,
  resolveImport,
  tsPathsFromConfig,
  workspacePackagesFrom,
} from '../shared/resolver';

const jsIndex = new Set([
  'src/app.ts',
  'src/utils/helper.ts',
  'src/utils/index.ts',
  'src/components/Button.tsx',
  'lib/ns.js',
  'src/data.mjs',
  'src/legacy.cjs',
]);

describe('resolveImport — JS/TS', () => {
  it('resolves relative with extension inference', () => {
    expect(resolveImport('src/app.ts', './utils/helper', jsIndex)).toBe('src/utils/helper.ts');
    expect(resolveImport('src/app.ts', './components/Button', jsIndex)).toBe(
      'src/components/Button.tsx',
    );
  });

  it('resolves directory index', () => {
    expect(resolveImport('src/app.ts', './utils', jsIndex)).toBe('src/utils/index.ts');
  });

  it('resolves parent-relative', () => {
    expect(resolveImport('src/utils/helper.ts', '../../lib/ns', jsIndex)).toBe('lib/ns.js');
  });

  it('resolves NodeNext-style .js specifier to .ts file', () => {
    expect(resolveImport('src/app.ts', './utils/helper.js', jsIndex)).toBe('src/utils/helper.ts');
  });

  it('returns null for external packages', () => {
    expect(resolveImport('src/app.ts', 'react', jsIndex)).toBeNull();
    expect(resolveImport('src/app.ts', '@scope/pkg', jsIndex)).toBeNull();
  });

  it('resolves tsconfig path aliases', () => {
    const tsPaths = tsPathsFromConfig({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    });
    expect(resolveImport('lib/ns.js', '@/utils/helper', jsIndex, { tsPaths })).toBe(
      'src/utils/helper.ts',
    );
    // baseUrl fallback for bare imports
    expect(resolveImport('src/app.ts', 'lib/ns', jsIndex, { tsPaths })).toBe('lib/ns.js');
  });
});

const pyIndex = new Set([
  'app/__init__.py',
  'app/main.py',
  'app/models.py',
  'app/services/__init__.py',
  'app/services/auth.py',
  'src/mypkg/core.py',
  'utils.py',
]);

describe('resolveImport — Python', () => {
  it('resolves relative imports', () => {
    expect(resolveImport('app/main.py', '.models', pyIndex)).toBe('app/models.py');
    expect(resolveImport('app/services/auth.py', '..models', pyIndex)).toBe('app/models.py');
  });

  it('resolves `from . import x` candidate form', () => {
    expect(resolveImport('app/main.py', '.', pyIndex)).toBe('app/__init__.py');
    expect(resolveImport('app/main.py', '.services', pyIndex)).toBe('app/services/__init__.py');
  });

  it('resolves absolute imports from root and src', () => {
    expect(resolveImport('app/main.py', 'app.services.auth', pyIndex)).toBe('app/services/auth.py');
    expect(resolveImport('app/main.py', 'utils', pyIndex)).toBe('utils.py');
    expect(resolveImport('app/main.py', 'mypkg.core', pyIndex)).toBe('src/mypkg/core.py');
  });

  it('returns null for stdlib/external', () => {
    expect(resolveImport('app/main.py', 'os', pyIndex)).toBeNull();
    expect(resolveImport('app/main.py', 'numpy.linalg', pyIndex)).toBeNull();
  });
});

describe('parseJsonc', () => {
  it('parses tsconfig with comments and trailing commas', () => {
    const parsed = parseJsonc(`{
  // a comment
  "compilerOptions": {
    /* block */
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"], },
  },
}`) as { compilerOptions: { baseUrl: string } };
    expect(parsed.compilerOptions.baseUrl).toBe('.');
  });

  it('does not mangle URLs in strings', () => {
    const parsed = parseJsonc('{"url": "https://example.com"}') as { url: string };
    expect(parsed.url).toBe('https://example.com');
  });

  it('keeps paths when a glob later in the file looks like a comment close', () => {
    // "@/*" opens a block comment and the "**/" in exclude closes it, so a
    // regex strip swallows every mapping in between
    const parsed = parseJsonc(`{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@/public/*": ["./public/*"]
    }
  },
  "exclude": ["**/*.spec.ts"]
}`) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(parsed.compilerOptions.paths).toEqual({
      '@/*': ['./src/*'],
      '@/public/*': ['./public/*'],
    });
  });

  it('leaves comment-like text inside strings alone', () => {
    const parsed = parseJsonc('{"a": "keep // this", "b": "and /* this */ too"}') as {
      a: string;
      b: string;
    };
    expect(parsed.a).toBe('keep // this');
    expect(parsed.b).toBe('and /* this */ too');
  });

  it('handles escaped quotes and commas inside strings', () => {
    const parsed = parseJsonc('{"a": "say \\"hi\\", ok", "b": [1, 2,],}') as {
      a: string;
      b: number[];
    };
    expect(parsed.a).toBe('say "hi", ok');
    expect(parsed.b).toEqual([1, 2]);
  });
});

describe('monorepo workspace packages', () => {
  const index = new Set([
    'packages/database/src/index.ts',
    'packages/database/src/client.ts',
    'packages/shared/index.ts',
    'packages/ui/src/Button.tsx',
    'apps/api/src/server.ts',
  ]);
  const opts = {
    workspaces: workspacePackagesFrom([
      { path: 'packages/database/package.json', json: { name: '@acme/database' } },
      { path: 'packages/shared/package.json', json: { name: '@acme/shared' } },
      { path: 'packages/ui/package.json', json: { name: '@acme/ui' } },
      { path: 'node_modules/react/package.json', json: { name: 'react' } },
    ]),
  };

  it('finds the packages that live in the repo, ignoring installed ones', () => {
    expect(opts.workspaces.map((w) => w.name).sort()).toEqual([
      '@acme/database',
      '@acme/shared',
      '@acme/ui',
    ]);
  });

  it('resolves a workspace package to its entry point', () => {
    expect(resolveImport('apps/api/src/server.ts', '@acme/database', index, opts)).toBe(
      'packages/database/src/index.ts',
    );
    expect(resolveImport('apps/api/src/server.ts', '@acme/shared', index, opts)).toBe(
      'packages/shared/index.ts',
    );
  });

  it('resolves a deep import into a workspace package, with or without src/', () => {
    expect(resolveImport('apps/api/src/server.ts', '@acme/database/client', index, opts)).toBe(
      'packages/database/src/client.ts',
    );
    expect(resolveImport('apps/api/src/server.ts', '@acme/ui/src/Button', index, opts)).toBe(
      'packages/ui/src/Button.tsx',
    );
  });

  it('honours the entry declared by the package', () => {
    const declared = {
      workspaces: workspacePackagesFrom([
        { path: 'packages/database/package.json', json: { name: '@acme/database', main: './src/client.js' } },
      ]),
    };
    expect(resolveImport('apps/api/src/server.ts', '@acme/database', index, declared)).toBe(
      'packages/database/src/client.ts',
    );
  });

  it('still returns null for a real external package', () => {
    expect(resolveImport('apps/api/src/server.ts', 'react', index, opts)).toBeNull();
    expect(resolveImport('apps/api/src/server.ts', '@acme/nope', index, opts)).toBeNull();
  });

  it('does not let a shorter package name shadow a longer one', () => {
    const nested = new Set(['packages/db/index.ts', 'packages/db-core/index.ts']);
    const two = {
      workspaces: workspacePackagesFrom([
        { path: 'packages/db/package.json', json: { name: '@acme/db' } },
        { path: 'packages/db-core/package.json', json: { name: '@acme/db-core' } },
      ]),
    };
    expect(resolveImport('a.ts', '@acme/db-core', nested, two)).toBe('packages/db-core/index.ts');
    expect(resolveImport('a.ts', '@acme/db', nested, two)).toBe('packages/db/index.ts');
  });
});

describe('tsPathsFromConfig with a config that is not at the root', () => {
  it('resolves baseUrl relative to the config that declared it', () => {
    const config = { compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } };
    const atRoot = tsPathsFromConfig(config);
    const nested = tsPathsFromConfig(config, 'configs');
    expect(atRoot[0].targets).toEqual(['src']);
    expect(nested[0].targets).toEqual(['configs/src']);
  });
});
