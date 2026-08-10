import { useEffect, useMemo, useRef, useState } from 'react';
import { ago, num } from '../format';
import type { ChangeBurst, VerificationState } from '../../shared/activity';
import { VERIFICATION_HINT, VERIFICATION_LABEL } from '../../shared/activity';
import type { Insights } from '../../shared/insights';
import {
  TIER_HINT,
  TIER_LABEL,
  baseSnapshotFor,
  reviewTier,
  sortForReview,
  tierSummary,
  type ReviewTier,
} from '../../shared/review';
import type { ShadowSnapshot } from '../../shared/types';
import { shortenCommand } from '../../shared/commands';
import type { ReviewInfo } from '../api';
import { UI_STATUS } from '../theme';
import { agentColor } from '../graph/lenses';

/**
 * The review cockpit.
 *
 * Reviewing an agent's change means answering three questions that a file-by-
 * file diff view cannot: what was it trying to do, did anything check it, and
 * which of these files actually deserve my attention. One card per change
 * burst, worst-first.
 */

interface Props {
  bursts: ChangeBurst[];
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
}

const VERIFY_TONE: Record<VerificationState, 'good' | 'warn' | 'crit' | 'muted'> = {
  passed: 'good',
  failed: 'crit',
  'not-run': 'crit',
  stale: 'warn',
  unknown: 'warn',
  running: 'muted',
};

const SEV_ICON = { critical: '●', warning: '⚠︎', info: 'ℹ︎' } as const;
const SEV_COLOR = { critical: UI_STATUS.critical, warning: UI_STATUS.warning, info: '#86b6ef' } as const;

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
}: Props) {
  const newest = bursts.length > 0 ? bursts[bursts.length - 1].id : null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(newest ? [newest] : []));
  const [onlyProblems, setOnlyProblems] = useState(false);

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
   * opened, any filter hiding it is lifted, and the row is scrolled to and lit
   * for a few seconds — long enough to find, not long enough to become part of
   * how the row looks.
   */
  useEffect(() => {
    if (!focusPath) return;
    const burst = [...bursts].reverse().find((b) => b.changed.includes(focusPath));
    if (burst) {
      setExpanded((prev) => (prev.has(burst.id) ? prev : new Set([...prev, burst.id])));
      if (burst.verification === 'passed' && burst.smells.length === 0) setOnlyProblems(false);
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

  const visible = onlyProblems
    ? ordered.filter((b) => b.verification !== 'passed' || b.smells.length > 0)
    : ordered;

  const unverified = bursts.filter(
    (b) => b.verification === 'not-run' || b.verification === 'stale' || b.verification === 'failed',
  ).length;
  const smellCount = bursts.reduce((a, b) => a + b.smells.length, 0);

  if (bursts.length === 0) {
    return (
      <div className="review-panel" data-testid="review-panel">
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
      <div className="review-note">
        Everything below is <b>already written to disk</b> — an agent does not wait for approval. Reviewing
        means deciding what to keep: <b>dismiss</b> clears the marker and changes nothing, <b>revert</b> puts
        the files back.
      </div>
      <div className="review-head">
        <div className="review-head-stats">
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
        <span className="spacer" />
        <label className="review-toggle" title="hide bursts that passed their checks and look clean">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
            data-testid="review-only-problems"
          />
          needs attention only
        </label>
        <button
          className="btn"
          disabled={!lastGreen}
          title={
            lastGreen
              ? `Restore every file to the last state whose tests passed (${ago(lastGreen.at)}). A snapshot is taken first, so this is undoable.`
              : 'No verified-green state has been recorded yet this session'
          }
          onClick={onBackToGreen}
          data-testid="btn-back-to-green"
        >
          « Back to last green
        </button>
      </div>

      <div className="review-list">
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
          return (
            <div key={burst.id} className={`burst tone-${tone}`} data-testid={`burst-${burst.id}`}>
              <div
                className="burst-head"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(burst.id)) next.delete(burst.id);
                    else next.add(burst.id);
                    return next;
                  })
                }
              >
                <span className="burst-caret">{open ? '▾' : '▸'}</span>
                <span className="burst-agent" style={{ color: agentColor(burst.agent) }}>
                  {burst.agent}
                </span>
                <span className="burst-files">
                  {files} file{files === 1 ? '' : 's'}
                </span>
                <span
                  className={`verify-pill ${tone}`}
                  title={VERIFICATION_HINT[burst.verification]}
                  data-testid={`verify-${burst.id}`}
                >
                  {VERIFICATION_LABEL[burst.verification]}
                </span>
                {!open &&
                  burst.smells.map((s) => (
                    <span key={s.rule} className="smell-chip" style={{ color: SEV_COLOR[s.severity] }} title={s.title}>
                      {SEV_ICON[s.severity]} {s.rule}
                    </span>
                  ))}
                {open && burst.smells.length > 0 && (
                  <span className="smell-chip" style={{ color: SEV_COLOR[burst.smells[0].severity] }}>
                    {burst.smells.length} smell{burst.smells.length === 1 ? '' : 's'}
                  </span>
                )}
                <span className="spacer" />
                <span className="burst-time">{ago(burst.endedAt)}</span>
              </div>

              {open && (
                <div className="burst-body">
                  <div className="burst-intent">
                    {burst.intent ? (
                      <>
                        <div className="intent-goal">
                          <b>Goal</b> {burst.intent.goal}
                        </div>
                        {burst.intent.ruledOut && (
                          <div className="intent-ruled">
                            <b>Ruled out</b> {burst.intent.ruledOut}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="intent-missing" title="Agents can call the record_intent MCP tool before editing">
                        No intent recorded — you are the first person to see this code, with nothing
                        explaining why it was written.
                      </div>
                    )}
                  </div>

                  <div className={`burst-evidence ${tone}`} data-testid={`evidence-${burst.id}`}>
                    <div className="evidence-title">{VERIFICATION_HINT[burst.verification]}</div>
                    {burst.checks.length > 0 && (
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
                    )}
                  </div>

                  <div className="burst-files-head">
                    <span>{tierSummary(rows.map((r) => r.tier))}</span>
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
                        ↩ Revert {files === 1 ? 'this file' : `these ${num(files)} files`}
                      </button>
                    )}
                  </div>

                  {burst.smells.length > 0 && (
                    <div className="burst-smells">
                      {burst.smells.map((smell) => (
                        <details key={smell.rule} className="smell" data-testid={`smell-${smell.rule}`}>
                          <summary>
                            <span className="smell-title" style={{ color: SEV_COLOR[smell.severity] }}>
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

                  <div className="burst-rows">
                    {rows.map((row) => (
                      <div
                        key={row.path}
                        className={`brow tier-${row.tier}${row.approved ? ' approved' : ''}${
                          focused === row.path ? ' focused' : ''
                        }`}
                        data-testid={`brow-${row.path}`}
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
                        <span className={`tier-badge ${row.tier}`} title={TIER_HINT[row.tier]}>
                          {TIER_LABEL[row.tier]}
                        </span>
                        <span className="mono brow-path">
                          {row.removed && <span className="brow-deleted">deleted </span>}
                          {row.path}
                        </span>
                        {!row.read && !row.removed && (
                          <span className="brow-unread" title="no human has opened this file since it changed">
                            unread
                          </span>
                        )}
                        <span className="brow-reasons">{row.reasons.join(' · ')}</span>
                        <span className="spacer" />
                        {!row.removed && (
                          <button
                            className="row-btn"
                            title={
                              base
                                ? 'Diff this file against its state before this change'
                                : 'Diff this file against git HEAD — nothing older was snapshotted'
                            }
                            data-testid={`brow-diff-${row.path}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenDiff(row.path, base);
                            }}
                          >
                            diff
                          </button>
                        )}
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
