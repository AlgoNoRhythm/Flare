import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlugBook, candidateSlugs, slugify } from '../electron/services/slugs';

let dir = '';
let book: SlugBook;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-slugs-'));
  book = new SlugBook(path.join(dir, 'slugs.json'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('turning a folder name into a url name', () => {
  it('keeps the name readable', () => {
    expect(slugify('My Repo!')).toBe('my-repo');
    expect(slugify('api')).toBe('api');
    expect(slugify('some_service.v2')).toBe('some-service-v2');
  });

  it('never leaves a trailing dash, even after truncating', () => {
    const long = slugify('a-very-long-project-name-that-runs-past-the-limit-x');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith('-')).toBe(false);
  });

  it('offers the plain name first and a unique one last', () => {
    const options = candidateSlugs('/home/me/work/api');
    expect(options[0]).toBe('api');
    expect(options[1]).toBe('work-api');
    expect(options).toContain('api-2');
    // whatever else collides, the last candidate is derived from the full path
    expect(options[options.length - 1]).toMatch(/^api-[0-9a-f]{6}$/);
  });
});

describe('remembering which project owns which name', () => {
  it('gives a project its own folder name', () => {
    // the whole point: /api/, not /api-3f21b8/
    expect(book.slugFor('/home/me/work/api')).toBe('api');
  });

  it('gives the same answer every time, which is what makes urls bookmarkable', () => {
    const first = book.slugFor('/home/me/work/api');
    expect(book.slugFor('/home/me/work/api')).toBe(first);
    // and to a process that reads the same book afterwards
    expect(new SlugBook(path.join(dir, 'slugs.json')).slugFor('/home/me/work/api')).toBe(first);
  });

  it('distinguishes two projects that share a folder name', () => {
    expect(book.slugFor('/home/me/work/api')).toBe('api');
    // qualified by the folder it sits in, which says something; numbering is
    // only reached when even that collides
    expect(book.slugFor('/home/me/side/api')).toBe('side-api');
    expect(book.slugFor('/opt/api')).toBe('opt-api');
    expect(book.slugFor('/elsewhere/opt/api')).toBe('api-2');
  });

  it('does not hand the same name to two projects', () => {
    const roots = ['/a/api', '/b/api', '/c/api', '/d/api', '/e/api'];
    const slugs = roots.map((r) => book.slugFor(r));
    expect(new Set(slugs).size).toBe(roots.length);
    // and the first one still has the clean name
    expect(slugs[0]).toBe('api');
  });

  it('treats a path as one project however it is written', () => {
    const a = book.slugFor('/home/me/work/api');
    expect(book.slugFor('/home/me/work/api/')).toBe(a);
    expect(book.slugFor('/home/me/work/./api')).toBe(a);
  });

  it('copes with a folder name that has nothing usable in it', () => {
    const slug = book.slugFor('/srv/!!!');
    expect(slug).not.toBe('');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('survives a corrupt book rather than refusing to name anything', () => {
    fs.writeFileSync(path.join(dir, 'slugs.json'), 'not json at all');
    expect(book.slugFor('/home/me/work/api')).toBe('api');
  });
});
