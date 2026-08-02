import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The name a project goes by in a URL.
 *
 * These end up in the address bar and in the MCP endpoint an agent is
 * registered against, so they are read by people: `/api/` beats
 * `/api-3f21b8/`, which is a hash pretending to be a name. The hash was there
 * to guarantee uniqueness, but almost every project on a machine has a
 * distinct folder name and pays that cost for a collision that never happens.
 *
 * So the folder name is the slug, and the hash is the last resort rather than
 * the rule. Assignments are remembered, which is what makes a pretty slug also
 * a stable one: first project to claim `api` keeps it, and the second gets
 * something that distinguishes it — for good, not for as long as both happen
 * to be running.
 */

/** A folder name reduced to something that belongs in a URL. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** Last-resort suffix: short, stable, and unique to the path. */
export function pathHash(root: string): string {
  return crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 6);
}

/** Windows paths differ only in case; the same folder must not get two slugs. */
function normalise(root: string): string {
  const resolved = path.resolve(root).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Names to try, best first: the folder, then the folder qualified by its
 * parent, then numbered, then the hash that cannot collide.
 */
export function candidateSlugs(root: string): string[] {
  const resolved = path.resolve(root);
  const base = slugify(path.basename(resolved)) || 'project';
  const parent = slugify(path.basename(path.dirname(resolved)));
  const out = [base];
  if (parent !== '' && parent !== base) out.push(`${parent}-${base}`);
  for (let n = 2; n <= 9; n += 1) out.push(`${base}-${n}`);
  out.push(`${base}-${pathHash(resolved)}`);
  return out;
}

interface Book {
  [root: string]: string;
}

/**
 * Remembered slug assignments, shared by every Flare process using this data
 * directory — the desktop app, a supervisor, and each of its sessions.
 */
export class SlugBook {
  constructor(private file: string) {}

  private read(): Book {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Book) : {};
    } catch {
      return {};
    }
  }

  private write(book: Book): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(book, null, 1));
      fs.renameSync(tmp, this.file);
    } catch {
      // best effort: an unwritable book just means slugs are recomputed
    }
  }

  /** The slug for this project, assigning and remembering one if it is new. */
  slugFor(root: string): string {
    const key = normalise(root);

    // Two processes can open different projects at the same moment and pick
    // the same free name. Re-reading after the write catches that, and the
    // loser tries again — bounded, because each attempt rules out one name.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const book = this.read();
      const known = book[key];
      if (typeof known === 'string' && known !== '') return known;

      const taken = new Set(Object.values(book));
      const chosen = candidateSlugs(root).find((slug) => !taken.has(slug));
      // candidateSlugs always ends in a path-unique name, so this cannot be
      // undefined unless that exact name is already ours
      const slug = chosen ?? `${slugify(path.basename(path.resolve(root)))}-${pathHash(root)}`;
      this.write({ ...book, [key]: slug });
      if (this.read()[key] === slug) return slug;
    }
    return `${slugify(path.basename(path.resolve(root))) || 'project'}-${pathHash(root)}`;
  }

  /** Forget an assignment — only used by tests and by cleanup. */
  forget(root: string): void {
    const book = this.read();
    delete book[normalise(root)];
    this.write(book);
  }
}
