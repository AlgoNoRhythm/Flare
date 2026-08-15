import { LENSES, lensHue, ramp, type Lens } from '../graph/lenses';

interface Props {
  lens: Lens;
  /** set when the active lens has nothing to colour — shown instead of the scale */
  emptyNote?: string | null;
  /** directory chips — always available, they double as fold/unfold controls */
  clusters: { name: string; color: string; count: number; collapsed: boolean }[];
  onToggleDir(dir: string): void;
  onFoldAll(): void;
  onUnfoldAll(): void;
  /** the folder chips are put away — the summary and the toggle stay */
  collapsed: boolean;
  onToggleCollapsed(): void;
}

const RAMP_STOPS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Tells the user what the current colours mean, and gives every folder a chip
 * that folds it into a single card or opens it again. Without the first, the
 * lens buttons are just eight ways to make the graph a different colour;
 * without the second there is no way back from a folder you unfolded, since
 * its card is gone by then.
 */
export function LensLegend({
  lens,
  emptyNote,
  clusters,
  onToggleDir,
  onFoldAll,
  onUnfoldAll,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const def = LENSES.find((l) => l.id === lens) ?? LENSES[0];
  const foldable = clusters.filter((c) => c.name !== '(root)' && c.count >= 2);
  const folded = foldable.filter((c) => c.collapsed).length;

  return (
    <>
      <div className={`lens-reading${emptyNote ? ' quiet' : ''}`} data-testid="lens-reading">
        <span className="lens-reading-name">{def.label}</span>
        <span className="lens-reading-text">{emptyNote ?? def.reading}</span>
        {!emptyNote && def.scale.kind === 'ramp' && (
          <span className="lens-scale" data-testid="lens-scale">
            <span className="lens-scale-end">{def.scale.low}</span>
            <span className="lens-ramp">
              {RAMP_STOPS.map((stop) => (
                <span key={stop} style={{ background: ramp(lensHue(def.id), stop) }} />
              ))}
            </span>
            <span className="lens-scale-end">{def.scale.high}</span>
          </span>
        )}
        {!emptyNote && def.scale.kind === 'swatches' && (
          <span className="lens-scale" data-testid="lens-scale">
            {def.scale.items.map((item) => (
              <span key={item.label} className="lens-swatch">
                <span className="swatch" style={{ background: item.color() }} />
                {item.label}
              </span>
            ))}
          </span>
        )}
      </div>

      {clusters.length > 0 && (
        <div className={`legend${collapsed ? ' folded-away' : ''}`} data-testid="legend">
          {/*
            A repo with thirty top-level folders puts thirty chips across the
            top of the graph, which is a lot of chrome above the thing you came
            to look at. The summary stays either way, so nothing is lost by
            putting the rest away.
          */}
          <button
            className="legend-collapse"
            aria-expanded={!collapsed}
            title={collapsed ? 'Show the folder chips' : 'Hide the folder chips'}
            onClick={onToggleCollapsed}
            data-testid="legend-collapse"
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <span className="legend-label" title="each chip folds its folder into a single card, or unfolds it again">
            Folders
            {foldable.length > 0 && (
              <span className="legend-count">
                {folded}/{foldable.length} folded
              </span>
            )}
          </span>
          {!collapsed && foldable.length > 0 && (
            <span className="legend-actions">
              <button
                className="legend-act"
                title="Fold every folder into a single card — the fastest way out of a hairball"
                onClick={onFoldAll}
                disabled={folded === foldable.length}
                data-testid="legend-fold-all"
              >
                ▣ Fold all
              </button>
              <button
                className="legend-act"
                title="Unfold every folder so each file gets its own card"
                onClick={onUnfoldAll}
                disabled={folded === 0}
                data-testid="legend-unfold-all"
              >
                ▢ Unfold all
              </button>
            </span>
          )}
          {!collapsed &&
            clusters.map((c) => (
              <button
                key={c.name}
                className={`item clickable${c.collapsed ? ' collapsed' : ''}`}
                title={
                  c.collapsed
                    ? `${c.name}/ — ${c.count} files, folded into one card. Click to unfold.`
                    : `${c.name}/ — ${c.count} files. Click to fold into one card.`
                }
                onClick={() => onToggleDir(c.name)}
                data-testid={`legend-${c.name}`}
              >
                <span className="swatch" style={{ background: c.color }} />
                {c.collapsed ? '▣ ' : '▾ '}
                {c.name} ({c.count})
              </button>
            ))}
        </div>
      )}
    </>
  );
}
