import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseMarkdown } from '../../shared/markdown';
import { previewKindFor, resolveRelative, type PreviewKind } from '../../shared/preview';
import { api } from '../api';
import { monaco } from '../monacoSetup';
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
  const renderRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const scrollSub = useRef<{ dispose(): void } | null>(null);
  /*
   * Which half is currently driving.
   *
   * Scrolling one moves the other, which fires the other's scroll handler,
   * which would move the first one back — a fight that reads as the document
   * juddering under the pointer. So whoever moved first holds the lead for a
   * moment and the echo is ignored.
   *
   * The window has to outlast the *animation*, not just the call: the editor
   * scrolls smoothly, so it goes on emitting scroll events for a few frames
   * after being moved. At 150ms those trailing frames grabbed the lead back
   * and dragged the preview to wherever the animation had got to, which left
   * the two panes disagreeing at the end of every gesture.
   */
  const lead = useRef<{ side: 'source' | 'render'; until: number } | null>(null);
  const retry = useRef(0);

  const takeLead = (side: 'source' | 'render'): boolean => {
    const now = Date.now();
    if (lead.current && lead.current.side !== side && now < lead.current.until) return false;
    lead.current = { side, until: now + 320 };
    return true;
  };

  /**
   * Come back to a scroll that lost the race.
   *
   * A blocked sync used to be dropped, and that is fine while the events keep
   * coming — the next one lands. It is not fine at either end of the document:
   * scroll the preview to the top and it stops emitting events the moment it
   * hits zero, so if that last one arrived while the editor still held the
   * lead, nothing ever moved the editor and the two panes sat disagreeing.
   * Whoever moved last gets the final word once things have settled.
   */
  const syncLater = (side: 'source' | 'render'): void => {
    window.clearTimeout(retry.current);
    retry.current = window.setTimeout(() => {
      if (!takeLead(side)) return;
      if (side === 'render') syncFromRender();
      else syncFromSource();
    }, 340);
  };

  /*
   * Everything below measures against the *viewport* rather than against
   * content coordinates.
   *
   * `scrollTop` counts from the padding edge while `getBoundingClientRect()`
   * counts from the border edge, so mixing them silently offsets every
   * comparison by the pane's top padding — which is what put the source five
   * lines behind the preview when scrolling from the rendered side.
   */
  const renderBlocks = (): { els: HTMLElement[]; originY: number; host: HTMLElement } | null => {
    const host = renderRef.current;
    if (!host) return null;
    const els = [...host.querySelectorAll<HTMLElement>('.md-block[data-line]')];
    if (els.length === 0) return null;
    const padding = parseFloat(getComputedStyle(host).paddingTop) || 0;
    return { els, originY: host.getBoundingClientRect().top + padding, host };
  };

  const lineOf = (el: HTMLElement): number => Number(el.dataset.line);
  const yOf = (el: HTMLElement): number => el.getBoundingClientRect().top;

  /** How far the rendered pane must scroll to put `line` at its top. */
  const renderDeltaForLine = (line: number): number | null => {
    const found = renderBlocks();
    if (!found) return null;
    const { els, originY } = found;
    let i = 0;
    while (i + 1 < els.length && lineOf(els[i + 1]) <= line) i++;
    const here = els[i];
    const next = els[i + 1];
    if (!next) return yOf(here) - originY;
    const span = Math.max(1, lineOf(next) - lineOf(here));
    const t = Math.min(1, Math.max(0, (line - lineOf(here)) / span));
    return yOf(here) + t * (yOf(next) - yOf(here)) - originY;
  };

  /** The source line showing at the top of the rendered document. */
  const lineForRenderTop = (): number | null => {
    const found = renderBlocks();
    if (!found) return null;
    const { els, originY } = found;
    let i = 0;
    while (i + 1 < els.length && yOf(els[i + 1]) <= originY + 1) i++;
    const here = els[i];
    const next = els[i + 1];
    if (!next) return lineOf(here);
    const gap = Math.max(1, yOf(next) - yOf(here));
    const t = Math.min(1, Math.max(0, (originY - yOf(here)) / gap));
    return lineOf(here) + t * (lineOf(next) - lineOf(here));
  };

  /**
   * Keep the two halves on the same part of the document.
   *
   * They used to scroll independently: the source could be at section seven
   * while the preview beside it still showed section one, which makes reading
   * what an agent wrote a matter of finding your place twice. The parser
   * stamps every block with its source line, so this is a lookup rather than a
   * guess at proportions — a long code fence no longer drags the two apart.
   */
  /** Put the preview where the editor is. */
  const syncFromSource = (): void => {
    const editor = editorRef.current;
    const host = renderRef.current;
    if (!editor || !host) return;
    const line = editor.getVisibleRanges()[0]?.startLineNumber;
    if (line === undefined) return;
    const delta = renderDeltaForLine(line - 1);
    if (delta !== null) host.scrollTop += delta;
  };

  /** Put the editor where the preview is. */
  const syncFromRender = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const line = lineForRenderTop();
    if (line === null) return;
    editor.setScrollTop(editor.getTopForLineNumber(Math.max(1, Math.round(line) + 1)));
  };

  const attachEditor = useCallback((editor: monaco.editor.IStandaloneCodeEditor | null) => {
    scrollSub.current?.dispose();
    scrollSub.current = null;
    editorRef.current = editor;
    if (!editor) return;
    scrollSub.current = editor.onDidScrollChange(() => {
      if (!takeLead('source')) {
        syncLater('source');
        return;
      }
      syncFromSource();
    });
  }, []);

  useEffect(
    () => () => {
      scrollSub.current?.dispose();
      window.clearTimeout(retry.current);
    },
    [],
  );

  const onRenderScroll = (): void => {
    if (!editorRef.current || !showSource) return;
    if (!takeLead('render')) {
      syncLater('render');
      return;
    }
    syncFromRender();
  };

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
                onReady={attachEditor}
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

      <div className="doc-render" data-testid="doc-render" ref={renderRef} onScroll={onRenderScroll}>
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
