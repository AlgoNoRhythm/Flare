import { describe, expect, it } from 'vitest';
import { detectLang, parseFile, stripJsComments } from '../shared/parser';
import type { ParsedFile } from '../shared/types';

const specs = (p: ParsedFile) => p.imports.map((d) => d.spec);
const names = (p: ParsedFile) => p.symbols.map((s) => s.name);
const decl = (p: ParsedFile, spec: string) => p.imports.find((d) => d.spec === spec);

describe('stripJsComments', () => {
  it('removes line and block comments but keeps strings', () => {
    const src = `import a from './a'; // import b from './b'\n/* import c from './c' */\nconst s = "// not a comment";`;
    const out = stripJsComments(src);
    expect(out).toContain(`'./a'`); // import specifier preserved
    expect(out).not.toContain(`'./b'`);
    expect(out).not.toContain(`'./c'`);
    // non-import string content is blanked, but the string's quotes remain
    expect(out).not.toContain('// not a comment');
    expect(out).toContain('const s = "');
  });

  it('handles template literals with expressions', () => {
    const src = 'const x = `hello ${name} // not a comment`;\nimport y from "./y";';
    const out = stripJsComments(src);
    // code after the template must survive (the `//` inside it is not a comment)
    expect(out).toContain('"./y"');
    expect(out).toContain('${name}');
  });
});

describe('parseFile — TS/JS', () => {
  it('extracts static imports', () => {
    const parsed = parseFile('src/app.ts', `
import React from 'react';
import { helper } from './utils/helper';
import * as ns from '../lib/ns';
import './side-effect';
`);
    expect(specs(parsed)).toEqual(
      expect.arrayContaining(['react', './utils/helper', '../lib/ns', './side-effect']),
    );
    expect(parsed.lang).toBe('ts');
  });

  it('extracts export-from, require and dynamic imports', () => {
    const parsed = parseFile('src/index.js', `
export { a } from './a';
export * from './b';
const c = require('./c');
const d = await import('./d');
`);
    expect(specs(parsed)).toEqual(expect.arrayContaining(['./a', './b', './c', './d']));
  });

  it('ignores imports inside comments and strings', () => {
    const parsed = parseFile('x.ts', `
// import fake from './fake';
/* import fake2 from './fake2'; */
const s = "import notreal from './notreal';";
import real from './real';
`);
    expect(specs(parsed)).toEqual(['./real']);
  });

  it('counts binding references for edge weights', () => {
    const parsed = parseFile('x.ts', `
import { used, unused } from './lib';
import Def, { two as aliased } from './other';

used();
used();
aliased(Def);
`);
    const lib = decl(parsed, './lib')!;
    expect(lib.bindings.used).toBe(2);
    expect(lib.bindings.unused).toBe(0);
    const other = decl(parsed, './other')!;
    expect(other.bindings.Def).toBe(1);
    expect(other.bindings.aliased).toBe(1);
  });

  it('extracts namespace and require bindings', () => {
    const parsed = parseFile('x.ts', `
import * as ns from './ns';
const { a, b } = require('./req');
ns.thing();
ns.other();
a();
`);
    expect(decl(parsed, './ns')!.bindings.ns).toBe(2);
    expect(decl(parsed, './req')!.bindings.a).toBe(1);
    expect(decl(parsed, './req')!.bindings.b).toBe(0);
  });

  it('extracts top-level symbols with line, kind and exported flag', () => {
    const parsed = parseFile('x.ts', `
export function alpha() {}
export default class Beta {}
export const gamma = 1;
function delta() {}
const epsilon = () => {};
export interface Zeta {}
const notASymbol = 42;
`);
    expect(names(parsed)).toEqual(
      expect.arrayContaining(['alpha', 'Beta', 'gamma', 'delta', 'epsilon', 'Zeta']),
    );
    expect(names(parsed)).not.toContain('notASymbol');
    const alpha = parsed.symbols.find((s) => s.name === 'alpha')!;
    expect(alpha).toMatchObject({ line: 2, kind: 'function', exported: true });
    const beta = parsed.symbols.find((s) => s.name === 'Beta')!;
    expect(beta).toMatchObject({ kind: 'class', exported: true });
    const delta = parsed.symbols.find((s) => s.name === 'delta')!;
    expect(delta.exported).toBe(false);
  });

  it('computes branch complexity', () => {
    const simple = parseFile('a.ts', `export const x = 1;\n`);
    expect(simple.complexity).toBe(0);
    const branchy = parseFile('b.ts', `
export function f(a: number) {
  if (a > 0 && a < 10) {
    for (let i = 0; i < a; i++) {}
  }
  return a > 5 ? 'big' : 'small';
}
`);
    // if + && + for + ternary = 4
    expect(branchy.complexity).toBe(4);
  });

  it('counts non-empty lines as loc', () => {
    const parsed = parseFile('x.ts', 'a\n\nb\n  \nc');
    expect(parsed.loc).toBe(3);
  });
});

describe('parseFile — Python', () => {
  it('extracts import and from-import with speculative submodule decls', () => {
    const parsed = parseFile('app/main.py', `
import os
import utils.helpers as h, json
from .models import User
from app.services import auth
from . import sibling
`);
    expect(specs(parsed)).toEqual(
      expect.arrayContaining(['os', 'utils.helpers', 'json', '.models', 'app.services', '.', '.sibling']),
    );
    expect(specs(parsed)).toContain('.models.User');
    expect(specs(parsed)).toContain('app.services.auth');
    expect(decl(parsed, '.models.User')!.speculative).toBe(true);
    expect(decl(parsed, '.models')!.speculative).toBeUndefined();
  });

  it('counts python binding references', () => {
    const parsed = parseFile('m.py', `
from .models import User
import os

u = User()
v = User()
os.path.join('x')
`);
    expect(decl(parsed, '.models')!.bindings.User).toBe(2);
    expect(decl(parsed, 'os')!.bindings.os).toBe(1);
  });

  it('ignores commented imports and extracts symbols with metadata', () => {
    const parsed = parseFile('m.py', `
# import fake
def handler(request):
    pass
class Model:
    pass
async def fetch_all():
    pass
def _private():
    pass
`);
    expect(parsed.imports).toEqual([]);
    expect(names(parsed)).toEqual(expect.arrayContaining(['handler', 'Model', 'fetch_all', '_private']));
    expect(parsed.symbols.find((s) => s.name === 'handler')!.exported).toBe(true);
    expect(parsed.symbols.find((s) => s.name === '_private')!.exported).toBe(false);
    expect(parsed.symbols.find((s) => s.name === 'Model')!.kind).toBe('class');
  });

  it('computes python complexity', () => {
    const parsed = parseFile('m.py', `
def f(a):
    if a and a > 1:
        for i in range(a):
            pass
    elif a or False:
        while a:
            break
`);
    // if + and + for + elif + or + while = 6
    expect(parsed.complexity).toBe(6);
  });
});

describe('detectLang', () => {
  it('maps extensions', () => {
    expect(detectLang('a.tsx')).toBe('tsx');
    expect(detectLang('a.py')).toBe('py');
    expect(detectLang('a.mjs')).toBe('js');
    expect(detectLang('README.md')).toBe('other');
  });
});
