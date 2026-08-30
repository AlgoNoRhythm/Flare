import { useEffect, useMemo, useRef, useState } from 'react';
import { groupHits, type SearchHit, type SearchOptions } from '../../shared/search';
import { colorizeLine } from '../colorize';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  kind: 'file' | 'command';
  run(): void;
}

/** what the palette is for right now: jumping to a file, or finding text in files */
export type PaletteMode = 'jump' | 'search';

interface Props {
  open: boolean;
  items: PaletteItem[];
  mode: PaletteMode;
  onModeChange(mode: PaletteMode): void;
  /** text to start a search with — the top bar hands its query over on Ctrl+Enter */
  seedQuery?: string;
  onClose(): void;
  onSearch(query: string, options: SearchOptions): Promise<SearchHit[]>;
  onOpenHit(path: string, line: number): void;
  onReplace(
    query: string,
    replacement: string,
    options: SearchOptions,
    paths: string[],
  ): Promise<{ files: number; replacements: number }>;
  /** the colour a file's folder has on the graph, so the groups read apart */
  pathColor?(path: string): string | undefined;
}

/** Subsequence fuzzy score — higher is better, -1 means no match. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === '') return 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak * 2;
      // bonus for matching after a separator
      if (ti === 0 || '/\\.-_ '.includes(t[ti - 1])) score += 6;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1;
  // prefer shorter targets
  return score - t.length * 0.05;
}

type SearchGroup = { path: string; hits: SearchHit[] };
type SearchRow = { kind: 'file'; group: SearchGroup } | { kind: 'hit'; hit: SearchHit; group: SearchGroup };

/**
 * One matched line, coloured like the editor colours it.
 *
 * Plain text with the match marked is shown first, so a list of hundreds of
 * hits is legible immediately; the tokenised version replaces it a frame
 * later. Monaco's token classes are scoped to `.monaco-editor`, which is why
 * the span wears that class — see the `.search-code` override.
 */
function SearchPreview({ hit }: { hit: SearchHit }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void colorizeLine(hit.path, hit.preview, hit.previewCol, hit.length).then((h) => {
      if (live) setHtml(h);
    });
    return () => {
      live = false;
    };
  }, [hit]);
  if (html === null) {
    return (
      <span className="mono search-preview">
        {hit.preview.slice(0, hit.previewCol)}
        <mark>{hit.preview.slice(hit.previewCol, hit.previewCol + hit.length)}</mark>
        {hit.preview.slice(hit.previewCol + hit.length)}
      </span>
    );
  }
  return <span className="mono search-preview monaco-editor search-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * The command palette: one box, two jobs.
 *
 * *Jump* is what it always was — files and commands, fuzzy-matched. *Text* is
 * find in files: every match across the project grouped by file, opened at
 * its line, with replace-all one step behind a confirmation. The modes are
 * tabs, and the usual prefixes work too: `>` for commands, `/` to find text.
 */
export function CommandPalette({
  open,
  items,
  mode,
  onModeChange,
  seedQuery,
  onClose,
  onSearch,
  onOpenHit,
  onReplace,
  pathColor,
}: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // ---- text mode
  const [options, setOptions] = useState<SearchOptions>({});
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [replaced, setReplaced] = useState<{ files: number; replacements: number } | null>(null);
  /** files whose full match list is unfolded — many matches show as one row until asked */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (open) {
      setQuery(seedQuery ?? '');
      setIndex(0);
      setConfirmReplace(false);
      setReplaced(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, seedQuery]);

  /* the prefixes: `/` hands a jump query to text search, `>` is commands */
  useEffect(() => {
    if (mode === 'jump' && query.startsWith('/') && query.length > 1) {
      onModeChange('search');
      setQuery(query.slice(1));
    }
  }, [query, mode, onModeChange]);

  const results = useMemo(() => {
    if (mode !== 'jump') return [];
    const commandMode = query.startsWith('>');
    const q = commandMode ? query.slice(1).trim() : query.trim();
    const pool = commandMode ? items.filter((i) => i.kind === 'command') : items;
    if (q === '') {
      return commandMode ? pool.slice(0, 14) : pool.filter((i) => i.kind === 'command').slice(0, 6).concat(pool.filter((i) => i.kind === 'file').slice(0, 8));
    }
    return pool
      .map((item) => ({ item, score: fuzzyScore(q, item.label) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((r) => r.item);
  }, [query, items, mode]);

  /*
   * Search as you type, a beat behind the keystroke. The session answers in
   * tens of milliseconds, but a search per keystroke on a big repo still
   * stacks up; 160ms is under the point where typing feels watched.
   */
  useEffect(() => {
    if (mode !== 'search' || !open) return;
    const q = query.trim();
    if (q === '') {
      setHits([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void onSearch(q, options).then((found) => {
        setHits(found);
        setSearching(false);
        setIndex(0);
        setReplaced(null);
        setExpanded(new Set());
      });
    }, 160);
    return () => clearTimeout(timer);
  }, [query, options, mode, open, onSearch]);

  const groups = useMemo(() => groupHits(hits), [hits]);

  /*
   * What the arrow keys walk in Text mode. Every file is one row carrying
   * its first match; a file with several matches unfolds into them on
   * request, so thirty hits in one file do not bury the other files. Enter
   * on a file row opens its first match.
   */
  const rows = useMemo<SearchRow[]>(() => {
    const out: SearchRow[] = [];
    for (const group of groups) {
      out.push({ kind: 'file', group });
      if (group.hits.length > 1 && expanded.has(group.path)) {
        for (const hit of group.hits) out.push({ kind: 'hit', hit, group });
      }
    }
    return out;
  }, [groups, expanded]);
  const activeCount = mode === 'jump' ? results.length : rows.length;

  const toggleGroup = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  useEffect(() => {
    setIndex(0);
  }, [activeCount, query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-index="' + index + '"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const runReplace = async () => {
    const q = query.trim();
    if (q === '' || hits.length === 0) return;
    const paths = [...new Set(hits.map((h) => h.path))];
    const result = await onReplace(q, replacement, options, paths);
    setReplaced(result);
    setConfirmReplace(false);
    // the search runs again so the list reflects what is on disk now
    void onSearch(q, options).then(setHits);
  };

  const toggle = (key: keyof SearchOptions) => setOptions((o) => ({ ...o, [key]: !o[key] }));

  return (
    <div className="palette-backdrop" onMouseDown={onClose} data-testid="palette">
      <div className={`palette${mode === 'search' ? ' search' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-modes" role="tablist" aria-label="Palette mode">
          <button
            className={`palette-mode${mode === 'jump' ? ' active' : ''}`}
            role="tab"
            aria-selected={mode === 'jump'}
            onClick={() => {
              onModeChange('jump');
              inputRef.current?.focus();
            }}
            data-testid="palette-mode-jump"
          >
            Jump
          </button>
          <button
            className={`palette-mode${mode === 'search' ? ' active' : ''}`}
            role="tab"
            aria-selected={mode === 'search'}
            onClick={() => {
              onModeChange('search');
              inputRef.current?.focus();
            }}
            data-testid="palette-mode-search"
          >
            Text
          </button>
          <span className="spacer" />
          {mode === 'search' ? (
            <span className="palette-modes-hint">
              <button
                className={`palette-opt${options.caseSensitive ? ' on' : ''}`}
                title="Match case"
                aria-pressed={!!options.caseSensitive}
                onClick={() => toggle('caseSensitive')}
                data-testid="search-opt-case"
              >
                Aa
              </button>
              <button
                className={`palette-opt${options.wholeWord ? ' on' : ''}`}
                title="Whole word"
                aria-pressed={!!options.wholeWord}
                onClick={() => toggle('wholeWord')}
                data-testid="search-opt-word"
              >
                ab
              </button>
              <button
                className={`palette-opt${options.regex ? ' on' : ''}`}
                title="Regular expression"
                aria-pressed={!!options.regex}
                onClick={() => toggle('regex')}
                data-testid="search-opt-regex"
              >
                .*
              </button>
            </span>
          ) : (
            <span className="palette-modes-hint">
              <kbd>&gt;</kbd> commands · <kbd>/</kbd> find in files
            </span>
          )}
        </div>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={mode === 'search' ? 'find in files…' : 'jump to file…  ( >  for commands, / to find in files )'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, Math.max(activeCount - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              if (mode === 'jump' && results[index]) {
                results[index].run();
                onClose();
              } else if (mode === 'search' && rows[index]) {
                const row = rows[index];
                const hit = row.kind === 'hit' ? row.hit : row.group.hits[0];
                onOpenHit(hit.path, hit.line);
                onClose();
              }
            } else if (mode === 'search' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
              const row = rows[index];
              if (row?.kind === 'file' && row.group.hits.length > 1) {
                e.preventDefault();
                const isOpen = expanded.has(row.group.path);
                if (e.key === 'ArrowRight' && !isOpen) toggleGroup(row.group.path);
                if (e.key === 'ArrowLeft' && isOpen) toggleGroup(row.group.path);
              }
            }
          }}
          data-testid="palette-input"
        />

        {mode === 'search' && (
          <div className="palette-replace-row">
            <button
              className={`palette-opt wide${replaceOpen ? ' on' : ''}`}
              aria-expanded={replaceOpen}
              onClick={() => setReplaceOpen((v) => !v)}
              data-testid="search-replace-toggle"
            >
              {replaceOpen ? '▾' : '▸'} Replace
            </button>
            {replaceOpen && (
              <>
                <input
                  className="palette-replace"
                  placeholder="replace with…"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  data-testid="search-replace-input"
                />
                {confirmReplace ? (
                  <>
                    <span className="palette-confirm-text">
                      Replace {hits.length} in {groups.length} file{groups.length === 1 ? '' : 's'}?
                    </span>
                    <button className="btn" onClick={() => setConfirmReplace(false)}>
                      Cancel
                    </button>
                    <button className="btn danger" onClick={() => void runReplace()} data-testid="search-replace-confirm">
                      Replace all
                    </button>
                  </>
                ) : (
                  <button
                    className="btn"
                    disabled={hits.length === 0}
                    title="Replace every match listed below — a local-history snapshot is taken by the watcher as the files change"
                    onClick={() => setConfirmReplace(true)}
                    data-testid="search-replace-all"
                  >
                    Replace all…
                  </button>
                )}
              </>
            )}
            <span className="spacer" />
            <span className="palette-count" data-testid="search-count">
              {replaced
                ? `replaced ${replaced.replacements} in ${replaced.files} file${replaced.files === 1 ? '' : 's'}`
                : searching
                  ? 'searching…'
                  : query.trim() === ''
                    ? ''
                    : `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}
            </span>
          </div>
        )}

        <div className="palette-list" ref={listRef}>
          {mode === 'jump' &&
            results.map((item, i) => (
              <div
                key={item.id}
                className={`palette-item${i === index ? ' active' : ''}`}
                data-index={i}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  item.run();
                  onClose();
                }}
                data-testid={`palette-item-${item.id}`}
              >
                <span className="palette-kind">{item.kind === 'command' ? '›' : '◇'}</span>
                <span className="palette-label">{item.label}</span>
                {item.hint && <span className="palette-hint">{item.hint}</span>}
              </div>
            ))}
          {mode === 'jump' && results.length === 0 && (
            <div className="palette-empty">
              no matches — the palette jumps to code files on the graph; other files open from the
              explorer. Try <b>Text</b> to search inside files. Esc closes.
            </div>
          )}

          {mode === 'search' &&
            groups.map((group) => {
              const fileIndex = rows.findIndex((r) => r.kind === 'file' && r.group === group);
              const many = group.hits.length > 1;
              const isOpen = many && expanded.has(group.path);
              const first = group.hits[0];
              const color = pathColor?.(group.path);
              return (
                <div
                  key={group.path}
                  className={`search-group${isOpen ? ' open' : ''}`}
                  style={color ? ({ '--gc': color } as React.CSSProperties) : undefined}
                  data-testid={`search-group-${group.path}`}
                >
                  <div
                    className={`search-file${fileIndex === index ? ' active' : ''}`}
                    data-index={fileIndex}
                    title={
                      many
                        ? isOpen
                          ? 'Fold the matches'
                          : 'Unfold every match — double-click opens the first'
                        : 'Open at this line'
                    }
                    onMouseEnter={() => setIndex(fileIndex)}
                    onClick={() => {
                      if (many) toggleGroup(group.path);
                      else {
                        onOpenHit(first.path, first.line);
                        onClose();
                      }
                    }}
                    onDoubleClick={() => {
                      onOpenHit(first.path, first.line);
                      onClose();
                    }}
                    data-testid={`search-file-${group.path}`}
                  >
                    <span className="search-chevron">{many ? (isOpen ? '▾' : '▸') : ''}</span>
                    <span className="mono search-file-path">{group.path}</span>
                    <span className="search-file-count">{group.hits.length}</span>
                    {!isOpen && (
                      <span className="search-file-preview">
                        <span className="search-line">{first.line}</span>
                        <SearchPreview hit={first} />
                      </span>
                    )}
                  </div>
                  {isOpen &&
                    group.hits.map((hit) => {
                      const i = rows.findIndex((r) => r.kind === 'hit' && r.hit === hit);
                      return (
                        <div
                          key={`${hit.path}:${hit.line}:${hit.col}`}
                          className={`search-hit${i === index ? ' active' : ''}`}
                          data-index={i}
                          onMouseEnter={() => setIndex(i)}
                          onClick={() => {
                            onOpenHit(hit.path, hit.line);
                            onClose();
                          }}
                          data-testid={`search-hit-${hit.path}-${hit.line}`}
                        >
                          <span className="search-line">{hit.line}</span>
                          <SearchPreview hit={hit} />
                        </div>
                      );
                    })}
                </div>
              );
            })}
          {mode === 'search' && !searching && query.trim() !== '' && hits.length === 0 && (
            <div className="palette-empty">nothing in the project contains that</div>
          )}
          {mode === 'search' && query.trim() === '' && (
            <div className="palette-empty">
              type to search every file in the project · <kbd>Aa</kbd> case · <kbd>ab</kbd> whole word ·{' '}
              <kbd>.*</kbd> regex · <kbd>↵</kbd> opens the match at its line · <kbd>→</kbd> unfolds a file
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
