import { useEffect, useRef, type ReactNode } from 'react';
import type { Briefing as BriefingData, BriefingRow } from '../../shared/briefing';
import { spanLabel } from '../../shared/briefing';
import { plural } from '../format';

/**
 * The morning after.
 *
 * Not a tab and not a modal — the state the graph is in when you arrive to
 * find that four agents worked all night. It covers everything, because the
 * one thing it has to do is be read, and a card in a corner competing with a
 * toolbar is a card you dismiss by reflex.
 *
 * Three rules it lives or dies by:
 *
 * - **It does not animate in.** It is already there when the window paints.
 *   Anything that slides in reads as a notification, and notifications get
 *   swatted before they are read.
 * - **It dissolves into the graph rather than closing.** Dismissing leaves you
 *   on the map with the Activity lens on and the night's files selected — the
 *   briefing was a caption on that map, not a room you were in.
 * - **It is reachable only by arriving.** There is no button that opens it. An
 *   inbox you can visit and find empty stops being read.
 *
 * The counts are prose, deliberately. As a row of stat tiles the eye reads the
 * tiles, the rows stop being the point, and this becomes the dashboard it is
 * supposed to replace.
 */

interface Props {
  data: BriefingData;
  /** rendered under the counts: the day and time you were last here */
  sinceLabel: string;
  /**
   * The night as a picture: the graph, filtered to what the agents touched.
   *
   * The same subgraph the review panel puts beside its list, and passed in the
   * same way — the app owns the graph, so it renders it and this places it.
   * It earns its space by answering the one question the rows cannot: whether
   * the night landed in one corner of the repo or right across it.
   */
  subgraph?: ReactNode;
  onWalkthrough(): void;
  onOpenRow(row: BriefingRow): void;
  onDismiss(): void;
  /** stop raising this on arrival, from now on and in every project */
  onDisable(): void;
}

const ROW_MARK: Record<BriefingRow['kind'], string> = {
  conflict: '⚠︎',
  question: '?',
  clear: '✓',
};

export function Briefing({ data, sinceLabel, subgraph, onWalkthrough, onOpenRow, onDismiss, onDisable }: Props) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Focus the way out, not the first row.
   *
   * Whatever else this is, it is between someone and their editor. The first
   * key they press should end it, and Esc should too.
   */
  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const counts = [
    `${plural(data.files, 'file')} changed`,
    data.decisions > 0 ? plural(data.decisions, 'decision') : '',
    data.conflicts > 0 ? `${plural(data.conflicts, 'crossing')}` : '',
  ].filter(Boolean);

  return (
    <div className="briefing" data-testid="briefing" role="dialog" aria-modal="true" aria-label="While you were away">
      <div className={`briefing-sheet${subgraph ? ' with-map' : ''}`}>
        <div className="briefing-head">
          <h1 className="briefing-title">
            {data.agents === 1 ? 'An agent worked' : `${data.agents} agents worked`} for {spanLabel(data.workedMs)}.
          </h1>
          <div className="briefing-since" title="the last time this project was open in front of you">
            since {sinceLabel}
          </div>
        </div>

        <p className="briefing-counts">
          {counts.join(' · ')}
          {data.needsYou > 0 ? (
            <>
              {' · '}
              <b>{plural(data.needsYou, 'thing')} need{data.needsYou === 1 ? 's' : ''} you</b>
            </>
          ) : (
            <> · nothing needs you</>
          )}
        </p>

        {subgraph && (
          <div className="briefing-map" data-testid="briefing-map">
            {subgraph}
          </div>
        )}

        <div className="briefing-rows">
          {data.rows.map((row) => {
            const actionable = row.kind !== 'clear';
            return (
              <button
                key={row.id}
                className={`briefing-row ${row.kind}`}
                data-testid={`briefing-row-${row.id}`}
                disabled={!actionable}
                title={actionable ? 'Open this on the map' : undefined}
                onClick={() => actionable && onOpenRow(row)}
              >
                <span className="briefing-mark" aria-hidden="true">
                  {ROW_MARK[row.kind]}
                </span>
                <span className="briefing-text">
                  <span className="briefing-headline">{row.text}</span>
                  {row.detail && <span className="briefing-detail">{row.detail}</span>}
                </span>
              </button>
            );
          })}
          {data.needsYou > data.rows.filter((r) => r.kind !== 'clear').length && (
            <div className="briefing-more">
              {data.needsYou - data.rows.filter((r) => r.kind !== 'clear').length} more in the review panel
            </div>
          )}
        </div>

        <div className="briefing-foot">
          <button
            className="btn primary"
            ref={primaryRef}
            data-testid="briefing-walk"
            title="Open the review panel with the whole night selected on the strip, worst first"
            onClick={onWalkthrough}
          >
            Walk me through it
          </button>
          <button className="briefing-skip" data-testid="briefing-skip" onClick={onDismiss}>
            Skip →
          </button>
          {/*
            The off switch, on the thing itself.
            Far right and quiet, because it is the rarest of the three
            answers — but it is here rather than only in the View menu, since
            the moment someone decides they do not want this is the moment it
            is covering their screen, not a moment they go looking through
            menus for.
          */}
          <button
            className="briefing-mute"
            data-testid="briefing-mute"
            title="Never raise this on arrival again. View ▸ While You Were Away turns it back on."
            onClick={onDisable}
          >
            Don't show this again
          </button>
        </div>
      </div>
    </div>
  );
}
