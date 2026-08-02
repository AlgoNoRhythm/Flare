import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  kind: 'file' | 'command';
  run(): void;
}

interface Props {
  open: boolean;
  items: PaletteItem[];
  onClose(): void;
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

export function CommandPalette({ open, items, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
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
  }, [query, items]);

  useEffect(() => {
    setIndex(0);
  }, [results.length, query]);

  useEffect(() => {
    const el = listRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={onClose} data-testid="palette">
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="jump to file…  ( >  for commands )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && results[index]) {
              results[index].run();
              onClose();
            }
          }}
          data-testid="palette-input"
        />
        <div className="palette-list" ref={listRef}>
          {results.map((item, i) => (
            <div
              key={item.id}
              className={`palette-item${i === index ? ' active' : ''}`}
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
          {results.length === 0 && <div className="palette-empty">no matches</div>}
        </div>
      </div>
    </div>
  );
}
