import type { ParsedFile, SymbolGraph } from './types';
import { stripJsComments } from './parser';

/**
 * Symbol-level structure of one file, for graph drill-down. Spans are
 * approximated as "from this top-level symbol to the next one" — accurate
 * enough for column-0 declarations in JS/TS and Python.
 */
export function buildSymbolGraph(
  parsed: ParsedFile,
  content: string,
  importers: { importer: string; bindings: Record<string, number> }[],
): SymbolGraph {
  const stripped =
    parsed.lang === 'py' ? content.replace(/#.*$/gm, '') : stripJsComments(content);
  const lines = stripped.split('\n');
  const ordered = [...parsed.symbols].sort((a, b) => a.line - b.line);

  const spans = ordered.map((sym, i) => {
    const start = sym.line; // 1-based
    const end = i + 1 < ordered.length ? ordered[i + 1].line - 1 : lines.length;
    return { ...sym, start, end };
  });

  const symbols = spans.map((s) => ({
    name: s.name,
    line: s.line,
    kind: s.kind,
    exported: s.exported,
    loc: Math.max(1, s.end - s.start + 1),
  }));

  const intraEdges: SymbolGraph['intraEdges'] = [];
  for (const from of spans) {
    // skip the declaration line itself so `const a = b` counts b, not a
    const body = lines.slice(from.start, from.end).join('\n');
    for (const to of spans) {
      if (to.name === from.name) continue;
      const re = new RegExp(`\\b${to.name.replace(/\$/g, '\\$')}\\b`, 'g');
      const count = body.match(re)?.length ?? 0;
      if (count > 0) intraEdges.push({ from: from.name, to: to.name, weight: count });
    }
  }

  const names = new Set(parsed.symbols.map((s) => s.name));
  const inbound: SymbolGraph['inbound'] = [];
  for (const { importer, bindings } of importers) {
    for (const [name, refs] of Object.entries(bindings)) {
      if (names.has(name)) inbound.push({ importer, symbol: name, weight: Math.max(1, refs) });
    }
  }

  return { path: parsed.path, symbols, intraEdges, inbound };
}
