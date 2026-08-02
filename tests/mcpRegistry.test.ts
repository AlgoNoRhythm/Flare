import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpRegistry, projectSlug } from '../electron/services/mcpRegistry';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-reg-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('projectSlug', () => {
  it('is stable, readable and sanitized', () => {
    const a = projectSlug('C:/Users/x/My Repo!');
    expect(a).toMatch(/^my-repo-[0-9a-f]{6}$/);
    expect(projectSlug('C:/Users/x/My Repo!')).toBe(a);
    // different roots with the same basename stay distinct
    expect(projectSlug('C:/other/My Repo!')).not.toBe(a);
  });
});

describe('McpRegistry', () => {
  it('registers, lists and heartbeats the own entry', () => {
    const reg = new McpRegistry(dir);
    reg.register({ slug: 'proj-abc123', name: 'proj', root: 'C:/proj', port: 12345 });
    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ slug: 'proj-abc123', port: 12345, pid: process.pid });
    const before = listed[0].updatedAt;
    reg.heartbeat();
    expect(reg.list()[0].updatedAt).toBeGreaterThanOrEqual(before);
    reg.unregister();
    expect(reg.list()).toHaveLength(0);
  });

  it('prunes entries whose process is dead', () => {
    const reg = new McpRegistry(dir);
    fs.writeFileSync(
      path.join(dir, '999999999.json'),
      JSON.stringify({ pid: 999999999, slug: 'ghost-000000', name: 'ghost', root: 'C:/ghost', port: 1, updatedAt: Date.now() }),
    );
    expect(reg.list()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, '999999999.json'))).toBe(false);
  });

  it('prunes stale-heartbeat and corrupt entries', () => {
    const reg = new McpRegistry(dir);
    fs.writeFileSync(
      path.join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, slug: 'old-000000', name: 'old', root: 'C:/old', port: 1, updatedAt: Date.now() - 120_000 }),
    );
    fs.writeFileSync(path.join(dir, '1234.json'), 'not json');
    expect(reg.list()).toHaveLength(0);
  });

  it('multiple pids coexist without clobbering', () => {
    const reg = new McpRegistry(dir);
    reg.register({ slug: 'a-111111', name: 'a', root: 'C:/a', port: 1 });
    // simulate a second live instance by borrowing our own pid semantics:
    // write a file for a pid that is certainly alive (pid 0/4 is system; use our pid+file name trick)
    fs.writeFileSync(
      path.join(dir, 'other.json'),
      JSON.stringify({ pid: process.pid, slug: 'b-222222', name: 'b', root: 'C:/b', port: 2, updatedAt: Date.now() }),
    );
    const slugs = reg.list().map((e) => e.slug);
    expect(slugs).toEqual(['a-111111', 'b-222222']);
  });
});
