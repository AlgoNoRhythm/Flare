import type { Lang } from './types';

/**
 * How cleanly a file could be lifted out of this repo and reused elsewhere.
 *
 * The question it answers is "if you wanted to pull this into a package, what
 * stops you?", and there are only four answers worth counting: it talks to the
 * host it runs on, it is bound to a framework, it drags half the repo with it,
 * or it is in an import cycle and cannot be taken alone at all.
 *
 * Unlike risk, hotspot and refactor — which rank files *within* a repo and so
 * normalise against the repo's own maximum — this is absolute. If every file
 * in a project imports `fs`, the least-entangled of them has not thereby
 * become reusable, and a relative scale would score it 100. Same reasoning as
 * coverage, which is left un-normalised for the same reason.
 *
 * Fan-in is deliberately not a term. A util imported by forty files is the
 * most reusable thing in a codebase, which is the exact opposite of how the
 * risk and refactor composites treat the same number.
 */

/** What an imported module ties you to. */
export type ModuleKind = 'host' | 'framework' | 'pure';

/**
 * Node built-ins that only compute. Polyfilled everywhere, so importing one
 * says nothing about where the code can run.
 */
const NODE_PURE = new Set([
  'path', 'url', 'querystring', 'buffer', 'util', 'events', 'assert', 'string_decoder',
  'crypto', 'punycode', 'timers', 'console', 'constants',
]);

/** Node built-ins that reach the machine: disk, processes, sockets, the OS. */
const NODE_HOST = new Set([
  'fs', 'child_process', 'http', 'https', 'net', 'dgram', 'dns', 'os', 'tty', 'readline',
  'cluster', 'worker_threads', 'process', 'v8', 'vm', 'inspector', 'repl', 'zlib', 'stream',
  'perf_hooks', 'module', 'async_hooks', 'diagnostics_channel', 'trace_events', 'wasi',
  'sqlite',
]);

/** Packages whose whole job is talking to something outside the process. */
const JS_HOST_PACKAGES = [
  'electron', '@lydell/node-pty', 'node-pty', 'chokidar', 'fs-extra', 'graceful-fs', 'glob',
  'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis', 'sqlite3', 'better-sqlite3',
  'prisma', '@prisma', 'knex', 'typeorm', 'drizzle-orm', 'sequelize',
  'aws-sdk', '@aws-sdk', '@google-cloud', 'firebase-admin', '@azure',
  'axios', 'node-fetch', 'got', 'undici', 'superagent', 'nodemailer',
  'puppeteer', 'playwright', '@playwright', 'selenium-webdriver', 'ws', 'socket.io',
];

/** Packages that make a file part of one application shape. */
const JS_FRAMEWORKS = [
  'react', 'react-dom', 'react-native', 'vue', 'svelte', '@angular', 'next', 'nuxt',
  'solid-js', 'preact', 'ember-source', '@remix-run', 'gatsby',
  'express', 'fastify', 'koa', '@nestjs', 'hapi', 'hono', '@hono',
  'monaco-editor', 'xterm', '@xterm', 'electron-builder', 'vite', 'webpack',
];

/** Python's standard library, split the same way. */
const PY_PURE = new Set([
  'typing', 'typing_extensions', 'dataclasses', 'collections', 'itertools', 'functools',
  'math', 'statistics', 'random', 're', 'json', 'datetime', 'decimal', 'fractions', 'enum',
  'abc', 'copy', 'string', 'textwrap', 'uuid', 'hashlib', 'hmac', 'base64', 'struct',
  'heapq', 'bisect', 'contextlib', 'operator', 'warnings', 'time', '__future__',
  'unicodedata', 'numbers', 'inspect', 'traceback', 'types', 'weakref', 'array', 'queue',
]);

const PY_HOST = new Set([
  'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib', 'io', 'signal', 'select',
  'selectors', 'multiprocessing', 'threading', 'asyncio', 'concurrent', 'sqlite3', 'ssl',
  'ftplib', 'smtplib', 'http', 'urllib', 'webbrowser', 'tempfile', 'glob', 'platform',
  'ctypes', 'resource', 'pty', 'termios', 'fcntl', 'mmap', 'pickle', 'shelve', 'logging',
  'argparse', 'configparser', 'getpass', 'curses',
]);

const PY_HOST_PACKAGES = [
  'requests', 'httpx', 'aiohttp', 'urllib3', 'boto3', 'botocore', 'psycopg2', 'psycopg',
  'pymongo', 'sqlalchemy', 'redis', 'paramiko', 'watchdog', 'pyaudio', 'sounddevice',
  'serial', 'pyserial', 'cv2', 'PIL', 'pillow', 'openpyxl',
];

const PY_FRAMEWORKS = [
  'flask', 'fastapi', 'django', 'starlette', 'tornado', 'streamlit', 'gradio', 'celery',
  'scrapy', 'pytest', 'click', 'typer',
];

/** The part of a specifier that names the package: "@scope/pkg" or "pkg". */
export function moduleHead(spec: string): string {
  const bare = spec.replace(/^node:/, '');
  if (bare.startsWith('@')) return bare.split('/').slice(0, 2).join('/');
  return bare.split(/[/.]/)[0];
}

function matches(list: string[], head: string): boolean {
  return list.some((entry) => head === entry || head.startsWith(`${entry}/`));
}

/** What kind of thing an unresolved import specifier refers to. */
export function classifyModule(spec: string, lang: Lang): ModuleKind {
  const head = moduleHead(spec);
  if (lang === 'py') {
    if (PY_HOST.has(head)) return 'host';
    if (PY_PURE.has(head)) return 'pure';
    if (matches(PY_HOST_PACKAGES, head)) return 'host';
    if (matches(PY_FRAMEWORKS, head)) return 'framework';
    return 'pure';
  }
  if (NODE_HOST.has(head)) return 'host';
  if (NODE_PURE.has(head)) return 'pure';
  if (matches(JS_HOST_PACKAGES, head)) return 'host';
  if (matches(JS_FRAMEWORKS, head)) return 'framework';
  return 'pure';
}

/**
 * A component file is bound to its framework whether or not it names one: the
 * modern JSX transform means most React components import nothing at all.
 */
export function isComponentFile(path: string): boolean {
  return /\.(tsx|jsx|vue|svelte)$/.test(path);
}

export interface ReuseInput {
  path: string;
  lang: Lang;
  loc: number;
  complexity: number;
  /** unresolved import specifiers — the ones that are not project files */
  externalModules: string[];
  /** transitive count of project files this one pulls in */
  drag: number;
  /** how many files could be dragged at most — the scored population */
  codebaseSize: number;
  inCycle: boolean;
}

export interface ReuseResult {
  /** 0..100, or null when there is too little in the file to be worth scoring */
  score: number | null;
  /** the imports that tie it down, host ones first */
  blockers: string[];
  /**
   * True when something in here talks to the machine — disk, network, process,
   * database. Kept apart from framework binding because only this one means
   * "there is logic trapped behind plumbing": a React component being bound to
   * React is a tautology, not a finding.
   */
  hostBound: boolean;
}

const HOST_BASE = 45;
const FRAMEWORK_BASE = 20;
const DRAG_MAX = 35;
const CYCLE = 25;

/**
 * A file with almost nothing in it — a constants list, a re-export, a config —
 * would score 100 for having no dependencies. True, and useless: it puts the
 * project's least interesting files at the top of the list of what to reuse.
 */
function tooThinToScore(input: ReuseInput): boolean {
  return input.complexity < 3 && input.loc < 25;
}

export function reuseScore(input: ReuseInput): ReuseResult {
  const host = new Set<string>();
  const framework = new Set<string>();
  for (const spec of input.externalModules) {
    const kind = classifyModule(spec, input.lang);
    if (kind === 'host') host.add(moduleHead(spec));
    else if (kind === 'framework') framework.add(moduleHead(spec));
  }
  if (framework.size === 0 && isComponentFile(input.path)) framework.add('component');

  const blockers = [...host, ...framework].filter((b) => b !== 'component');
  const hostBound = host.size > 0;
  if (tooThinToScore(input)) return { score: null, blockers, hostBound };

  const hostPenalty = host.size === 0 ? 0 : Math.min(60, HOST_BASE + (host.size - 1) * 5);
  const frameworkPenalty =
    framework.size === 0 ? 0 : Math.min(30, FRAMEWORK_BASE + (framework.size - 1) * 5);
  // What share of the codebase comes along. A share rather than a raw count:
  // 200 dependencies is most of a small library and a well-isolated corner of
  // a monolith, and a capped count saturates so hard that every file in an app
  // ends up with the same score.
  const dragPenalty = Math.round(
    DRAG_MAX * Math.min(1, input.drag / Math.max(1, input.codebaseSize - 1)),
  );
  const cyclePenalty = input.inCycle ? CYCLE : 0;

  return {
    score: Math.max(0, 100 - hostPenalty - frameworkPenalty - dragPenalty - cyclePenalty),
    blockers,
    hostBound,
  };
}
