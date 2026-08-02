import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_STATUS } from '../src/theme';

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

/** Every 6-digit literal outside a comment. */
function literals(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
}

/** Just the `:root` token block. */
function rootBlock(source: string): string {
  const start = source.indexOf(':root {');
  return source.slice(start, source.indexOf('}', start));
}

describe('stylesheet palette', () => {
  it('keeps every colour in the token block', () => {
    // The stylesheet once carried 118 hand-picked colours, 81 of them
    // near-identical greys with no scale between them. That is what made the
    // app read as unconsidered, and it grew one well-meaning hex at a time.
    const outsideRoot = literals(css.slice(css.indexOf('}', css.indexOf(':root {'))));
    expect(outsideRoot).toEqual([]);
  });

  it('defines a small, deliberate palette', () => {
    const declared = new Set(literals(rootBlock(css)));
    expect(declared.size).toBeLessThanOrEqual(40);
    expect(declared.size).toBeGreaterThan(20);
  });

  it('keeps the neutral ramp monotonic and consistently cool', () => {
    const root = rootBlock(css);
    const ramp: number[] = [];
    for (let i = 0; i < 14; i++) {
      const m = new RegExp(`--n${i}: (#[0-9a-fA-F]{6});`).exec(root);
      expect(m, `--n${i} is defined`).not.toBeNull();
      const hex = m![1];
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      // a consistent slight blue bias is what stops warm ink landing on cool
      // surfaces, which was the other half of the problem
      expect(b, `--n${i} leans cool`).toBeGreaterThanOrEqual(r);
      ramp.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i], `--n${i} is lighter than --n${i - 1}`).toBeGreaterThan(ramp[i - 1]);
    }
  });

  it('agrees with the status colours the panels render from JS', () => {
    // A value coloured by CSS and one coloured by an inline style have to be
    // the same colour, or the same meaning arrives in two shades.
    const root = rootBlock(css);
    for (const [token, value] of [
      ['--good', UI_STATUS.good],
      ['--warn', UI_STATUS.warning],
      ['--crit', UI_STATUS.critical],
    ] as const) {
      expect(root).toContain(`${token}: ${value};`);
    }
  });
});
