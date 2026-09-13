import { useEffect, useMemo, useRef, useState } from 'react';
import { parseMarkdown } from '../../shared/markdown';
import { previewKindFor, resolveRelative } from '../../shared/preview';
import { api } from '../api';
import { languageForPath, monaco } from '../monacoSetup';
import { Markdown } from './Markdown';

interface Props {
  path: string;
  /** open it in the editor for real — the peek gets out of the way first */
  onOpenFile(path: string): void;
  onClose(): void;
  /** follow a reference to another file without leaving the peek */
  onPeek(path: string): void;
}

/**
 * A file, read where you found it.
 *
 * A double-click on the graph used to mean "leave the graph": it opened a tab,
 * and whatever you were tracing across the canvas was gone. Which is the wrong
 * trade for the thing people do most, namely *look at* a file on the way to
 * deciding something about a different one. So a double-click renders it over
 * the graph and Escape puts it back, with the real editor one button along for
 * when looking turns into changing.
 *
 * Three kinds, one frame. Prose renders, because a README you have to mentally
 * de-syntax is a README you skim. An image shows. Everything else is Monaco,
 * with the same theme and the same highlighting as the editor it stands in for
 * — a preview of a file that did not look like the file would be worse than no
 * preview at all.
 *
 * Read-only, deliberately and throughout. That is the whole reason this can be
 * dismissed with a keystroke: there is never unsaved work inside it, so it
 * never has to ask.
 */
export function FilePeek({ path, onOpenFile, onClose, onPeek }: Props) {
  const kind = previewKindFor(path);
  const [source, setSource] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(undefined);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);

  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  const folder = slash === -1 ? '' : path.slice(0, slash);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  // a new file starts at its own top, not wherever the last one was left
  useEffect(() => {
    setSource(null);
    setDataUrl(undefined);
    setAssets({});
    if (body.current) body.current.scrollTop = 0;
    let cancelled = false;
    if (kind === 'image') {
      void api.readFileDataUrl(path).then((url) => {
        if (!cancelled) setDataUrl(url);
      });
    } else {
      void api.readFile(path).then((text) => {
        if (!cancelled) setSource(text ?? '');
      });
    }
    return () => {
      cancelled = true;
    };
  }, [path, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const blocks = useMemo(
    () => (kind === 'markdown' && source !== null ? parseMarkdown(source) : []),
    [kind, source],
  );

  /*
   * The images a document references, as data URLs.
   *
   * They live on disk rather than behind a server, and fetching them here
   * keeps the renderer pure. Unlike the document pane, nothing watches them
   * for changes: a peek is open for a minute, and a file that changes under it
   * is re-read the next time it is opened.
   */
  const imageRefs = useMemo(() => {
    const refs = new Set<string>();
    const walk = (nodes: unknown[]): void => {
      for (const node of nodes as {
        type: string;
        src?: string;
        children?: unknown[];
        items?: { children: unknown[] }[];
        rows?: unknown[][][];
        head?: unknown[][];
      }[]) {
        if (node.type === 'image' && node.src) refs.add(node.src);
        if (node.children) walk(node.children);
        if (node.items) for (const item of node.items) walk(item.children);
        for (const cell of [...(node.head ?? []), ...(node.rows ?? []).flat()]) walk(cell as unknown[]);
      }
    };
    walk(blocks);
    return [...refs].sort();
  }, [blocks]);

  useEffect(() => {
    if (imageRefs.length === 0) return;
    let cancelled = false;
    void Promise.all(
      imageRefs.map(async (ref) => {
        if (/^(https?|data):/i.test(ref)) return [ref, ref] as const;
        const url = await api.readFileDataUrl(resolveRelative(path, ref));
        return [ref, url ?? ''] as const;
      }),
    ).then((pairs) => {
      if (!cancelled) setAssets(Object.fromEntries(pairs.filter(([, url]) => url !== '')));
    });
    return () => {
      cancelled = true;
    };
  }, [imageRefs, path]);

  const mark = kind === 'markdown' ? '¶' : kind === 'image' ? '▣' : '‹›';

  return (
    <div
      className="modal-backdrop"
      data-testid="filepeek-backdrop"
      onMouseDown={(e) => {
        // a click that both starts and ends on the backdrop: dragging a
        // selection out of the file must not throw the file away
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal file-peek${kind === null ? ' code' : ''}`}
        data-testid="file-peek"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} — preview`}
        tabIndex={-1}
        ref={dialog}
      >
        <div className="file-peek-head">
          <span className="file-peek-mark" aria-hidden="true">
            {mark}
          </span>
          <span className="file-peek-title">
            <b data-testid="file-peek-name">{name}</b>
            {folder !== '' && <span className="file-peek-dir mono">{folder}</span>}
          </span>
          <span className="spacer" />
          <button
            className="btn primary"
            title="Open it in the editor, where it can be changed"
            onClick={() => {
              onOpenFile(path);
              onClose();
            }}
            data-testid="file-peek-open"
          >
            Open &amp; edit
          </button>
          <button className="row-btn" onClick={onClose} title="Close (Esc)" data-testid="file-peek-close">
            ✕
          </button>
        </div>

        <div className="file-peek-body" ref={body} data-testid="file-peek-body">
          {kind === 'image' ? (
            dataUrl === undefined ? (
              <div className="muted doc-status">reading…</div>
            ) : dataUrl === null ? (
              <div className="muted doc-status">
                This image could not be read — it may be larger than 12&nbsp;MB, or not an image
                after all.
              </div>
            ) : (
              <div className="doc-image">
                <img src={dataUrl} alt={path} />
              </div>
            )
          ) : source === null ? (
            <div className="muted doc-status">reading…</div>
          ) : kind === 'markdown' ? (
            source.trim() === '' ? (
              <div className="muted doc-status">This document is empty.</div>
            ) : (
              <Markdown
                blocks={blocks}
                resolveImage={(src) => assets[src]}
                onOpenPath={(href) => onPeek(resolveRelative(path, href.split('#')[0]))}
              />
            )
          ) : (
            <ReadOnlyCode path={path} source={source} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Monaco, with nothing in it that can change the file.
 *
 * Not `EditorPane`: that one owns a save command and a dirty flag, and a
 * dialog dismissed with Escape must never be holding either. It is the same
 * editor underneath — the same theme, the same language detection — so a
 * preview of a file looks exactly like the file, which is the point.
 */
function ReadOnlyCode({ path, source }: { path: string; source: string }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const editor = monaco.editor.create(el, {
      theme: 'flare',
      value: source,
      language: languageForPath(path),
      automaticLayout: true,
      readOnly: true,
      // the chrome an editor needs and a preview does not
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", "Liberation Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 21,
      letterSpacing: 0.5,
      guides: { indentation: true, bracketPairs: 'active' },
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true, maxLineCount: 3 },
      padding: { top: 12, bottom: 16 },
      renderLineHighlight: 'none',
      smoothScrolling: true,
      // a preview is read with the keyboard too; the cursor simply cannot write
      domReadOnly: true,
    });

    /*
     * The frame is the file's size, up to a point.
     *
     * Monaco fills whatever box it is given, so a fixed one turns a six-line
     * module into a full-height sheet with five lines of code stranded at the
     * top. Asking it how tall its content is and making the box that — capped,
     * so a thousand-line file scrolls instead — is what makes a peek at a
     * small file feel like a small thing.
     *
     * No loop: `onDidContentSizeChange` fires for *content*, and resizing the
     * container around it does not change the content's height.
     */
    const fit = (): void => {
      const cap = Math.round(window.innerHeight * 0.72);
      el.style.height = `${Math.max(120, Math.min(editor.getContentHeight(), cap))}px`;
      editor.layout();
    };
    fit();
    const sizing = editor.onDidContentSizeChange(fit);
    window.addEventListener('resize', fit);

    return () => {
      window.removeEventListener('resize', fit);
      sizing.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
    };
  }, [path, source]);

  return <div className="file-peek-code" ref={host} data-testid="file-peek-code" />;
}
