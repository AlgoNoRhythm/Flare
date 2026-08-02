import { describe, expect, it } from 'vitest';
import { parseFile } from '../shared/parser';
import { buildSymbolGraph } from '../shared/symbols';

describe('buildSymbolGraph', () => {
  it('computes spans, intra-file edges and inbound symbol references', () => {
    const content = `export function low() {
  return 1;
}

export function mid() {
  return low() + low();
}

export function high() {
  return mid();
}
`;
    const parsed = parseFile('src/x.ts', content);
    const sg = buildSymbolGraph(parsed, content, [
      { importer: 'src/user.ts', bindings: { mid: 3, missing: 5 } },
    ]);

    expect(sg.symbols.map((s) => s.name)).toEqual(['low', 'mid', 'high']);
    const low = sg.symbols[0];
    expect(low.loc).toBeGreaterThanOrEqual(2);

    const midToLow = sg.intraEdges.find((e) => e.from === 'mid' && e.to === 'low');
    expect(midToLow?.weight).toBe(2);
    const highToMid = sg.intraEdges.find((e) => e.from === 'high' && e.to === 'mid');
    expect(highToMid?.weight).toBe(1);
    expect(sg.intraEdges.find((e) => e.from === 'low')).toBeUndefined();

    // inbound only includes symbols that actually exist in the file
    expect(sg.inbound).toEqual([{ importer: 'src/user.ts', symbol: 'mid', weight: 3 }]);
  });

  it('handles python files', () => {
    const content = `def base():
    return 1

def caller():
    return base() + base()
`;
    const parsed = parseFile('pkg/mod.py', content);
    const sg = buildSymbolGraph(parsed, content, []);
    const edge = sg.intraEdges.find((e) => e.from === 'caller' && e.to === 'base');
    expect(edge?.weight).toBe(2);
  });
});
