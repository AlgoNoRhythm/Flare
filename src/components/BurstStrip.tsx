import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeBurst } from '../../shared/activity';
import { VERIFICATION_LABEL, VERIFY_TONE } from '../../shared/activity';
import { agentIdOf, agentLabelOf, type Conflict } from '../../shared/conflicts';
import type { Decision, Question } from '../../shared/tasks';
import { ago } from '../format';
import { agentColor } from '../graph/lenses';

/**
 * The time machine.
 *
 * A session is a sequence of moments, and the review panel only ever showed
 * you the last one. This is the rest of them: one tick per thing that
 * happened, oldest left, `LIVE` at the right edge — the whole night in the
 * width of a toolbar.
 *
 * It is deliberately a *strip* and not a feed. A vertical list of events is
 * the obvious shape and the wrong one: it needs its own panel, it repeats what
 * the burst list underneath already says in words, and at three hundred events
 * it becomes something you scroll rather than something you read. Compressed
 * to a strip it stays glanceable — the shape of the session (who was working,
 * how much, what went red, where the crossings are) reads without a single
 * click — and every event is still reachable by hovering one.
 *
 * What it controls is the graph beside it, so this is a scrubber, not a log:
 * step a tick and the subgraph below redraws to that moment.
 *
 * Six kinds of tick, and no seventh without a good argument:
 *
 * - `▮` a change burst — its height is how many files, its colour is which
 *   agent, its tone is whether anything checked it
 * - `◆` a design decision recorded
 * - `?` a question parked
 * - `⚠︎` two agents crossing — the thing no per-file view can show
 * - `⚑︎` the last state whose checks passed, flagged on the burst it belongs to
 * - `●` LIVE, pulsing while an agent is still writing
 *
 * Stepping off LIVE is a real state: new bursts stop dragging the view along
 * while you are reading history, and a chip appears to get you back. Tailing a
 * log that jumps every time the agent saves is unreadable, and an agent saves
 * a lot.
 */

export type TickKind = 'burst' | 'decision' | 'question' | 'conflict';

export interface Tick {
  id: string;
  kind: TickKind;
  at: number;
  /** what the hover says */
  title: string;
  burst?: ChangeBurst;
  conflict?: Conflict;
  /** agent accent, when the event has an author */
  color?: string;
  /** burst only: verification tone */
  tone?: 'good' | 'warn' | 'crit' | 'muted';
  /** burst only: how many files, for the tick height */
  weight?: number;
  /** this burst is the last green one */
  green?: boolean;
}

/** A span of the session, inclusive at both ends. Order is not significant. */
export interface BurstRange {
  from: string;
  to: string;
}

interface Props {
  /** oldest first */
  bursts: readonly ChangeBurst[];
  conflicts: readonly Conflict[];
  decisions: readonly Decision[];
  questions: readonly Question[];
  lastGreen: { hash: string; at: number } | null;
  /** null means "pinned to live" */
  selectedBurstId: string | null;
  /** a span dragged across the rail, or handed in by the briefing */
  range: BurstRange | null;
  /** show every burst up to the selected one, not just it */
  cumulative: boolean;
  /** an agent is writing right now */
  writing: boolean;
  onSelect(burstId: string | null): void;
  onRange(range: BurstRange | null): void;
  onToggleCumulative(): void;
  onOpenConflict(conflict: Conflict): void;
}

/** Tick heights: enough range to see "a big change" without a bar chart. */
const TICK_MIN = 7;
const TICK_MAX = 20;

function tickHeight(files: number): number {
  // log, because one 60-file refactor should not flatten forty ordinary edits
  const scaled = Math.log2(Math.max(1, files) + 1) / Math.log2(33);
  return Math.round(TICK_MIN + Math.min(1, scaled) * (TICK_MAX - TICK_MIN));
}

export function buildTicks(input: {
  bursts: readonly ChangeBurst[];
  conflicts: readonly Conflict[];
  decisions: readonly Decision[];
  questions: readonly Question[];
  lastGreen: { hash: string; at: number } | null;
}): Tick[] {
  const { bursts, conflicts, decisions, questions, lastGreen } = input;
  const ticks: Tick[] = [];

  for (const burst of bursts) {
    const files = burst.changed.length + burst.removed.length;
    ticks.push({
      id: burst.id,
      kind: 'burst',
      at: burst.endedAt,
      burst,
      color: agentColor(agentIdOf(burst)),
      tone: VERIFY_TONE[burst.verification],
      weight: files,
      green: lastGreen !== null && burst.snapshotHash === lastGreen.hash,
      title: `${agentLabelOf(burst)} — ${files} file${files === 1 ? '' : 's'}, ${
        VERIFICATION_LABEL[burst.verification]
      } · ${ago(burst.endedAt)}`,
    });
  }

  for (const d of decisions) {
    ticks.push({
      id: `d:${d.id}`,
      kind: 'decision',
      at: d.at,
      color: agentColor(d.by),
      title: `Decision — ${d.title} (${d.status}) · ${ago(d.at)}`,
    });
  }

  for (const q of questions) {
    ticks.push({
      id: `q:${q.id}`,
      kind: 'question',
      at: q.at,
      color: agentColor(q.by),
      title: `Question — ${q.text}${q.answer ? ' (answered)' : ' (waiting on you)'} · ${ago(q.at)}`,
    });
  }

  for (const c of conflicts) {
    ticks.push({
      id: `c:${c.id}`,
      kind: 'conflict',
      at: c.at,
      conflict: c,
      title: `${c.summary} · ${ago(c.at)}`,
    });
  }

  return ticks.sort((a, b) => a.at - b.at);
}

export function BurstStrip({
  bursts,
  conflicts,
  decisions,
  questions,
  lastGreen,
  selectedBurstId,
  range,
  cumulative,
  writing,
  onSelect,
  onRange,
  onToggleCumulative,
  onOpenConflict,
}: Props) {
  const ticks = useMemo(
    () => buildTicks({ bursts, conflicts, decisions, questions, lastGreen }),
    [bursts, conflicts, decisions, questions, lastGreen],
  );

  const railRef = useRef<HTMLDivElement>(null);
  const newest = bursts[bursts.length - 1] ?? null;
  const live = selectedBurstId === null || selectedBurstId === newest?.id;
  const current = selectedBurstId ? (bursts.find((b) => b.id === selectedBurstId) ?? newest) : newest;

  const index = current ? bursts.findIndex((b) => b.id === current.id) : -1;
  const step = (delta: number): void => {
    if (bursts.length === 0) return;
    const next = Math.max(0, Math.min(bursts.length - 1, (index === -1 ? bursts.length - 1 : index) + delta));
    onSelect(next === bursts.length - 1 ? null : bursts[next].id);
  };

  /*
   * Follow the right edge, but only while pinned to live. Scrolling the strip
   * out from under someone reading a burst from four hours ago is the exact
   * failure the LIVE pin exists to prevent.
   */
  useEffect(() => {
    if (live && !range && railRef.current) {
      railRef.current.scrollLeft = railRef.current.scrollWidth;
    }
  }, [live, range, ticks.length]);

  /*
   * Dragging across the rail selects a span.
   *
   * A drag and a click are the same gesture until the pointer moves, so the
   * decision is deferred to pointer-up: end on the tick you started on and it
   * is a click, end anywhere else and it is a range. Committing on move
   * instead would make every slightly-imprecise click a one-burst range.
   *
   * The listener is on the window rather than the rail because a drag that
   * ends past the last tick — the natural way to mean "…and everything after"
   * — releases outside it.
   */
  const dragFrom = useRef<string | null>(null);
  const [dragTo, setDragTo] = useState<string | null>(null);

  useEffect(() => {
    const up = (): void => {
      const from = dragFrom.current;
      const to = dragTo;
      dragFrom.current = null;
      setDragTo(null);
      if (!from) return;
      if (!to || to === from) {
        onSelect(from === newest?.id ? null : from);
        onRange(null);
      } else {
        onRange({ from, to });
      }
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [dragTo, newest, onSelect, onRange]);

  /** Index span currently painted as selected — the live drag wins over the committed range. */
  const span = useMemo(() => {
    const active =
      dragFrom.current && dragTo ? { from: dragFrom.current, to: dragTo } : range;
    if (!active) return null;
    const a = bursts.findIndex((b) => b.id === active.from);
    const b = bursts.findIndex((b2) => b2.id === active.to);
    if (a === -1 || b === -1) return null;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }, [bursts, range, dragTo]);

  const spanCount = span ? span.hi - span.lo + 1 : 0;

  if (bursts.length === 0) return null;

  return (
    <div
      className="burst-strip"
      data-testid="burst-strip"
      role="group"
      aria-label="Session history"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          step(1);
        }
      }}
    >
      <button
        className="bs-step"
        data-testid="bs-prev"
        title="The change before this one — or ← with the strip focused"
        disabled={index <= 0}
        onClick={() => step(-1)}
      >
        ◀
      </button>

      <div className="bs-rail" ref={railRef} tabIndex={0}>
        {ticks.map((tick) => {
          const index = tick.kind === 'burst' ? bursts.findIndex((b) => b.id === tick.id) : -1;
          const inSpan = span !== null && index >= span.lo && index <= span.hi;
          const selected = tick.kind === 'burst' && !span && current?.id === tick.id;
          if (tick.kind === 'burst') {
            return (
              <button
                key={tick.id}
                className={`bs-tick tone-${tick.tone}${selected ? ' selected' : ''}${
                  inSpan ? ' in-span' : ''
                }${tick.green ? ' green' : ''}`}
                data-testid={`bs-tick-${tick.id}`}
                title={tick.title}
                aria-label={tick.title}
                aria-current={selected}
                onPointerDown={(e) => {
                  e.preventDefault();
                  dragFrom.current = tick.id;
                  setDragTo(tick.id);
                }}
                onPointerEnter={() => {
                  if (dragFrom.current) setDragTo(tick.id);
                }}
              >
                <span
                  className="bs-bar"
                  style={{ height: tickHeight(tick.weight ?? 1), background: tick.color }}
                />
                {tick.green && (
                  <span className="bs-flag" title="the last state whose checks passed">
                    ⚑︎
                  </span>
                )}
              </button>
            );
          }
          const glyph = tick.kind === 'decision' ? '◆' : tick.kind === 'question' ? '?' : '⚠︎';
          return (
            <button
              key={tick.id}
              className={`bs-mark bs-${tick.kind}`}
              data-testid={`bs-tick-${tick.id}`}
              title={tick.title}
              aria-label={tick.title}
              style={tick.color ? { color: tick.color } : undefined}
              onClick={() => {
                if (tick.conflict) onOpenConflict(tick.conflict);
              }}
            >
              {glyph}
            </button>
          );
        })}
        <span className={`bs-live${writing ? ' writing' : ''}`} title="now">
          ●
        </span>
      </div>

      <button
        className="bs-step"
        data-testid="bs-next"
        title="The change after this one — or → with the strip focused"
        disabled={index === -1 || index >= bursts.length - 1}
        onClick={() => step(1)}
      >
        ▶
      </button>

      {/*
        A span says how much of the session it covers and gets out of the way;
        a single change says who made it and when. Both answer "what am I
        looking at", which is the one thing a scrubber has to keep saying.
      */}
      <div className="bs-now" data-testid="bs-now">
        {span ? (
          <button
            className="bs-span"
            data-testid="bs-span"
            title="Showing a span of the session — click to go back to one change at a time"
            onClick={() => onRange(null)}
          >
            {spanCount} change{spanCount === 1 ? '' : 's'} · {ago(bursts[span.lo].startedAt)} →{' '}
            {ago(bursts[span.hi].endedAt)} ✕
          </button>
        ) : (
          current && (
            <>
              <span className="bs-agent" style={{ color: agentColor(agentIdOf(current)) }}>
                {agentLabelOf(current)}
              </span>
              <span className="bs-when">{ago(current.endedAt)}</span>
            </>
          )
        )}
      </div>

      <button
        className={`bs-toggle${cumulative ? ' on' : ''}`}
        data-testid="bs-cumulative"
        title={
          cumulative
            ? 'Showing every file touched up to this point. Click for just this change.'
            : 'Showing the files this change touched. Click for everything up to this point.'
        }
        onClick={onToggleCumulative}
      >
        Σ
      </button>

      {!live && (
        <button
          className="bs-return"
          data-testid="bs-return-live"
          title="Follow the newest change again"
          onClick={() => onSelect(null)}
        >
          Return to live ▸
        </button>
      )}
    </div>
  );
}
