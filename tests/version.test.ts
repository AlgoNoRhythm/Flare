import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_VERSION } from '../shared/version';

/**
 * One version, in one place.
 *
 * The manifest names the installer and every artifact; `APP_VERSION` is what
 * an agent is told when it connects over MCP. They drifted once already, and
 * the drift is invisible until it is misleading someone mid-debug.
 */

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

describe('the version', () => {
  it('matches the manifest the release is built from', () => {
    expect(APP_VERSION).toBe(manifest.version);
  });

  it('is a plain semver, because it ends up in filenames', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
