import { dirname, joinPosix, normalizePosix } from './paths';

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export interface TsPathMapping {
  /** e.g. "@/*" -> pattern prefix "@/" (suffix after '*' is rare, ignored) */
  prefix: string;
  /** substitution targets relative to project root, e.g. "src/" */
  targets: string[];
}

/**
 * A package that lives inside this repo — a monorepo workspace.
 *
 * `@acme/database` looks exactly like a dependency from node_modules, so
 * without this its imports resolve to nothing: the edges are missing from the
 * graph and the package's weight is invisible in every metric derived from it.
 */
export interface WorkspacePackage {
  /** the `name` from its package.json, e.g. "@acme/database" */
  name: string;
  /** project-relative directory holding that package.json, e.g. "packages/database" */
  dir: string;
  /** entry point declared by the package, extension stripped, if any */
  entry?: string;
}

export interface ResolverOptions {
  tsPaths?: TsPathMapping[];
  /** Roots to try for absolute python imports (default ['', 'src']). */
  pySourceRoots?: string[];
  workspaces?: WorkspacePackage[];
}

/** Entry candidates inside a workspace package, source before build output. */
const PACKAGE_ENTRIES = ['src/index', 'index', 'src/main', 'lib/index'];

function stripJsExt(spec: string): string {
  return spec.replace(/\.(m|c)?[jt]sx?$/, '');
}

/**
 * Read workspace packages out of the package.json files found in the repo.
 *
 * Deliberately not driven by the `workspaces` globs in the root manifest:
 * every tool declares those differently (npm and yarn in package.json, pnpm in
 * its own yaml, others not at all), whereas every one of them puts a named
 * package.json in each package directory.
 */
export function workspacePackagesFrom(
  manifests: { path: string; json: unknown }[],
): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const { path: rel, json } of manifests) {
    if (rel.includes('node_modules/')) continue;
    const pkg = json as { name?: unknown; main?: unknown; module?: unknown };
    if (typeof pkg?.name !== 'string' || pkg.name === '') continue;
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '' : rel.slice(0, slash);
    const declared = typeof pkg.module === 'string' ? pkg.module : pkg.main;
    out.push({
      name: pkg.name,
      dir,
      entry: typeof declared === 'string' ? stripJsExt(normalizePosix(declared)) : undefined,
    });
  }
  // longest name first, so "@acme/db-core" is not shadowed by "@acme/db"
  return out.sort((a, b) => b.name.length - a.name.length);
}

/**
 * Parse tsconfig-ish JSON (allows comments and trailing commas).
 *
 * Scans rather than regex-replaces, because a tsconfig is full of strings that
 * look like comments: `"@/*"` opens one and the `**\/` in an `exclude` glob
 * closes it, which quietly ate `paths` — and with it every alias edge in the
 * graph — for any project using the standard Next.js alias.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += text.slice(i, j);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      if (ch === '}' || ch === ']') {
        // trailing comma: comments are already gone, so the last non-space
        // character before the closer is the one that matters
        const trimmed = out.replace(/\s+$/, '');
        if (trimmed.endsWith(',')) out = trimmed.slice(0, -1);
      }
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
}

/**
 * Extract path mappings from a tsconfig object.
 *
 * `configDir` is where that config file lives, project-relative — `baseUrl` is
 * relative to the file that declares it, which matters once `extends` chains
 * put the mappings in a `tsconfig.base.json` somewhere else.
 */
export function tsPathsFromConfig(config: unknown, configDir = ''): TsPathMapping[] {
  const co = (config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } })
    ?.compilerOptions;
  if (!co) return [];
  const baseUrl = joinPosix(configDir, normalizePosix(co.baseUrl ?? '.'));
  const out: TsPathMapping[] = [];
  for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
    const starIdx = pattern.indexOf('*');
    const prefix = starIdx === -1 ? pattern : pattern.slice(0, starIdx);
    out.push({
      prefix,
      targets: targets.map((t) => {
        const tStar = t.indexOf('*');
        const tPrefix = tStar === -1 ? t : t.slice(0, tStar);
        return joinPosix(baseUrl, tPrefix);
      }),
    });
  }
  if (co.baseUrl) {
    // baseUrl alone allows bare imports relative to it
    out.push({ prefix: '', targets: [baseUrl] });
  }
  return out;
}

function tryJsCandidates(base: string, index: Set<string>): string | null {
  const p = normalizePosix(base);
  if (index.has(p)) return p;
  // NodeNext style: './x.js' importing './x.ts'
  const jsToTs = p.replace(/\.(m|c)?js$/, (m) => (m === '.mjs' ? '.mts' : m === '.cjs' ? '.cts' : '.ts'));
  if (jsToTs !== p) {
    if (index.has(jsToTs)) return jsToTs;
    const tsx = p.replace(/\.js$/, '.tsx');
    if (index.has(tsx)) return tsx;
  }
  for (const ext of JS_EXTS) {
    if (index.has(p + ext)) return p + ext;
  }
  for (const ext of JS_EXTS) {
    const idx = `${p}/index${ext}`;
    if (index.has(idx)) return idx;
  }
  return null;
}

function resolveJs(
  fromPath: string,
  spec: string,
  index: Set<string>,
  opts: ResolverOptions,
): string | null {
  if (spec.startsWith('.')) {
    return tryJsCandidates(joinPosix(dirname(fromPath), spec), index);
  }
  // tsconfig path aliases / baseUrl
  for (const mapping of opts.tsPaths ?? []) {
    if (mapping.prefix === '' || spec.startsWith(mapping.prefix)) {
      const rest = spec.slice(mapping.prefix.length);
      for (const target of mapping.targets) {
        const hit = tryJsCandidates(joinPosix(target, rest), index);
        if (hit) return hit;
      }
    }
  }
  // a package that lives in this repo rather than in node_modules
  for (const pkg of opts.workspaces ?? []) {
    if (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)) continue;
    const sub = spec.slice(pkg.name.length).replace(/^\//, '');
    if (sub !== '') {
      const hit =
        tryJsCandidates(joinPosix(pkg.dir, sub), index) ??
        tryJsCandidates(joinPosix(pkg.dir, 'src', sub), index);
      if (hit) return hit;
      continue;
    }
    for (const entry of [pkg.entry, ...PACKAGE_ENTRIES]) {
      if (entry === undefined) continue;
      const hit = tryJsCandidates(joinPosix(pkg.dir, entry), index);
      if (hit) return hit;
    }
  }
  return null; // external package
}

function tryPyCandidates(base: string, index: Set<string>): string | null {
  const p = normalizePosix(base);
  if (p === '') {
    return index.has('__init__.py') ? '__init__.py' : null;
  }
  if (index.has(`${p}.py`)) return `${p}.py`;
  if (index.has(`${p}/__init__.py`)) return `${p}/__init__.py`;
  return null;
}

function resolvePy(
  fromPath: string,
  spec: string,
  index: Set<string>,
  opts: ResolverOptions,
): string | null {
  const dotMatch = /^(\.+)(.*)$/.exec(spec);
  if (dotMatch) {
    const dots = dotMatch[1].length;
    const rest = dotMatch[2]; // 'a.b' or ''
    let base = dirname(fromPath);
    for (let i = 1; i < dots; i++) base = dirname(base);
    if (rest === '') return tryPyCandidates(base || '.', index) ?? null;
    return tryPyCandidates(joinPosix(base, ...rest.split('.')), index);
  }
  const parts = spec.split('.');
  for (const root of opts.pySourceRoots ?? ['', 'src']) {
    const hit = tryPyCandidates(joinPosix(root, ...parts), index);
    if (hit) return hit;
  }
  return null; // external package
}

/**
 * Resolve an import specifier to a project file, or null if external/unresolved.
 * `fromPath` is project-relative posix; `index` is the set of all project files.
 */
export function resolveImport(
  fromPath: string,
  spec: string,
  index: Set<string>,
  opts: ResolverOptions = {},
): string | null {
  if (fromPath.endsWith('.py')) return resolvePy(fromPath, spec, index, opts);
  return resolveJs(fromPath, spec, index, opts);
}
