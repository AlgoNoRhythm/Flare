import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) sourceFiles(p, into);
    else if (/\.tsx?$/.test(entry)) into.push(p);
  }
  return into;
}

/**
 * Codepoints that render as a colour emoji unless a variation selector says
 * otherwise. They ignore `color`, so they arrive at full saturation in a
 * deliberately desaturated UI, and they look different on all three targets.
 */
const EMOJI_DEFAULT = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23ed, 0x23ee, 0x23ef, 0x23f0, 0x23f1, 0x23f2,
  0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a,
  0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0,
  0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);

/** Has a text form, but several fonts default it to emoji. Needs U+FE0E. */
const NEEDS_TEXT_SELECTOR = new Set([0x26a0, 0x2139, 0x2691, 0x2699, 0x2611]);

const VS15 = 0xfe0e;

describe('glyph portability', () => {
  const files = sourceFiles(SRC);

  it('uses no astral-plane glyphs', () => {
    // The file tree drew its script and Python marks with U+1D5E7/U+1D5E3
    // (Mathematical Sans-Serif Bold). Those ship in Segoe UI Symbol and are
    // missing from most Linux installs, where the column rendered as tofu.
    const offenders: string[] = [];
    for (const file of files) {
      for (const ch of fs.readFileSync(file, 'utf8')) {
        const cp = ch.codePointAt(0)!;
        if (cp > 0xffff) offenders.push(`${path.basename(file)}: U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no emoji-by-default glyphs', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const ch of fs.readFileSync(file, 'utf8')) {
        const cp = ch.codePointAt(0)!;
        if (EMOJI_DEFAULT.has(cp)) offenders.push(`${path.basename(file)}: U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pins the ambiguous glyphs to their text form', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const chars = [...text];
      chars.forEach((ch, i) => {
        const cp = ch.codePointAt(0)!;
        if (!NEEDS_TEXT_SELECTOR.has(cp)) return;
        if (chars[i + 1]?.codePointAt(0) !== VS15) {
          offenders.push(`${path.basename(file)}: U+${cp.toString(16).toUpperCase()} without U+FE0E`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('font stacks', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

  it('names a face for every target OS', () => {
    // Consolas-first meant macOS fell through to the generic monospace — which
    // is Courier — and Linux to whatever Fontconfig chose.
    for (const face of ['-apple-system', 'Segoe UI', 'Ubuntu']) {
      expect(css, `UI stack names ${face}`).toContain(face);
    }
    for (const face of ['ui-monospace', 'Menlo', 'Consolas', 'DejaVu Sans Mono']) {
      expect(css, `mono stack names ${face}`).toContain(face);
    }
  });

  it('routes every declaration through the tokens', () => {
    const hardcoded = [...css.matchAll(/font-family:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((v) => !v.startsWith('var(') && v !== 'inherit');
    expect(hardcoded).toEqual([]);
  });
});
