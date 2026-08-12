/**
 * A small CommonMark-ish parser producing a node tree.
 *
 * Deliberately not a string of HTML. The renderer turns this tree into React
 * elements, so nothing a file contains is ever handed to innerHTML — which
 * matters here more than in most apps: the markdown being previewed was very
 * often written by an agent thirty seconds ago, and the renderer it would be
 * injected into holds the preload bridge that can write files.
 *
 * The subset is the one documentation actually uses: headings, paragraphs,
 * fenced and indented code, lists (nested, ordered, task), block quotes,
 * tables, thematic breaks, and inline emphasis / code / links / images.
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; title?: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string; width?: number }
  | { type: 'break' };

export type BlockKind =
  | { type: 'heading'; depth: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; head: Inline[][]; align: (('left' | 'right' | 'center') | null)[]; rows: Inline[][][] }
  | { type: 'hr' }
  | { type: 'html'; value: string };

/**
 * Every block knows which source line it started on.
 *
 * That is what lets a rendered document and the editor beside it stay on the
 * same part of the file: the renderer stamps the line onto the element, so
 * scrolling one can find the matching place in the other. Nested blocks — a
 * list item's paragraphs, a quote's contents — are numbered within their own
 * slice, since nothing needs to map *into* them.
 */
export type Block = BlockKind & { line: number };

export interface ListItem {
  /** null when the item is not a task-list entry */
  checked: boolean | null;
  children: Block[];
}

/**
 * Only schemes that cannot execute. `javascript:` and `data:` are rejected
 * outright — a link in a file an agent wrote is not a place to be relaxed.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (/^(https?|mailto|tel):/i.test(href)) return href;
  // relative links and in-page anchors are fine; anything with a scheme is not
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return href;
}

const ESCAPABLE = new Set('\\`*_{}[]()#+-.!>|~'.split(''));

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') {
      out.push({ type: 'text', value: text });
      text = '';
    }
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      text += src[++i];
      continue;
    }

    // hard break: two spaces at end of line, or a backslash before the newline
    if (ch === '\n') {
      if (text.endsWith('  ')) {
        text = text.slice(0, -2);
        flush();
        out.push({ type: 'break' });
      } else {
        text += ' ';
      }
      continue;
    }

    if (ch === '`') {
      let ticks = 1;
      while (src[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const end = src.indexOf(fence, i + ticks);
      if (end !== -1) {
        flush();
        out.push({ type: 'code', value: src.slice(i + ticks, end).replace(/^ | $/g, '') });
        i = end + ticks - 1;
        continue;
      }
    }

    if ((ch === '!' && src[i + 1] === '[') || ch === '[') {
      const isImage = ch === '!';
      const labelStart = i + (isImage ? 2 : 1);
      const labelEnd = matchBracket(src, labelStart - 1, '[', ']');
      if (labelEnd !== -1 && src[labelEnd + 1] === '(') {
        const close = matchBracket(src, labelEnd + 1, '(', ')');
        if (close !== -1) {
          const label = src.slice(labelStart, labelEnd);
          const dest = src.slice(labelEnd + 2, close).trim();
          const m = /^(\S*?)(?:\s+["'(](.*)["')])?$/s.exec(dest);
          const target = (m?.[1] ?? dest).replace(/^<|>$/g, '');
          flush();
          if (isImage) {
            out.push({ type: 'image', src: target, alt: label });
          } else {
            const href = safeHref(target);
            const children = parseInline(label);
            if (href === null) out.push(...children);
            else out.push({ type: 'link', href, title: m?.[2], children });
          }
          i = close;
          continue;
        }
      }
    }

    if (ch === '<') {
      const auto = /^<((?:https?|mailto):[^ >]+)>/.exec(src.slice(i));
      if (auto) {
        flush();
        out.push({ type: 'link', href: auto[1], children: [{ type: 'text', value: auto[1] }] });
        i += auto[0].length - 1;
        continue;
      }
    }

    const emph = matchEmphasis(src, i);
    if (emph) {
      flush();
      out.push({ type: emph.kind, children: parseInline(emph.inner) } as Inline);
      i = emph.end;
      continue;
    }

    text += ch;
  }
  flush();
  return out;
}

/** Index of the closing bracket matching the one at `from`, or -1. */
function matchBracket(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchEmphasis(
  src: string,
  i: number,
): { kind: 'strong' | 'em' | 'del'; inner: string; end: number } | null {
  for (const [marker, kind] of [
    ['***', 'strong'],
    ['~~', 'del'],
    ['**', 'strong'],
    ['__', 'strong'],
    ['*', 'em'],
    ['_', 'em'],
  ] as const) {
    if (!src.startsWith(marker, i)) continue;
    // `_` inside a word is not emphasis (snake_case_identifiers)
    if (marker === '_' && i > 0 && /\w/.test(src[i - 1])) continue;
    const end = src.indexOf(marker, i + marker.length);
    if (end === -1) continue;
    const inner = src.slice(i + marker.length, end);
    if (inner.trim() === '') continue;
    return { kind, inner, end: end + marker.length - 1 };
  }
  return null;
}

/*
 * Raw HTML, handled rather than printed.
 *
 * READMEs reach for a handful of tags and no more — an <img> for a logo or a
 * badge, a <br> to clear a float. Printing those as literal text is what a
 * markdown-only parser does, and it is the first thing you notice looking at
 * a real README. So those two are understood, and any other bare tag is
 * dropped rather than shown: this is a preview, the source pane is one click
 * away, and rendering arbitrary HTML is exactly what this parser exists to
 * avoid.
 */
const HTML_IMG_RE = /^\s*<img(\s[^>]*)?\/?>\s*$/i;
const HTML_BARE_TAG_RE = /^\s*<\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>\s*$/i;

function htmlAttr(attrs: string, name: string): string | undefined {
  // String.raw, because in a normal template literal `\b` is a backspace
  // escape rather than a word boundary — which silently produced a regex that
  // could never match, and an <img> that vanished instead of rendering
  const m = new RegExp(String.raw`\b${name}\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

const HR_RE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\') {
      cur += trimmed[i] + (trimmed[++i] ?? '');
      continue;
    }
    if (trimmed[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += trimmed[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  const paragraph: string[] = [];
  /** the line the open paragraph started on, for the stamp below */
  let paragraphAt = 0;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      type: 'paragraph',
      children: parseInline(paragraph.join('\n').trim()),
      line: paragraphAt,
    });
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    const img = HTML_IMG_RE.exec(line);
    if (img) {
      flushParagraph();
      const src = htmlAttr(img[1], 'src');
      if (src) {
        const width = htmlAttr(img[1], 'width');
        blocks.push({
          type: 'paragraph',
          line: i,
          children: [
            {
              type: 'image',
              src,
              alt: htmlAttr(img[1], 'alt') ?? '',
              width: width && /^\d+$/.test(width) ? Number(width) : undefined,
            },
          ],
        });
      }
      i++;
      continue;
    }

    if (HTML_BARE_TAG_RE.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      const start = i;
      const marker = fence[1][0].repeat(3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ type: 'code', lang: fence[2] || null, value: body.join('\n'), line: start });
      continue;
    }

    /*
     * A line of --- is both a thematic break and a setext underline. With a
     * paragraph still open it is the underline, so this has to be tested
     * before the break, or every "Title\n---" becomes text plus a rule.
     */
    if (paragraph.length > 0 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const depth = line.trim().startsWith('=') ? 1 : 2;
      const heading = paragraph.join('\n').trim();
      paragraph.length = 0;
      blocks.push({ type: 'heading', depth, children: parseInline(heading), line: paragraphAt });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'hr', line: i });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', depth: heading[1].length, children: parseInline(heading[2]), line: i });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushParagraph();
      const start = i;
      const inner: string[] = [];
      while (i < lines.length && (QUOTE_RE.test(lines[i]) || (inner.length > 0 && lines[i].trim() !== ''))) {
        inner.push(QUOTE_RE.exec(lines[i])?.[1] ?? lines[i]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseMarkdown(inner.join('\n')), line: start });
      continue;
    }

    // table: a header row followed by a delimiter row
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushParagraph();
      const start = i;
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return left && right ? ('center' as const) : right ? ('right' as const) : left ? ('left' as const) : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: 'table', head, align, rows, line: start });
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      flushParagraph();
      const { block, next } = parseList(lines, i);
      blocks.push({ ...block, line: i });
      i = next;
      continue;
    }

    if (paragraph.length === 0) paragraphAt = i;
    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = BULLET_RE.exec(lines[start]) ?? ORDERED_RE.exec(lines[start])!;
  const ordered = ORDERED_RE.test(lines[start]);
  const baseIndent = first[1].length;
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      // a blank line ends the list unless the next line continues it
      const next = lines[i + 1] ?? '';
      const cont = BULLET_RE.exec(next) ?? ORDERED_RE.exec(next);
      if (!cont || cont[1].length < baseIndent) break;
      i++;
      continue;
    }
    const m = (ordered ? ORDERED_RE : BULLET_RE).exec(line) ?? BULLET_RE.exec(line) ?? ORDERED_RE.exec(line);
    if (!m || m[1].length < baseIndent) break;
    if (m[1].length > baseIndent) {
      // deeper item: belongs to the previous item's children
      const nested = parseList(lines, i);
      const owner = items[items.length - 1];
      if (owner) owner.children.push(nested.block);
      i = nested.next;
      continue;
    }

    let content = m[3];
    let checked: boolean | null = null;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task) {
      checked = task[1].toLowerCase() === 'x';
      content = task[2];
    }
    const body: string[] = [content];
    i++;
    // continuation lines indented under this item
    while (i < lines.length && lines[i].trim() !== '' && !BULLET_RE.test(lines[i]) && !ORDERED_RE.test(lines[i])) {
      body.push(lines[i].replace(new RegExp(`^ {0,${baseIndent + 2}}`), ''));
      i++;
    }
    items.push({ checked, children: parseMarkdown(body.join('\n')) });
  }

  return {
    // the caller stamps the real line; `start` here is the list's first marker
    block: { type: 'list', ordered, start: ordered ? Number(first[2]) : 1, items, line: start },
    next: i,
  };
}
