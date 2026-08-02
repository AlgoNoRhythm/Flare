/** File kinds Flare renders rather than only showing as text. */
export type PreviewKind = 'markdown' | 'image';

const MARKDOWN = /\.(md|mdx|markdown)$/i;
const IMAGE = /\.(png|jpe?g|svg|gif|webp|avif|bmp|ico)$/i;

/** What to render for this path, or null when only the editor makes sense. */
export function previewKindFor(path: string): PreviewKind | null {
  if (MARKDOWN.test(path)) return 'markdown';
  if (IMAGE.test(path)) return 'image';
  return null;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** The MIME type for a path, or null when it is not one we render. */
export function imageMime(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? null;
}

/**
 * Resolve a relative reference inside a document against the document's own
 * path — README image links are written relative to the README, not the repo
 * root, and nothing renders if that is got wrong.
 */
export function resolveRelative(fromFile: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/')) return ref;
  const base = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = (base === '' ? [] : base.split('/')).concat(ref.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
