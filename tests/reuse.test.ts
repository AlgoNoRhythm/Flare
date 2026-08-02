import { describe, expect, it } from 'vitest';
import { classifyModule, isComponentFile, moduleHead, reuseScore } from '../shared/reuse';
import type { ReuseInput } from '../shared/reuse';

const base: ReuseInput = {
  path: 'src/logic.ts',
  lang: 'ts',
  loc: 200,
  complexity: 40,
  externalModules: [],
  drag: 0,
  codebaseSize: 101,
  inCycle: false,
};

const score = (patch: Partial<ReuseInput>): number | null => reuseScore({ ...base, ...patch }).score;

describe('classifying what an import ties you to', () => {
  it('separates node built-ins that reach the machine from ones that only compute', () => {
    for (const spec of ['node:fs', 'fs', 'child_process', 'node:net', 'os']) {
      expect(classifyModule(spec, 'ts'), spec).toBe('host');
    }
    for (const spec of ['node:path', 'path', 'crypto', 'util', 'events']) {
      expect(classifyModule(spec, 'ts'), spec).toBe('pure');
    }
  });

  it('knows the python standard library too', () => {
    for (const spec of ['os', 'subprocess', 'socket', 'pathlib', 'logging']) {
      expect(classifyModule(spec, 'py'), spec).toBe('host');
    }
    for (const spec of ['typing', 'json', 'math', 'dataclasses', 're']) {
      expect(classifyModule(spec, 'py'), spec).toBe('pure');
    }
    expect(classifyModule('requests', 'py')).toBe('host');
    expect(classifyModule('fastapi', 'py')).toBe('framework');
    // the same name means different things in different languages
    expect(classifyModule('os', 'py')).toBe('host');
    expect(classifyModule('numpy', 'py')).toBe('pure');
  });

  it('treats a plain library as portable and a framework as binding', () => {
    for (const spec of ['lodash', 'zod', 'date-fns', 'ignore']) {
      expect(classifyModule(spec, 'ts'), spec).toBe('pure');
    }
    for (const spec of ['react', 'express', 'hono', '@nestjs/core', 'vue']) {
      expect(classifyModule(spec, 'ts'), spec).toBe('framework');
    }
    for (const spec of ['pg', 'axios', '@aws-sdk/client-s3', 'chokidar']) {
      expect(classifyModule(spec, 'ts'), spec).toBe('host');
    }
  });

  it('reads the package out of a deep specifier', () => {
    expect(moduleHead('@scope/pkg/sub/thing')).toBe('@scope/pkg');
    expect(moduleHead('lodash/fp')).toBe('lodash');
    expect(moduleHead('node:fs/promises')).toBe('fs');
  });
});

describe('the reuse score', () => {
  it('gives a self-contained module of pure logic full marks', () => {
    expect(score({ externalModules: ['lodash', 'node:path'] })).toBe(100);
  });

  it('is absolute, not relative to the repo', () => {
    // the same file scores the same whatever else is in the project — a repo
    // where everything touches the disk has no reusable core, and a relative
    // scale would award its least-bad file 100
    const a = score({ externalModules: ['node:fs'], codebaseSize: 10 });
    const b = score({ externalModules: ['node:fs'], codebaseSize: 5000 });
    expect(a).toBe(b);
  });

  it('counts talking to the host as the heaviest single blocker', () => {
    expect(score({ externalModules: ['node:fs'] })).toBe(55);
    expect(score({ externalModules: ['node:fs', 'node:net', 'node:child_process'] })).toBe(45);
  });

  it('counts framework binding, including by file type alone', () => {
    expect(score({ externalModules: ['react'] })).toBe(80);
    // the modern JSX transform means a component may import nothing at all
    expect(score({ path: 'src/Button.tsx', externalModules: [] })).toBe(80);
    expect(isComponentFile('src/Button.tsx')).toBe(true);
    expect(isComponentFile('src/logic.ts')).toBe(false);
  });

  it('charges for what a file drags along, as a share of the codebase', () => {
    expect(score({ drag: 0 })).toBe(100);
    expect(score({ drag: 50, codebaseSize: 101 })).toBe(82); // half the repo → half of 35
    expect(score({ drag: 100, codebaseSize: 101 })).toBe(65);
    // and the same count is cheaper in a bigger repo, because it is a smaller
    // part of it — 20 files is a whole library or a corner of a monolith
    expect(score({ drag: 20, codebaseSize: 21 })!).toBeLessThan(
      score({ drag: 20, codebaseSize: 1001 })!,
    );
  });

  it('does not penalise being widely imported', () => {
    // the opposite of how risk and refactor read fan-in: a util that forty
    // files import is the most reusable thing in a codebase, not the least
    expect(score({ externalModules: [] })).toBe(100);
  });

  it('treats a cycle as its own blocker, because you cannot take part of one', () => {
    expect(score({ inCycle: true })).toBe(75);
  });

  it('declines to score a file with nothing in it to reuse', () => {
    expect(score({ loc: 12, complexity: 0 })).toBeNull();
    expect(score({ loc: 12, complexity: 8 })).not.toBeNull();
    expect(score({ loc: 300, complexity: 0 })).not.toBeNull();
  });

  it('names what is holding a file down', () => {
    const result = reuseScore({
      ...base,
      path: 'src/Panel.tsx',
      externalModules: ['node:fs', 'react', 'lodash'],
    });
    expect(result.blockers).toContain('fs');
    expect(result.blockers).toContain('react');
    expect(result.blockers).not.toContain('lodash');
  });

  it('never goes below zero', () => {
    expect(
      score({
        externalModules: ['node:fs', 'node:net', 'node:http', 'react', 'express'],
        drag: 100,
        codebaseSize: 101,
        inCycle: true,
      }),
    ).toBe(0);
  });
});

describe('host binding versus framework binding', () => {
  const at = (patch: Partial<ReuseInput>) => reuseScore({ ...base, ...patch });

  it('separates them, because only one means logic is trapped behind plumbing', () => {
    expect(at({ externalModules: ['node:fs'] }).hostBound).toBe(true);
    expect(at({ externalModules: ['pg', 'axios'] }).hostBound).toBe(true);
    // a component depending on its framework is a tautology, not a finding
    expect(at({ path: 'src/Panel.tsx', externalModules: ['react'] }).hostBound).toBe(false);
    expect(at({ externalModules: ['lodash'] }).hostBound).toBe(false);
  });

  it('reports it even for a file too thin to score', () => {
    const thin = at({ loc: 8, complexity: 0, externalModules: ['node:child_process'] });
    expect(thin.score).toBeNull();
    expect(thin.hostBound).toBe(true);
  });
});
