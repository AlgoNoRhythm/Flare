import { useEffect, useMemo, useRef, useState } from 'react';
import { parseMarkdown } from '../../shared/markdown';
import { previewKindFor, resolveRelative, type PreviewKind } from '../../shared/preview';
import { api } from '../api';
import { EditorPane } from './EditorPane';
import { Markdown } from './Markdown';
import { Splitter } from './Splitter';

interface Props {
  path: string;
  kind: PreviewKind;
  externalVersion: number;
  /**
   * When every file in the project last changed.
   *
   * A document is not only its own text: a README is mostly the screenshots it
   * embeds. Those are separate files, so rewriting one bumps *its* version and
   * not this document's — and the page went on showing an image that no longer
   * existed on disk. This is what tells the assets below they are stale.
   */
  changedAt: Record<string, number>;
  onDirtyChange(path: string, dirty: boolean): void;
  onOpenFile(path: string): void;
}

/**
 * A renderable file: the rendered document, with its source one click away.
 *
 * Rendered is the default because that is what the file is *for* — a README
 * you have to mentally de-syntax is a README you skim. The source is not
 * hidden though: it slides out from the left, live, sharing the same editor
 * the rest of the app uses, so checking what an agent actually wrote into a
 * document is one click rather than a different tab.
 */
export function DocumentPane({
  path,
  kind,
  externalVersion,
  changedAt,
  onDirtyChange,
  onOpenFile,
}: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(undefined);
  const [showSource, setShowSource] = useState(false);
  const [sourceWidth, setSourceWidth] = useState(440);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const hostRef = useRef<HTMLDivElement | null>(null);

  // the document itself
  useEffect(() => {
    let cancelled = false;
    if (kind === 'markdown') {
      void api.readFile(path).then((text) => {
        if (!cancelled) setSource(text ?? '');
      });
    } else {
      void api.readFileDataUrl(path).then((url) => {
        if (!cancelled) setDataUrl(url);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [path, kind, externalVersion]);

  const blocks = useMemo(() => (source === null ? [] : parseMarkdown(source)), [source]);

  /*
   * Images a markdown file references are relative to the file, and live on
   * disk rather than on a server, so each one is fetched as a data URL. Doing
   * it here rather than in the renderer keeps the render pure and synchronous.
   */
  const imageRefs = useMemo(() => {
    const refs = new Set<string>();
    const walk = (nodes: unknown[]): void => {
      for (const node of nodes as { type: string; src?: string; children?: unknown[]; items?: { children: unknown[] }[]; rows?: unknown[][][]; head?: unknown[][] }[]) {
        if (node.type === 'image' && node.src) refs.add(node.src);
        if (node.children) walk(node.children);
        if (node.items) for (const item of node.items) walk(item.children);
        for (const cell of [...(node.head ?? []), ...(node.rows ?? []).flat()]) walk(cell as unknown[]);
      }
    };
    walk(blocks);
    return [...refs].sort();
  }, [blocks]);

  /** When any embedded image last changed — re-fetch on the strength of this. */
  const assetStamp = useMemo(
    () => imageRefs.map((ref) => changedAt[resolveRelative(path, ref)] ?? 0).join(','),
    [imageRefs, changedAt, path],
  );

  useEffect(() => {
    if (kind !== 'markdown') return;
    let cancelled = false;
    void Promise.all(
      imageRefs.map(async (ref) => {
        if (/^(https?|data):/i.test(ref)) return [ref, ref] as const;
        const url = await api.readFileDataUrl(resolveRelative(path, ref));
        return [ref, url ?? ''] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setAssets(Object.fromEntries(pairs.filter(([, url]) => url !== '')));
    });
    return () => {
      cancelled = true;
    };
  }, [imageRefs, assetStamp, kind, path]);

  return (
    <div className="doc-pane" ref={hostRef} data-testid={`doc-${path}`}>
      {showSource && (
        <>
          <div className="doc-source" style={{ width: sourceWidth }}>
            <div className="doc-source-head">
              <span>Source</span>
              <span className="spacer" />
              <button
                className="btn"
                onClick={() => setShowSource(false)}
                title="Hide the source (the rendered document stays)"
                data-testid="doc-source-hide"
              >
                ✕
              </button>
            </div>
            <div className="doc-source-body">
              <EditorPane
                path={path}
                externalVersion={externalVersion}
                onDirtyChange={onDirtyChange}
              />
            </div>
          </div>
          <Splitter
            direction="horizontal"
            onDrag={(x) => setSourceWidth(Math.max(220, Math.min(900, x - (hostRef.current?.getBoundingClientRect().left ?? 0))))}
          />
        </>
      )}

      {!showSource && (
        <button
          className="doc-source-tab"
          onClick={() => setShowSource(true)}
          title="Show the source alongside the rendered document"
          data-testid="doc-source-show"
        >
          Source
        </button>
      )}

      <div className="doc-render" data-testid="doc-render">
        {kind === 'markdown' ? (
          source === null ? (
            <div className="muted doc-status">reading…</div>
          ) : (
            <Markdown
              blocks={blocks}
              resolveImage={(src) => assets[src]}
              onOpenPath={(href) => onOpenFile(resolveRelative(path, href.split('#')[0]))}
            />
          )
        ) : dataUrl === undefined ? (
          <div className="muted doc-status">reading…</div>
        ) : dataUrl === null ? (
          <div className="muted doc-status">
            This image could not be read — it may be larger than 12&nbsp;MB, or not an image after all.
          </div>
        ) : (
          <div className="doc-image">
            <img src={dataUrl} alt={path} />
          </div>
        )}
      </div>
    </div>
  );
}
