import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_STATUS } from '../src/theme';

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

/**
 * Every hex literal outside a comment.
 *
 * Six *or eight* digits: the diff washes carry their alpha in the literal, and
 * a rule that only looked for six let `#12401f4d` sit anywhere in the file
 * without anyone noticing.
 */
function literals(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)].map((m) => m[0].toLowerCase());
}

interface Block {
  selector: string;
  body: string;
}

/** Every token block: the palettes a theme replaces, and the roles it does not. */
function tokenBlocks(source: string): Block[] {
  const out: Block[] = [];
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!/:root|\[data-theme/.test(selector)) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

/**
 * A palette declares the ramp; a role block only refers to it.
 *
 * This is the whole of the theming contract: everything with a colour in it
 * lives in a palette, and a theme is one of those blocks. Nothing else in the
 * 5,700 lines below has to know how many themes there are.
 */
const palettes = tokenBlocks(css).filter((b) => /--n0:/.test(b.body));
const roles = tokenBlocks(css).filter((b) => !/--n0:/.test(b.body));

/** `--name: value;` pairs, in declaration order. */
function tokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

describe('stylesheet palette', () => {
  it('keeps every colour in a palette block', () => {
    // The stylesheet once carried 118 hand-picked colours, 81 of them
    // near-identical greys with no scale between them. That is what made the
    // app read as unconsidered, and it grew one well-meaning hex at a time.
    const inPalettes = new Set(palettes.flatMap((b) => literals(b.body)));
    const everywhere = literals(css);
    expect(everywhere.filter((hex) => !inPalettes.has(hex))).toEqual([]);
  });

  /*
   * Alpha counts as colour.
   *
   * The first light theme came out with dark toolbar strips, because a dozen
   * `rgba(12, 14, 17, 0.85)` surfaces sat in the rules where no palette could
   * reach them — and the rule above only ever looked for hexes. A wash is a
   * colour decision like any other: white lifts a dark surface and bleaches a
   * light one, so each theme has to state its own.
   */
  it('keeps translucent colours in a palette too', () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = clean.slice(clean.indexOf('}', clean.lastIndexOf('--n13:')));
    expect([...rules.matchAll(/\brgba?\([^)]*\)/g)].map((m) => m[0])).toEqual([]);
  });

  it('keeps literals out of the roles, so a theme cannot miss one', () => {
    expect(roles.length).toBeGreaterThan(0);
    for (const block of roles) {
      expect(literals(block.body), `${block.selector} holds no colours of its own`).toEqual([]);
    }
  });

  /*
   * The cap was 40 when this block held the chrome and nothing else. It now
   * also holds the graph's categorical slots, the saturated status colours and
   * the editor's brackets and diff washes — colour that used to be spread
   * across theme.ts and monacoSetup.ts, uncounted and unguarded. Higher
   * ceiling, same purpose: the number is here so that adding a colour is a
   * decision someone makes on purpose.
   */
  it('defines a small, deliberate palette', () => {
    for (const palette of palettes) {
      const declared = new Set(literals(palette.body));
      expect(declared.size, `${palette.selector} stays deliberate`).toBeLessThanOrEqual(70);
      expect(declared.size).toBeGreaterThan(20);
    }
  });

  /*
   * Every theme has to answer for the same tokens.
   *
   * A half-written theme does not fail loudly: the missing token falls back to
   * whatever the first palette said, so a light theme with three forgotten
   * values renders as light with three dark holes in it — and only on the
   * screens nobody opened while writing it.
   */
  it('has every theme declare the same tokens', () => {
    const [first, ...rest] = palettes;
    const expected = [...tokens(first.body).keys()].sort();
    for (const palette of rest) {
      expect([...tokens(palette.body).keys()].sort(), `${palette.selector} is complete`).toEqual(expected);
    }
  });

  it('keeps the ramp running from surface to ink, without a step backwards', () => {
    for (const palette of palettes) {
      const ramp: number[] = [];
      for (let i = 0; i < 14; i++) {
        const m = new RegExp(`--n${i}: (#[0-9a-fA-F]{6});`).exec(palette.body);
        expect(m, `--n${i} is defined in ${palette.selector}`).not.toBeNull();
        const hex = m![1];
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        // a consistent slight blue bias is what stops warm ink landing on cool
        // surfaces, which was the other half of the problem
        expect(b, `--n${i} leans cool in ${palette.selector}`).toBeGreaterThanOrEqual(r);
        ramp.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
      /*
       * Monotonic, but not necessarily upward: the ramp is positional, not
       * absolute. --n0 is the surface and --n13 is the ink, so it climbs on a
       * dark theme and falls on a light one. What must not happen either way
       * is a step back, which is what "no two panels agree on what one step
       * lighter means" looked like.
       */
      const rising = ramp[13] > ramp[0];
      for (let i = 1; i < ramp.length; i++) {
        const step = ramp[i] - ramp[i - 1];
        expect(rising ? step : -step, `--n${i} steps away from --n0 in ${palette.selector}`).toBeGreaterThan(0);
      }
      // and it has to travel far enough to have a surface and an ink at all
      expect(Math.abs(ramp[13] - ramp[0]), `${palette.selector} spans surface to ink`).toBeGreaterThan(120);
    }
  });

  it('agrees with the status colours the panels render from JS', () => {
    // A value coloured by CSS and one coloured by an inline style have to be
    // the same colour, or the same meaning arrives in two shades.
    const dark = palettes[0].body;
    for (const [token, value] of [
      ['--good', UI_STATUS.good],
      ['--warn', UI_STATUS.warning],
      ['--crit', UI_STATUS.critical],
    ] as const) {
      expect(dark).toContain(`${token}: ${value};`);
    }
  });
});
