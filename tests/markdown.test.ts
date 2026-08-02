import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeHref, type Block, type Inline } from '../shared/markdown';

/** Flatten a block's inline text, for assertions that do not care about structure. */
function text(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === 'text' || n.type === 'code'
        ? n.value
        : n.type === 'image'
          ? n.alt
          : n.type === 'break'
            ? '\n'
            : text(n.children),
    )
    .join('');
}

const first = (md: string): Block => parseMarkdown(md)[0];

describe('safeHref', () => {
  it('refuses schemes that can execute', () => {
    // the markdown being previewed was often written by an agent a moment ago,
    // and the renderer holds the bridge that can write files
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeHref('vbscript:msgbox')).toBeNull();
  });

  it('allows the schemes documentation actually uses', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('./relative/path.md')).toBe('./relative/path.md');
    expect(safeHref('#anchor')).toBe('#anchor');
  });
});

describe('blocks', () => {
  it('parses ATX and setext headings', () => {
    expect(first('## Hello')).toMatchObject({ type: 'heading', depth: 2 });
    expect(text((first('## Hello') as { children: Inline[] }).children)).toBe('Hello');
    expect(first('Title\n=====')).toMatchObject({ type: 'heading', depth: 1 });
    expect(first('Sub\n---')).toMatchObject({ type: 'heading', depth: 2 });
  });

  it('parses fenced code and keeps it verbatim', () => {
    const block = first('```ts\nconst a = 1;\n// **not bold**\n```');
    expect(block).toMatchObject({ type: 'code', lang: 'ts' });
    expect((block as { value: string }).value).toBe('const a = 1;\n// **not bold**');
  });

  it('parses a thematic break', () => {
    expect(first('---')).toEqual({ type: 'hr' });
    expect(first('***')).toEqual({ type: 'hr' });
  });

  it('parses nested lists', () => {
    const list = first('- one\n- two\n  - two a\n- three') as Extract<Block, { type: 'list' }>;
    expect(list.type).toBe('list');
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    const nested = list.items[1].children.find((b) => b.type === 'list');
    expect(nested).toBeDefined();
  });

  it('parses ordered lists and keeps their start', () => {
    const list = first('3. c\n4. d') as Extract<Block, { type: 'list' }>;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items).toHaveLength(2);
  });

  it('parses task list items', () => {
    const list = first('- [x] done\n- [ ] todo') as Extract<Block, { type: 'list' }>;
    expect(list.items.map((i) => i.checked)).toEqual([true, false]);
  });

  it('parses block quotes as nested blocks', () => {
    const quote = first('> ## inside\n> and text') as Extract<Block, { type: 'quote' }>;
    expect(quote.type).toBe('quote');
    expect(quote.children[0]).toMatchObject({ type: 'heading', depth: 2 });
  });

  it('parses a GFM table with alignment', () => {
    const table = first('| a | b |\n| :- | -: |\n| 1 | 2 |') as Extract<Block, { type: 'table' }>;
    expect(table.type).toBe('table');
    expect(table.align).toEqual(['left', 'right']);
    expect(table.rows).toHaveLength(1);
    expect(text(table.rows[0][1])).toBe('2');
  });
});

describe('inline', () => {
  const inlineOf = (md: string) => (parseMarkdown(md)[0] as { children: Inline[] }).children;

  it('parses emphasis, strong and strikethrough', () => {
    expect(inlineOf('*a*')[0]).toMatchObject({ type: 'em' });
    expect(inlineOf('**a**')[0]).toMatchObject({ type: 'strong' });
    expect(inlineOf('~~a~~')[0]).toMatchObject({ type: 'del' });
  });

  it('leaves snake_case identifiers alone', () => {
    // underscores inside a word are not emphasis, or every identifier in a
    // README turns italic
    expect(text(inlineOf('call some_long_name here'))).toBe('call some_long_name here');
  });

  it('parses inline code without interpreting what is inside', () => {
    const nodes = inlineOf('use `a **b** c` here');
    expect(nodes[1]).toEqual({ type: 'code', value: 'a **b** c' });
  });

  it('parses links and images', () => {
    expect(inlineOf('[label](https://x.test)')[0]).toMatchObject({
      type: 'link',
      href: 'https://x.test',
    });
    expect(inlineOf('![alt](pic.png)')[0]).toEqual({ type: 'image', src: 'pic.png', alt: 'alt' });
  });

  it('drops a dangerous link but keeps its text', () => {
    const nodes = inlineOf('[click](javascript:alert(1))');
    expect(nodes.some((n) => n.type === 'link')).toBe(false);
    expect(text(nodes)).toContain('click');
  });

  it('honours backslash escapes', () => {
    expect(text(inlineOf('\\*not italic\\*'))).toBe('*not italic*');
  });

  it('turns two trailing spaces into a hard break', () => {
    const nodes = inlineOf('one  \ntwo');
    expect(nodes.some((n) => n.type === 'break')).toBe(true);
  });
});

describe('whole documents', () => {
  it('parses this project’s own README shape without losing blocks', () => {
    const md = [
      '# Title',
      '',
      'Intro **paragraph** with `code` and a [link](https://x.test).',
      '',
      '## Section',
      '',
      '- one',
      '- two',
      '',
      '```sh',
      'npm run build',
      '```',
      '',
      '> a quote',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'code',
      'quote',
      'table',
    ]);
  });

  it('understands the two HTML tags a README actually uses', () => {
    // printing these as literal text is what a markdown-only parser does, and
    // it is the first thing you notice looking at a real README
    const blocks = parseMarkdown(
      ['<img src="build/icon.png" alt="" width="88" align="left" />', '', 'Body.', '', '<br clear="left" />'].join('\n'),
    );
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    expect((blocks[0] as { children: Inline[] }).children[0]).toMatchObject({
      type: 'image',
      src: 'build/icon.png',
      width: 88,
    });
    // <br> and any other bare tag are dropped, not shown as text
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(text((blocks[1] as { children: Inline[] }).children)).toBe('Body.');
  });

  it('drops a raw tag rather than rendering it', () => {
    // the source pane is one click away; rendering arbitrary HTML is exactly
    // what this parser exists to avoid
    const blocks = parseMarkdown(['<div onclick="steal()">', '', 'hello'].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(text((blocks[0] as { children: Inline[] }).children)).toBe('hello');
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });
});
