import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Machine-local registry of running Flare sessions for the MCP gateway.
 * One JSON file per instance (keyed by pid) — concurrent instances never
 * write the same file, so there are no read-modify-write races. Readers
 * prune entries whose process is gone or whose heartbeat went stale.
 */

export interface McpRegistryEntry {
  pid: number;
  slug: string;
  name: string;
  root: string;
  /** the instance's private local server port (127.0.0.1) */
  port: number;
  updatedAt: number;
}

const STALE_MS = 45_000;

export function projectSlug(root: string): string {
  const base = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const hash = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 6);
  return base === '' ? hash : `${base}-${hash}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class McpRegistry {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  static defaultDir(): string {
    return process.env.FLARE_MCP_REGISTRY ?? path.join(os.tmpdir(), 'flare-mcp');
  }

  private ownFile(): string {
    return path.join(this.dir, `${process.pid}.json`);
  }

  register(entry: Omit<McpRegistryEntry, 'pid' | 'updatedAt'>): void {
    const full: McpRegistryEntry = { ...entry, pid: process.pid, updatedAt: Date.now() };
    try {
      const tmp = `${this.ownFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(full));
      fs.renameSync(tmp, this.ownFile());
    } catch {
      // best effort
    }
  }

  heartbeat(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.ownFile(), 'utf8')) as McpRegistryEntry;
      raw.updatedAt = Date.now();
      fs.writeFileSync(this.ownFile(), JSON.stringify(raw));
    } catch {
      // entry missing (not registered yet) — fine
    }
  }

  unregister(): void {
    try {
      fs.rmSync(this.ownFile(), { force: true });
    } catch {
      // best effort
    }
  }

  /** Live entries; prunes files for dead or stale instances as a side effect. */
  list(): McpRegistryEntry[] {
    const out: McpRegistryEntry[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return out;
    }
    for (const file of files) {
      const abs = path.join(this.dir, file);
      try {
        const entry = JSON.parse(fs.readFileSync(abs, 'utf8')) as McpRegistryEntry;
        const stale = Date.now() - entry.updatedAt > STALE_MS;
        if (!entry.pid || stale || !pidAlive(entry.pid)) {
          fs.rmSync(abs, { force: true });
          continue;
        }
        out.push(entry);
      } catch {
        fs.rmSync(abs, { force: true });
      }
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }
}
