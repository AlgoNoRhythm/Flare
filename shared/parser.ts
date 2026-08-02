import type { ImportDecl, Lang, ParsedFile, SymbolInfo } from './types';
import { extname, toPosix } from './paths';

const EXT_TO_LANG: Record<string, Lang> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.py': 'py',
};

export const CODE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANG));

export function detectLang(path: string): Lang {
  return EXT_TO_LANG[extname(path).toLowerCase()] ?? 'other';
}

/**
 * Strip comments from JS/TS source. String literals are blanked to spaces so
 * regexes can't match inside them — EXCEPT strings that directly follow
 * `from` / `import` / `require(` (i.e. import specifiers), whose content is
 * preserved. Line structure is kept intact.
 */
const PRESERVE_STRING_RE = /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)$/;

export function stripJsComments(src: string): string {
  const out: string[] = [];
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  // Depth of ${ ... } nesting inside template literals.
  const templateStack: number[] = [];
  // Tail of recently emitted code, used to decide whether an opening quote
  // starts an import specifier (whose content must be preserved).
  let recent = '';
  let preserveString = false;
  const pushCode = (s: string) => {
    out.push(s);
    recent = (recent + s).slice(-32);
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line';
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === '/' && next === '*') {
          state = 'block';
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === "'" || c === '"') {
          state = c === "'" ? 'single' : 'double';
          preserveString = PRESERVE_STRING_RE.test(recent);
          pushCode(c);
          i++;
          continue;
        }
        if (c === '`') {
          state = 'template';
          templateStack.push(0);
          pushCode(c);
          i++;
          continue;
        }
        if (c === '}' && templateStack.length > 0) {
          const depth = templateStack[templateStack.length - 1];
          if (depth === 0) {
            // closing a ${ } — back into the template literal
            state = 'template';
            pushCode(c);
            i++;
            continue;
          }
          templateStack[templateStack.length - 1]--;
        } else if (c === '{' && templateStack.length > 0) {
          templateStack[templateStack.length - 1]++;
        }
        pushCode(c);
        i++;
        continue;
      case 'line':
        if (c === '\n') {
          state = 'code';
          out.push('\n');
        } else out.push(' ');
        i++;
        continue;
      case 'block':
        if (c === '*' && next === '/') {
          state = 'code';
          out.push('  ');
          i += 2;
          continue;
        }
        out.push(c === '\n' ? '\n' : ' ');
        i++;
        continue;
      case 'single':
      case 'double': {
        const quote = state === 'single' ? "'" : '"';
        if (c === '\\') {
          out.push(preserveString ? src.slice(i, i + 2) : '  ');
          i += 2;
          continue;
        }
        if (c === quote || c === '\n') {
          state = 'code';
          pushCode(c);
          i++;
          continue;
        }
        out.push(preserveString ? c : ' ');
        i++;
        continue;
      }
      case 'template':
        if (c === '\\') {
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === '`') {
          state = 'code';
          templateStack.pop();
          pushCode(c);
          i++;
          continue;
        }
        if (c === '$' && next === '{') {
          state = 'code';
          pushCode('${');
          i += 2;
          continue;
        }
        out.push(c === '\n' ? '\n' : ' ');
        i++;
        continue;
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// JS/TS
// ---------------------------------------------------------------------------

const JS_IMPORT_FROM_RE =
  /(?:^|[^\w.$])import\s+((?:type\s+)?[\w$]+(?:\s*,\s*\{[^}]*\})?|(?:type\s+)?\{[^}]*\}|\*\s+as\s+[\w$]+)\s+from\s*['"]([^'"\n]+)['"]/g;
const JS_BARE_IMPORT_RE = /(?:^|[^\w.$])import\s*['"]([^'"\n]+)['"]/g;
const JS_EXPORT_FROM_RE =
  /(?:^|[^\w.$])export\s+((?:type\s+)?\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s*['"]([^'"\n]+)['"]/g;
const JS_REQUIRE_BIND_RE =
  /(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const JS_REQUIRE_RE = /(?:^|[^\w.$])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const JS_DYNAMIC_IMPORT_RE = /(?:^|[^\w.$])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** Local binding names from an import clause like `A, { b as c, d }` or `* as ns`. */
function bindingsFromClause(clause: string): string[] {
  const names: string[] = [];
  const cleaned = clause.replace(/\btype\s+/g, '').trim();
  const star = /^\*\s+as\s+([\w$]+)$/.exec(cleaned);
  if (star) return [star[1]];
  const braceStart = cleaned.indexOf('{');
  const head = braceStart === -1 ? cleaned : cleaned.slice(0, braceStart);
  const defaultName = head.replace(/,/g, '').trim();
  if (/^[\w$]+$/.test(defaultName)) names.push(defaultName);
  if (braceStart !== -1) {
    const inner = cleaned.slice(braceStart + 1, cleaned.lastIndexOf('}'));
    for (const part of inner.split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (/^[\w$]+$/.test(local)) names.push(local);
    }
  }
  return names;
}

/** Blank quoted string contents (incl. import specifiers) so identifier counts ignore them. */
function blankStrings(code: string): string {
  return code.replace(/(['"])[^'"\n]*\1/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
}

function countRefs(countSource: string, name: string): number {
  if (!/^[\w$]+$/.test(name)) return 0;
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
  const matches = countSource.match(re);
  // subtract the declaration/import occurrence itself
  return Math.max(0, (matches?.length ?? 0) - 1);
}

interface RawDecl {
  spec: string;
  names: string[];
  countable: boolean;
  speculative?: boolean;
}

function mergeDecls(raw: RawDecl[], stripped: string): ImportDecl[] {
  const countSource = blankStrings(stripped);
  const bySpec = new Map<string, ImportDecl>();
  for (const d of raw) {
    let decl = bySpec.get((d.speculative ? 'S:' : 'N:') + d.spec);
    if (!decl) {
      decl = { spec: d.spec, bindings: {} };
      if (d.speculative) decl.speculative = true;
      bySpec.set((d.speculative ? 'S:' : 'N:') + d.spec, decl);
    }
    for (const name of d.names) {
      if (!(name in decl.bindings)) {
        decl.bindings[name] = d.countable ? countRefs(countSource, name) : 1;
      }
    }
  }
  return [...bySpec.values()];
}

function jsComplexity(stripped: string): number {
  const keywords = stripped.match(/\b(if|for|while|case|catch|do)\b/g)?.length ?? 0;
  const logical = stripped.match(/&&|\|\|/g)?.length ?? 0;
  // ternary '?' — exclude optional chaining `?.`, nullish `??`, optional `?:`
  const ternary = stripped.match(/\?[^.?:]/g)?.length ?? 0;
  return keywords + logical + ternary;
}

const JS_SYMBOL_PATTERNS: {
  re: RegExp;
  kind: SymbolInfo['kind'];
  exported: boolean;
}[] = [
  { re: /^export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', exported: true },
  { re: /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', exported: true },
  { re: /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', exported: false },
  { re: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: true },
  { re: /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: false },
  { re: /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type', exported: true },
  { re: /^(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)\s*[={<]/, kind: 'type', exported: false },
  { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'variable', exported: true },
  { re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|class)/, kind: 'variable', exported: false },
];

function parseJsLike(path: string, content: string, lang: Lang): ParsedFile {
  const stripped = stripJsComments(content);
  const raw: RawDecl[] = [];
  let m: RegExpExecArray | null;

  JS_IMPORT_FROM_RE.lastIndex = 0;
  while ((m = JS_IMPORT_FROM_RE.exec(stripped)) !== null) {
    raw.push({ spec: m[2], names: bindingsFromClause(m[1]), countable: true });
  }
  JS_EXPORT_FROM_RE.lastIndex = 0;
  while ((m = JS_EXPORT_FROM_RE.exec(stripped)) !== null) {
    raw.push({ spec: m[2], names: [], countable: false });
  }
  JS_REQUIRE_BIND_RE.lastIndex = 0;
  const requireBindSpecs = new Set<string>();
  while ((m = JS_REQUIRE_BIND_RE.exec(stripped)) !== null) {
    requireBindSpecs.add(m[2]);
    raw.push({ spec: m[2], names: bindingsFromClause(m[1]), countable: true });
  }
  for (const re of [JS_BARE_IMPORT_RE, JS_REQUIRE_RE, JS_DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) {
      if (!requireBindSpecs.has(m[1])) raw.push({ spec: m[1], names: [], countable: false });
    }
  }

  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind, exported } of JS_SYMBOL_PATTERNS) {
      const sm = re.exec(lines[i]);
      if (sm) {
        if (!seen.has(sm[1])) {
          seen.add(sm[1]);
          symbols.push({ name: sm[1], line: i + 1, kind, exported });
        }
        break;
      }
    }
  }

  return {
    path: toPosix(path),
    lang,
    imports: mergeDecls(raw, stripped),
    symbols: symbols.slice(0, 100),
    loc: countLoc(content),
    complexity: jsComplexity(stripped),
    todos: countTodos(content),
  };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_IMPORT_RE = /^\s*import\s+(.+)$/;
const PY_FROM_RE = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/;
const PY_SYMBOL_PATTERNS: { re: RegExp; kind: SymbolInfo['kind'] }[] = [
  { re: /^async\s+def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
];

function pyComplexity(source: string): number {
  const stripped = source.replace(/#.*$/gm, '');
  return stripped.match(/\b(if|elif|for|while|except|and|or|case)\b/g)?.length ?? 0;
}

function parsePython(path: string, content: string): ParsedFile {
  const raw: RawDecl[] = [];
  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();
  const strippedLines: string[] = [];
  const rawLines = content.split('\n');

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const line = rawLine.replace(/#.*$/, '');
    strippedLines.push(line);
    let m = PY_FROM_RE.exec(line);
    if (m) {
      const spec = m[1];
      const parts = m[2]
        .replace(/\(.*$/, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const locals: string[] = [];
      for (const part of parts) {
        const [orig, alias] = part.split(/\s+as\s+/).map((s) => s?.trim());
        const local = alias ?? orig;
        if (/^[A-Za-z_]\w*$/.test(orig ?? '') && /^[A-Za-z_]\w*$/.test(local ?? '')) {
          locals.push(local);
          // speculative submodule decl: `from pkg import mod` may target pkg/mod.py
          raw.push({
            spec: spec.endsWith('.') ? spec + orig : `${spec}.${orig}`,
            names: [local],
            countable: true,
            speculative: true,
          });
        }
      }
      raw.push({ spec, names: locals, countable: true });
      continue;
    }
    m = PY_IMPORT_RE.exec(line);
    if (m && !/^\s*import\s*$/.test(line)) {
      for (const part of m[1].split(',')) {
        const [orig, alias] = part.trim().split(/\s+as\s+/).map((s) => s?.trim());
        if (/^[.\w]+$/.test(orig ?? '')) {
          const local = alias ?? orig.split('.')[0];
          raw.push({ spec: orig, names: /^[A-Za-z_]\w*$/.test(local) ? [local] : [], countable: true });
        }
      }
      continue;
    }
    for (const { re, kind } of PY_SYMBOL_PATTERNS) {
      const sm = re.exec(rawLine);
      if (sm) {
        if (!seen.has(sm[1])) {
          seen.add(sm[1]);
          symbols.push({ name: sm[1], line: i + 1, kind, exported: !sm[1].startsWith('_') });
        }
        break;
      }
    }
  }

  return {
    path: toPosix(path),
    lang: 'py',
    imports: mergeDecls(raw, strippedLines.join('\n')),
    symbols: symbols.slice(0, 100),
    loc: countLoc(content),
    complexity: pyComplexity(content),
    todos: countTodos(content),
  };
}

function countLoc(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) if (line.trim().length > 0) count++;
  return count;
}

function countTodos(content: string): number {
  return content.match(/\b(TODO|FIXME|HACK|XXX)\b/g)?.length ?? 0;
}

export function parseFile(path: string, content: string): ParsedFile {
  const lang = detectLang(path);
  if (lang === 'py') return parsePython(path, content);
  if (lang === 'other') {
    return {
      path: toPosix(path),
      lang,
      imports: [],
      symbols: [],
      loc: countLoc(content),
      complexity: 0,
      todos: countTodos(content),
    };
  }
  return parseJsLike(path, content, lang);
}
