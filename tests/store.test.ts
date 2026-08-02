import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../electron/services/store';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-storetest-'));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('ProjectStore', () => {
  it('persists positions and review state across instances', () => {
    const store1 = new ProjectStore('C:/fake/project', storage);
    store1.mergePositions({ 'a.ts': { x: 1.5, y: -2 } });
    store1.approve(['a.ts'], 1000);
    store1.saveNow();

    const store2 = new ProjectStore('C:/fake/project', storage);
    expect(store2.positions['a.ts']).toEqual({ x: 1.5, y: -2 });
    expect(store2.review.approvedAt['a.ts']).toBe(1000);
  });

  it('checkpoint clears per-file approvals and sets timestamp', () => {
    const store = new ProjectStore('C:/fake/project2', storage);
    store.approve(['a.ts', 'b.ts'], 500);
    store.checkpoint(2000);
    expect(store.review.approvedAt).toEqual({});
    expect(store.review.checkpointAt).toBe(2000);
  });

  it('separate projects get separate state', () => {
    const a = new ProjectStore('C:/proj/a', storage);
    const b = new ProjectStore('C:/proj/b', storage);
    a.approve(['x.ts'], 1);
    a.saveNow();
    expect(b.review.approvedAt['x.ts']).toBeUndefined();
  });
});
