import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ago, num } from '../format';
import { agentIdOf, agentLabelOf, agentNameOf, type Conflict } from '../../shared/conflicts';
import type { Decision, Question } from '../../shared/tasks';
import { BurstStrip, type BurstRange } from './BurstStrip';
import { Splitter } from './Splitter';
import type { ChangeBurst } from '../../shared/activity';
import { VERIFICATION_HINT, VERIFICATION_LABEL, VERIFY_TONE } from '../../shared/activity';
import type { Insights } from '../../shared/insights';
import {
  TIER_HINT,
  TIER_LABEL,
  baseSnapshotFor,
  groupByTier,
  reviewTier,
  sortForReview,
  tierSummary,
  type ReviewTier,
} from '../../shared/review';
import type { ShadowSnapshot } from '../../shared/types';
import { shortenCommand } from '../../shared/commands';
import type { ReviewInfo } from '../api';
import type { SessionSummary } from '../../shared/session';
import { SessionStory } from './SessionStory';
import { HintNote } from './HintNote';
import { UI_STATUS, info } from '../theme';
import { agentColor, agentShape } from '../graph/lenses';

/**
 * The review cockpit.
 *
 * Reviewing an agent's change means answering three questions that a file-by-
 * file diff view cannot: what was it trying to do, did anything check it, and
 * which of these files actually deserve my attention. One card per change
 * burst, worst-first.
 *
 * It is a map and a ledger, side by side. The map is the graph filtered to
 * what the session touched, with the selected change lit — the biggest
 * weakness of a review cockpit in a graph-first IDE was that it was a *list*,
 * so a 30-file change arrived as 30 rows with no shape. The ledger keeps the
 * detail the map cannot carry: intent, evidence, the reason each file is
 * tiered where it is.
 *
 * The ledger says each thing once. A card used to carry the intent in a box,
 * the evidence in a second box, a tier badge on every row, every reason for
 * every row and three buttons per row — a change of a dozen files was a wall
 * nobody could scan. Now the card is a head, two lines of context, one row
 * of actions and the files grouped by tier, with the tier said once as a
 * heading and the reasons cut to the one that matters, the rest a hover
 * away. The skim group folds on a big change, because it is by definition
 * the part you were going to skip.
 *
 * Both sides collapse, and the divider between them is draggable, because
 * which of the two you want is a question about the change rather than a
 * preference: a rename across forty files is all shape, and a two-line fix to
 * something load-bearing is all reasons.
 */

interface Props {
  bursts: ChangeBurst[];
  /** what each agent says it did this session — the story over the diff */
  summaries: readonly SessionSummary[];
  /** the shadow history, for working out what a burst changed things *from* */
  snapshots: readonly ShadowSnapshot[];
  insights: Insights | null;
  reviewInfo: ReviewInfo | null;
  lastGreen: { hash: string; at: number } | null;
  onSelectFile(path: string): void;
  onOpenFile(path: string): void;
  /** hash is the state before the change, or null when there is none (diff vs HEAD) */
  onOpenDiff(path: string, hash: string | null): void;
  onApprove(paths: string[]): void;
  onRevertFile(hash: string, path: string): void;
  onRevertAll(hash: string, label: string): void;
  onWalkthrough(paths: string[]): void;
  onBackToGreen(): void;
  /** a file a risky-change alert asked to be taken to */
  focusPath?: string | null;
  onFocusHandled?(): void;

  // ---- the time machine, and the map it drives ----
  /** the burst subgraph. The app owns the graph, so it renders it and we place it. */
  subgraph?: ReactNode;
  conflicts: readonly Conflict[];
  decisions: readonly Decision[];
  questions: readonly Question[];
  /** which moment is being shown; null means pinned to the newest */
  selectedBurstId: string | null;
  /** a span of the session, when one has been dragged out or handed in */
  range: BurstRange | null;
  onRange(range: BurstRange | null): void;
  /** the map shows everything up to the selected change, not just it */
  cumulative: boolean;
  /** an agent is writing right now */
  writing: boolean;
  onSelectBurst(id: string | null): void;
  onToggleCumulative(): void;
  onOpenConflict(conflict: Conflict): void;
}

type Severity = 'critical' | 'warning' | 'info';

const SEV_ICON: Record<Severity, string> = { critical: '●', warning: '⚠︎', info: 'ℹ︎' };
const SEV_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Resolved per render: a module-level hex keeps whichever theme loaded first. */
function sevColor(severity: Severity): string {
  if (severity === 'critical') return UI_STATUS.critical;
  return severity === 'warning' ? UI_STATUS.warning : info();
}

/** The worst of a burst's smells, for the one chip its head carries. */
function worstSeverity(smells: readonly { severity: Severity }[]): Severity {
  let worst: Severity = 'info';
  for (const s of smells) if (SEV_ORDER[s.severity] < SEV_ORDER[worst]) worst = s.severity;
  return worst;
}

/**
 * Above this many files the skim group starts folded. Below it the whole
 * change fits on a screen, and a fold would hide rows for nothing.
 */
const FOLD_SKIM_ABOVE = 10;

interface Row {
  path: string;
  tier: ReviewTier;
  reasons: string[];
  risk: number;
  removed: boolean;
  approved: boolean;
  read: boolean;
}

export function ReviewPanel({
  bursts,
  summaries,
  snapshots,
  insights,
  reviewInfo,
  lastGreen,
  onSelectFile,
  onOpenFile,
  onOpenDiff,
  onApprove,
  onRevertFile,
  onRevertAll,
  onWalkthrough,
  onBackToGreen,
  focusPath = null,
  onFocusHandled,
  subgraph,
  conflicts,
  decisions,
  questions,
  selectedBurstId,
  range,
  onRange,
  cumulative,
  writing,
  onSelectBurst,
  onToggleCumulative,
  onOpenConflict,
}: Props) {
  const newest = bursts.length > 0 ? bursts[bursts.length - 1].id : null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(newest ? [newest] : []));
  const [onlyProblems, setOnlyProblems] = useState(false);
  /** show only one agent's changes; null is everyone's */
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  /**
   * Tier groups whose fold has been toggled by hand, keyed `burst:tier`.
   * Only the exceptions are kept: the default is worked out per burst.
   */
  const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());

  /*
   * Which of the two halves is showing.
   *
   * Collapsing one gives the other the whole panel — the map alone is the
   * useful state often enough to be one click away, and the ledger alone is
   * exactly what this panel was before the map existed.
   */
  const [mapCollapsed, setMapCollapsed] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  /* the split survives the session: where you like the divider is a
     preference about you, not about this change */
  const [mapWidth, setMapWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('flare.review.split'));
      return stored >= 0.2 && stored <= 0.85 ? stored : 0.56;
    } catch {
      return 0.56;
    }
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const dragSplit = useCallback((clientX: number) => {
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const next = Math.min(0.85, Math.max(0.2, (clientX - box.left) / box.width));
    setMapWidth(next);
    try {
      localStorage.setItem('flare.review.split', String(next));
    } catch {
      // storage unavailable: the split still applies for this window
    }
  }, []);

  /*
   * Open the newest burst whenever one arrives, not only on mount.
   *
   * This panel is meant to be left open while an agent works. Seeding the
   * expanded set once meant that if you opened Review before the agent wrote
   * anything — the normal order — every change after that landed collapsed,
   * and the evidence the panel exists to show stayed one click away.
   */
  useEffect(() => {
    if (!newest) return;
    setExpanded((prev) => (prev.has(newest) ? prev : new Set([...prev, newest])));
  }, [newest]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  /*
   * Land on the file, not merely in the panel.
   *
   * An alert about one file that opens a tab listing forty changes has handed
   * the search back to the person who clicked it. So the burst it belongs to is
   * opened, any filter hiding it is lifted, its tier group is unfolded, and the
   * row is scrolled to and lit for a few seconds — long enough to find, not
   * long enough to become part of how the row looks.
   */
  useEffect(() => {
    if (!focusPath) return;
    const burst = [...bursts].reverse().find((b) => b.changed.includes(focusPath));
    if (burst) {
      setExpanded((prev) => (prev.has(burst.id) ? prev : new Set([...prev, burst.id])));
      if (burst.verification === 'passed' && burst.smells.length === 0) setOnlyProblems(false);
      setFoldOverrides((prev) => {
        const next = new Map(prev);
        for (const tier of ['careful', 'read', 'skim'] as const) next.set(`${burst.id}:${tier}`, true);
        return next;
      });
    }
    setFocused(focusPath);
    onFocusHandled?.();

    const frame = requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-testid="brow-${focusPath}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
    const timer = setTimeout(() => setFocused(null), 4000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [focusPath, bursts, onFocusHandled]);

  /*
   * The strip and the list are two views of one selection, so moving either
   * moves the other. Stepping the time machine to a change and then having to
   * find that change in the list underneath would make them two navigations
   * for one question.
   */
  useEffect(() => {
    if (!selectedBurstId) return;
    setExpanded((prev) => (prev.has(selectedBurstId) ? prev : new Set([...prev, selectedBurstId])));
    const frame = requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-testid="burst-${selectedBurstId}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedBurstId]);

  const metrics = useMemo(() => {
    const map = new Map<string, Insights['files'][number]>();
    for (const f of insights?.files ?? []) map.set(f.path, f);
    return map;
  }, [insights]);

  const ordered = useMemo(() => [...bursts].reverse(), [bursts]);

  const rowsFor = (burst: ChangeBurst): Row[] => {
    const approvedAt = reviewInfo?.review.approvedAt ?? {};
    const readAt = reviewInfo?.review.readAt ?? {};
    const rows: Row[] = [...burst.changed, ...burst.removed].map((path) => {
      const m = metrics.get(path);
      const { tier, reasons } = reviewTier({
        path,
        risk: m?.risk ?? 0,
        blastRadius: m?.blastRadius ?? 0,
        fanIn: m?.fanIn ?? 0,
        coveragePct: m?.coveragePct ?? null,
        testedBy: m?.testedBy ?? 0,
        complexity: m?.complexity ?? 0,
        inCycle: m?.inCycle ?? false,
        isTest: m?.isTest ?? false,
      });
      return {
        path,
        tier,
        reasons,
        risk: m?.risk ?? 0,
        removed: burst.removed.includes(path),
        approved: (approvedAt[path] ?? 0) >= burst.endedAt,
        read: (readAt[path] ?? 0) >= burst.endedAt,
      };
    });
    return sortForReview(rows);
  };

  /**
   * The session broken down by who did it.
   *
   * With one agent this is a single chip and reads as a total. With three it
   * is the answer to the question a chronological list of bursts cannot
   * answer at all: *which of them wrote what, and whose work is the unchecked
   * part.* One agent leaving every one of its changes unverified is a fact
   * about that agent, and it is invisible when its bursts are interleaved with
   * two others' down a scrolling list.
   */
  const byAgent = useMemo(() => {
    const out = new Map<
      string,
      { id: string; name: string; bursts: number; files: number; unverified: number; smells: number }
    >();
    for (const burst of bursts) {
      const id = agentIdOf(burst);
      const entry = out.get(id) ?? {
        id,
        name: agentNameOf(burst),
        bursts: 0,
        files: 0,
        unverified: 0,
        smells: 0,
      };
      entry.bursts++;
      entry.files += burst.changed.length + burst.removed.length;
      entry.smells += burst.smells.length;
      if (burst.verification !== 'passed') entry.unverified++;
      // the newest burst's name wins: an agent that identified itself late
      // should not be listed under the tool name it arrived with
      entry.name = agentNameOf(burst);
      out.set(id, entry);
    }
    return [...out.values()].sort((a, b) => b.files - a.files);
  }, [bursts]);

  const visible = ordered
    .filter((b) => !onlyProblems || b.verification !== 'passed' || b.smells.length > 0)
    .filter((b) => agentFilter === null || agentIdOf(b) === agentFilter);

  const unverified = bursts.filter(
    (b) => b.verification === 'not-run' || b.verification === 'stale' || b.verification === 'failed',
  ).length;
  const smellCount = bursts.reduce((a, b) => a + b.smells.length, 0);

  const toggleBurst = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFold = (key: string, open: boolean): void =>
    setFoldOverrides((prev) => new Map(prev).set(key, !open));

  if (bursts.length === 0) {
    return (
      <div className="review-panel" data-testid="review-panel">
        {/*
          A story with no bursts under it is still worth showing.
          An agent that summarised work Flare could not attribute to it — or
          summarised before the watcher caught up — has still said the one
          thing nothing else here can say, and hiding it behind "nothing has
          changed yet" would throw it away.
        */}
        <SessionStory
          summaries={summaries}
          bursts={bursts}
          onSelectFile={onSelectFile}
          onOpenFile={onOpenFile}
        />
        <div className="issues-empty" style={{ paddingTop: 60 }}>
          <div className="issues-empty-mark">○</div>
          Nothing has changed yet this session.
          <div className="muted" style={{ fontSize: 11, maxWidth: 460, textAlign: 'center' }}>
            As soon as you or an agent edits a file, the change lands here with what ran to check it,
            which files actually deserve your attention, and anything that looks like a shortcut.
            Edits are written straight to disk, so this is a record of what already happened — and
            the place to undo it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="review-panel" data-testid="review-panel" ref={rootRef}>
      <HintNote id="review" className="review-note">
        Everything below is <b>already written to disk</b> — an agent does not wait for approval. Reviewing
        means deciding what to keep: <b>dismiss</b> clears the marker and changes nothing, <b>revert</b> puts
        the files back.
      </HintNote>
      {/*
        The strip takes the leading position and the counts move right of the
        spacer, giving up their labels for tooltips: the three stat blocks were
        spending most of this bar's width to say what the ticks now show as a
        shape, and the bar has to hold both.
      */}
      <div className="review-head">
        <BurstStrip
          bursts={bursts}
          conflicts={conflicts}
          decisions={decisions}
          questions={questions}
          lastGreen={lastGreen}
          selectedBurstId={selectedBurstId}
          range={range}
          cumulative={cumulative}
          writing={writing}
          onSelect={onSelectBurst}
          onRange={onRange}
          onToggleCumulative={onToggleCumulative}
          onOpenConflict={onOpenConflict}
        />
        <span className="spacer" />
        <div className="review-head-stats compact">
          {/* "unverified" and "smell" are this app's words, so each count says
              what it counts rather than assuming the vocabulary */}
          <span className="rh-stat" title="Bursts of edits this session. Files written close together are grouped into one change.">
            <span className="rh-num">{bursts.length}</span>
            <span className="rh-label">change{bursts.length === 1 ? '' : 's'}</span>
          </span>
          <span
            className="rh-stat"
            title="Changes with no test run after them. Nothing proves these still work — they are where a regression survives longest."
          >
            <span className={`rh-num${unverified > 0 ? ' crit' : ' good'}`}>{unverified}</span>
            <span className="rh-label">unverified</span>
          </span>
          <span
            className="rh-stat"
            title="Patterns that make a change look better than it is: a deleted assertion, a lowered threshold, a silenced linter, a skipped test."
          >
            <span className={`rh-num${smellCount > 0 ? ' warn' : ''}`}>{smellCount}</span>
            <span className="rh-label">smell{smellCount === 1 ? '' : 's'}</span>
          </span>
        </div>
        <label className="review-toggle" title="hide bursts that passed their checks and look clean">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
            data-testid="review-only-problems"
          />
          needs attention only
        </label>
        {/*
          Who did what, when "who" is more than one.
          A single author needs no breakdown — the counts to the left already
          are its breakdown — so this appears exactly when the session stopped
          having one author and the question became worth asking.
        */}
        {byAgent.length > 1 && (
          <div className="review-agents" data-testid="review-agents">
            {byAgent.map((a) => (
              <button
                key={a.id}
                className={`review-agent${agentFilter === a.id ? ' on' : ''}`}
                style={{ '--agent': agentColor(a.id) } as React.CSSProperties}
                title={`${a.name} — ${a.bursts} change${a.bursts === 1 ? '' : 's'}, ${a.files} file${
                  a.files === 1 ? '' : 's'
                }, ${a.unverified} unverified${a.smells > 0 ? `, ${a.smells} smell${a.smells === 1 ? '' : 's'}` : ''}.\nClick to show only its changes.`}
                onClick={() => setAgentFilter((prev) => (prev === a.id ? null : a.id))}
                data-testid={`review-agent-${a.id}`}
              >
                <span className="review-agent-mark">{agentShape(a.id)}</span>
                {a.name}
                <span className="review-agent-files">{a.files}</span>
                {a.unverified > 0 && <span className="review-agent-unver">{a.unverified}✗</span>}
              </button>
            ))}
          </div>
        )}
        <button
          className="btn"
          disabled={!lastGreen}
          title={
            lastGreen
              ? `Restore every file to the last state whose tests passed (${ago(lastGreen.at)}) — the ⚑︎ on the strip. A snapshot is taken first, so this is undoable.`
              : 'No verified-green state has been recorded yet this session'
          }
          onClick={onBackToGreen}
          data-testid="btn-back-to-green"
        >
          « Back to last green
        </button>
      </div>

      <div className="review-body" ref={bodyRef} data-testid="review-body">
        {subgraph && (
          <div
            className={`review-map${mapCollapsed ? ' collapsed' : ''}`}
            data-testid="review-map"
            style={mapCollapsed || listCollapsed ? undefined : { flexBasis: `${mapWidth * 100}%` }}
          >
            <button
              className="pane-collapse"
              data-testid="review-map-collapse"
              title={mapCollapsed ? 'Show the map of this change' : 'Hide the map and give the panel to the list'}
              aria-expanded={!mapCollapsed}
              onClick={() => {
                setMapCollapsed((v) => !v);
                if (mapCollapsed) setListCollapsed(false);
              }}
            >
              {mapCollapsed ? '▸' : '▾'} map
            </button>
            {!mapCollapsed && <div className="review-map-body">{subgraph}</div>}
          </div>
        )}

        {subgraph && !mapCollapsed && !listCollapsed && (
          <Splitter direction="horizontal" onDrag={dragSplit} />
        )}

        <div className={`review-side${listCollapsed ? ' collapsed' : ''}`} data-testid="review-side">
          <button
            className="pane-collapse"
            data-testid="review-list-collapse"
            title={
              listCollapsed
                ? 'Show the change list again'
                : 'Hide the list and give the panel to the map'
            }
            aria-expanded={!listCollapsed}
            onClick={() => {
              setListCollapsed((v) => !v);
              if (listCollapsed) setMapCollapsed(false);
            }}
          >
            {listCollapsed ? '◂' : '▾'} {listCollapsed ? '' : 'changes'}
          </button>
          {!listCollapsed && (
            <div className="review-list">
              {/*
                The story first, then the changes it is about.

                Every row below is something Flare derived; this is the one thing it
                had to be told. A person opening this panel after a night of agent
                work wants the sentence before the diff — and the diff is right
                underneath, so the sentence can be checked rather than believed.
              */}
              <SessionStory
                summaries={summaries}
                bursts={bursts}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
              />
              {visible.length === 0 && (
                <div className="issues-empty">
                  <div className="issues-empty-mark">✓</div>
                  every change was verified and looks clean
                </div>
              )}
              {visible.map((burst) => {
                const rows = rowsFor(burst);
                const open = expanded.has(burst.id);
                const tone = VERIFY_TONE[burst.verification];
                /* what this burst changed things *from* — see baseSnapshotFor */
                const base = baseSnapshotFor(burst.startedAt, snapshots);
                const files = rows.length;
                const groups = groupByTier(rows);
                const smells = burst.smells.length;
                return (
                  <div key={burst.id} className={`burst tone-${tone}`} data-testid={`burst-${burst.id}`}>
                    <div className="burst-head" onClick={() => toggleBurst(burst.id)}>
                      <span className="burst-caret">{open ? '▾' : '▸'}</span>
                      {/*
                        Who, then what. The name is the part that has to survive a
                        narrow panel — with three agents on one repo, "Claude 2" is
                        what makes the row findable and "Add OAuth" is the detail
                        that explains it, so the second one is what truncates.
                      */}
                      <span className="burst-agent" style={{ color: agentColor(agentIdOf(burst)) }}>
                        {agentNameOf(burst)}
                      </span>
                      {agentLabelOf(burst) !== agentNameOf(burst) && (
                        <span className="burst-doing" title={agentLabelOf(burst)}>
                          {agentLabelOf(burst)}
                        </span>
                      )}
                      <span className="spacer" />
                      {/* one chip for all of them; the rules are named in the body */}
                      {smells > 0 && (
                        <span
                          className="smell-chip"
                          style={{ color: sevColor(worstSeverity(burst.smells)) }}
                          title={burst.smells.map((s) => s.title).join('\n')}
                        >
                          {SEV_ICON[worstSeverity(burst.smells)]} {smells} smell{smells === 1 ? '' : 's'}
                        </span>
                      )}
                      <span
                        className={`verify-pill ${tone}`}
                        title={VERIFICATION_HINT[burst.verification]}
                        data-testid={`verify-${burst.id}`}
                      >
                        {VERIFICATION_LABEL[burst.verification]}
                      </span>
                      <span className="burst-files">
                        {files} file{files === 1 ? '' : 's'}
                      </span>
                      <span className="burst-time">{ago(burst.endedAt)}</span>
                    </div>

                    {open && (
                      <div className="burst-body">
                        {/*
                          Why, and whether it was checked — two lines, not two boxes.
                          The checks themselves are there for whoever wants the
                          command and its verdict; the sentence is what a reviewer
                          needs from across the room.
                        */}
                        <div className="burst-context">
                          <div className="context-line">
                            <span className="context-cap">Goal</span>
                            {burst.intent ? (
                              <span className="context-text">{burst.intent.goal}</span>
                            ) : (
                              <span
                                className="context-text intent-missing"
                                title="Agents can call the record_intent MCP tool before editing"
                              >
                                No intent recorded — nothing says why this was written.
                              </span>
                            )}
                          </div>
                          {burst.intent?.ruledOut && (
                            <div className="context-line">
                              <span className="context-cap">Ruled out</span>
                              <span className="context-text">{burst.intent.ruledOut}</span>
                            </div>
                          )}
                          <div className={`context-line evidence ${tone}`} data-testid={`evidence-${burst.id}`}>
                            <span className="context-cap">Checked</span>
                            <span className="context-text">{VERIFICATION_HINT[burst.verification]}</span>
                          </div>
                          {burst.checks.length > 0 && (
                            <details className="checks">
                              <summary>
                                {burst.checks.length} check{burst.checks.length === 1 ? '' : 's'}
                              </summary>
                              <ul className="evidence-list">
                                {burst.checks.map((check, i) => (
                                  <li key={`${check.at}-${i}`}>
                                    <span className={`check-outcome ${check.outcome}`}>{check.outcome}</span>
                                    <span className="mono check-cmd">{shortenCommand(check.command, 70)}</span>
                                    <span className="muted">
                                      {check.at < burst.endedAt ? 'before the last edit' : ago(check.at)}
                                    </span>
                                    {check.evidence && <div className="mono check-evidence">{check.evidence}</div>}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>

                        {smells > 0 && (
                          <div className="burst-smells">
                            {burst.smells.map((smell) => (
                              <details key={smell.rule} className="smell" data-testid={`smell-${smell.rule}`}>
                                <summary>
                                  <span className="smell-title" style={{ color: sevColor(smell.severity) }}>
                                    {SEV_ICON[smell.severity]} {smell.title}
                                  </span>
                                  <span className="smell-count">
                                    {smell.paths.length} file{smell.paths.length === 1 ? '' : 's'}
                                  </span>
                                </summary>
                                <div className="smell-detail">{smell.detail}</div>
                                <div className="smell-paths">
                                  {smell.paths.slice(0, 6).map((p) => (
                                    <a key={p} className="deplink mono" onClick={() => onSelectFile(p)}>
                                      {p}
                                    </a>
                                  ))}
                                </div>
                              </details>
                            ))}
                          </div>
                        )}

                        <div className="burst-actions">
                          <span className="burst-tiers">{tierSummary(rows.map((r) => r.tier))}</span>
                          <span className="spacer" />
                          <button
                            className="btn primary"
                            onClick={() => onWalkthrough(rows.filter((r) => !r.removed).map((r) => r.path))}
                            title="Step through these files on the graph, worst-risk first"
                            data-testid={`walk-${burst.id}`}
                          >
                            ▶ Walk through
                          </button>
                          <button
                            className="btn"
                            onClick={() => onApprove(rows.map((r) => r.path))}
                            title="Stop flagging these files. Nothing on disk changes — this is bookkeeping, not approval."
                          >
                            ✓ Dismiss
                          </button>
                          {base && (
                            <button
                              className="btn danger"
                              title="Undo it: restore every file to the snapshot taken just before this burst. A snapshot is taken first, so this is itself undoable."
                              onClick={() => onRevertAll(base, `${files} file${files === 1 ? '' : 's'} by ${burst.agent}`)}
                            >
                              ↩ Revert {files === 1 ? 'this file' : `${num(files)} files`}
                            </button>
                          )}
                        </div>

                        <div className="burst-rows">
                          {groups.map((group) => {
                            const key = `${burst.id}:${group.tier}`;
                            const groupOpen =
                              foldOverrides.get(key) ??
                              !(group.tier === 'skim' && groups.length > 1 && files > FOLD_SKIM_ABOVE);
                            return (
                              <div key={group.tier} className={`brow-group ${group.tier}`}>
                                <button
                                  className="brow-group-head"
                                  aria-expanded={groupOpen}
                                  title={TIER_HINT[group.tier]}
                                  onClick={() => toggleFold(key, groupOpen)}
                                  data-testid={`brow-group-${burst.id}-${group.tier}`}
                                >
                                  <span className="brow-group-caret">{groupOpen ? '▾' : '▸'}</span>
                                  {TIER_LABEL[group.tier]}
                                  <span className="brow-group-count">{group.rows.length}</span>
                                </button>
                                {groupOpen &&
                                  group.rows.map((row) => (
                                    <div
                                      key={row.path}
                                      className={`brow tier-${row.tier}${row.approved ? ' approved' : ''}${
                                        focused === row.path ? ' focused' : ''
                                      }`}
                                      data-testid={`brow-${row.path}`}
                                      title={
                                        row.removed
                                          ? 'Deleted in this change'
                                          : 'Click to see what changed · double-click to open the file'
                                      }
                                      /*
                                       * A click on a changed file shows the change.
                                       *
                                       * It used to only move the selection, which put the
                                       * file's metrics in the details panel and left "what
                                       * actually changed here" two more clicks away — on a
                                       * row whose entire reason for existing is that
                                       * something was edited.
                                       */
                                      onClick={() => {
                                        onSelectFile(row.path);
                                        if (!row.removed) onOpenDiff(row.path, base);
                                      }}
                                      onDoubleClick={() => !row.removed && onOpenFile(row.path)}
                                    >
                                      {/* the unread mark: a dot, the way mail does it */}
                                      <span
                                        className={`brow-dot${!row.read && !row.removed ? ' unread' : ''}`}
                                        title={!row.read && !row.removed ? 'No human has opened this file since it changed' : undefined}
                                        aria-label={!row.read && !row.removed ? 'unread' : undefined}
                                      />
                                      <span className="mono brow-path">
                                        {row.removed && <span className="brow-deleted">deleted </span>}
                                        {row.path}
                                      </span>
                                      {/* the worst reason, and a count for the rest */}
                                      {row.reasons.length > 0 && (
                                        <span className="brow-why" title={row.reasons.join('\n')}>
                                          {row.reasons[0]}
                                          {row.reasons.length > 1 && (
                                            <span className="brow-more">+{row.reasons.length - 1}</span>
                                          )}
                                        </span>
                                      )}
                                      <span className="spacer" />
                                      {base && (
                                        <button
                                          className="row-btn danger"
                                          title="Undo this file: restore it to its state before the burst, leaving the rest alone"
                                          data-testid={`brow-revert-${row.path}`}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            onRevertFile(base, row.path);
                                          }}
                                        >
                                          revert
                                        </button>
                                      )}
                                      <button
                                        className="row-btn"
                                        title="Stop flagging this file. It stays exactly as it is on disk."
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onApprove([row.path]);
                                        }}
                                      >
                                        {row.approved ? '✓' : 'dismiss'}
                                      </button>
                                    </div>
                                  ))}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
