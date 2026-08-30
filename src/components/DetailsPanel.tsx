import { useEffect, useState } from 'react';
import type { GitFileState, NodeDetails, ShadowSnapshot } from '../../shared/types';
import type { Insights } from '../../shared/insights';
import type { FileCoverage } from '../../shared/coverage';
import type { ReviewInfo } from '../api';
import { api } from '../api';
import { UI_STATUS } from '../theme';
import { agentColor } from '../graph/lenses';
import { band, num, plural, rankNote, scoreLabel } from '../format';

interface Props {
  nodeId: string;
  gitState: GitFileState | undefined;
  reviewInfo: ReviewInfo | null;
  changedAt: Record<string, number>;
  changedBy: Record<string, string>;
  churn: Record<string, number>;
  coverage: FileCoverage | null;
  /** the same metrics the Insights tab shows, so both agree on what "risk" is */
  insights: Insights | null;
  /** bump to refetch (graph patched / snapshots taken) */
  refreshKey: number;
  isExpanded: boolean;
  onOpenFile(path: string, line?: number): void;
  onOpenDiff(path: string, source: 'head' | { hash: string }): void;
  onSelect(path: string): void;
  onApprove(path: string): void;
  /** file a board task about these paths */
  onNewTask(paths: string[]): void;
  onExpandSymbols(path: string): void;
  onCollapseSymbols(path: string): void;
  onRestored(): void;
}

export function DetailsPanel({
  nodeId,
  gitState,
  reviewInfo,
  changedAt,
  changedBy,
  churn,
  coverage,
  insights,
  refreshKey,
  isExpanded,
  onOpenFile,
  onOpenDiff,
  onSelect,
  onApprove,
  onNewTask,
  onExpandSymbols,
  onCollapseSymbols,
  onRestored,
}: Props) {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [history, setHistory] = useState<ShadowSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.nodeDetails(nodeId).then((d) => {
      if (!cancelled) setDetails(d);
    });
    void api.shadowTimeline(200).then((snaps) => {
      if (!cancelled) setHistory(snaps.filter((s) => s.files.includes(nodeId)).slice(0, 12));
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, refreshKey]);

  const changed = changedAt[nodeId];
  const approvedAt = reviewInfo?.review.approvedAt[nodeId] ?? 0;
  const checkpointAt = reviewInfo?.review.checkpointAt ?? 0;
  const unreviewed = Boolean(changed && changed > Math.max(approvedAt, checkpointAt));
  const lastAgent = changedBy[nodeId];
  const node = details?.node;
  // Risk used to be a raw unbounded score here and a 0–100 composite in the
  // Insights tab — two different numbers, both called "risk", for one file.
  // This panel now reads the same metrics row the table does.
  const metrics = insights?.files.find((m) => m.path === nodeId) ?? null;
  const complexities = insights?.files.map((m) => m.complexity) ?? [];
  const cxNote = node && complexities.length > 0 ? rankNote(complexities, node.complexity) : null;
  const covColor =
    coverage === null ? undefined : coverage.pct >= 70 ? UI_STATUS.good : coverage.pct >= 40 ? UI_STATUS.warning : UI_STATUS.critical;

  return (
    <div data-testid="details-panel">
      <h3 className="mono">{nodeId}</h3>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {gitState && (
          <span className="pill" style={{ borderColor: UI_STATUS.warning, color: UI_STATUS.warning }}>
            git: {gitState}
          </span>
        )}
        {unreviewed ? (
          <span className="pill" style={{ borderColor: UI_STATUS.warning, color: UI_STATUS.warning }}>
            ⚠︎ unreviewed change
          </span>
        ) : changed ? (
          <span className="pill" style={{ borderColor: UI_STATUS.good, color: UI_STATUS.good }}>
            ✓ reviewed
          </span>
        ) : null}
        {changed && lastAgent && (
          <span
            className="pill"
            data-testid="changed-by"
            style={{ borderColor: agentColor(lastAgent), color: agentColor(lastAgent) }}
          >
            ● {lastAgent}
          </span>
        )}
        {node?.cycleId !== null && node?.cycleId !== undefined && (
          <span className="pill" style={{ borderColor: UI_STATUS.critical, color: UI_STATUS.critical }}>
            ∞ in import cycle
          </span>
        )}
        {node?.orphan && (
          <span className="pill" style={{ borderColor: UI_STATUS.serious, color: UI_STATUS.serious }}>
            ⚠︎ orphan (nothing imports it)
          </span>
        )}
      </div>

      {node && (
        <div className="kv">
          <span className="k">lines</span>
          <span>{num(node.loc)}</span>
          <span className="k" title="Cyclomatic complexity: the number of branches through this file. There is no absolute good value, so it is shown against the rest of this repo.">
            complexity
          </span>
          <span>
            {num(node.complexity)}
            {cxNote && <span className="note"> · {cxNote}</span>}
          </span>
          <span className="k">churn</span>
          <span>{plural(churn[nodeId] ?? 0, 'commit')}</span>
          <span className="k">imports</span>
          <span>
            {node.outDegree} internal · {node.externalModules.length} external
          </span>
          <span className="k">imported by</span>
          <span>{plural(node.inDegree, 'file')}</span>
          <span className="k">tested by</span>
          <span style={{ color: node.isTest ? undefined : node.testedBy > 0 ? UI_STATUS.good : UI_STATUS.critical }}>
            {node.isTest ? '(is a test)' : `${node.testedBy} test file${node.testedBy === 1 ? '' : 's'}`}
          </span>
          {coverage !== null && (
            <>
              <span className="k">coverage</span>
              <span style={{ color: covColor }} data-testid="coverage-row">
                {coverage.pct}% ({coverage.hit}/{coverage.found} lines)
              </span>
            </>
          )}
          <span className="k">blast radius</span>
          <span
            style={{
              color:
                details!.blastRadius > 10
                  ? UI_STATUS.critical
                  : details!.blastRadius > 3
                    ? UI_STATUS.warning
                    : undefined,
            }}
            data-testid="blast-radius"
          >
            {details!.blastRadius} file{details!.blastRadius === 1 ? '' : 's'} downstream
          </span>
          <span
            className="k"
            title="Regression risk, 0–100 within this repo: dependents × complexity × missing tests × cycles. The same score the Insights table sorts by."
          >
            review risk
          </span>
          {metrics ? (
            <span data-testid="risk-score" className={`score-read ${band(metrics.risk)}`}>
              {scoreLabel(metrics.risk)}
              {/* the same number as a length — a 0–100 score reads faster as
                  how much of the bar it fills. currentColor keeps the band. */}
              <span className="meter" aria-hidden="true">
                <i style={{ width: `${metrics.risk}%` }} />
              </span>
            </span>
          ) : (
            <span data-testid="risk-score" className="note">
              computing…
            </span>
          )}
          {metrics && metrics.reuse !== null && (
            <>
              <span
                className="k"
                title="How cleanly this file could be lifted out and reused, 0–100. Absolute, not a ranking within this repo: 100 means self-contained logic, low means it is tied to the disk, a framework, or the rest of the project."
              >
                reuse
              </span>
              <span data-testid="reuse-score">
                <span className={`score-read ${band(100 - metrics.reuse)}`}>{metrics.reuse}/100</span>
                {metrics.reuseBlockers.length > 0 ? (
                  <span className="note"> · bound to {metrics.reuseBlockers.slice(0, 3).join(', ')}</span>
                ) : metrics.drag > 0 ? (
                  <span className="note"> · drags {plural(metrics.drag, 'file')} along</span>
                ) : (
                  <span className="note"> · self-contained</span>
                )}
                {/* under the whole line, so the note stays beside its number */}
                <span className={`meter score-read ${band(100 - metrics.reuse)}`} aria-hidden="true">
                  <i style={{ width: `${metrics.reuse}%` }} />
                </span>
              </span>
            </>
          )}
        </div>
      )}

      <div className="actions">
        <button className="btn primary" onClick={() => onOpenFile(nodeId)}>
          Open
        </button>
        <button className="btn" onClick={() => onOpenDiff(nodeId, 'head')} data-testid="btn-diff-head">
          Diff vs HEAD
        </button>
        {/* the same action the bulk bar offers for a box-selection, so
            "start work on this" is reachable however you got here */}
        <button
          className="btn"
          title="File a task on the board about this file, with what the graph knows about it attached"
          onClick={() => onNewTask([nodeId])}
          data-testid="btn-new-task"
        >
          New task
        </button>
        {isExpanded ? (
          <button className="btn" onClick={() => onCollapseSymbols(nodeId)} data-testid="btn-collapse-symbols">
            Collapse symbols
          </button>
        ) : (
          <button className="btn" onClick={() => onExpandSymbols(nodeId)} data-testid="btn-expand-symbols">
            Expand symbols
          </button>
        )}
        {unreviewed && (
          <button
            className="btn warn"
            title="Clear this file's marker. The change is already on disk — dismissing only stops flagging it."
            onClick={() => onApprove(nodeId)}
            data-testid="btn-approve"
          >
            Dismiss marker
          </button>
        )}
      </div>

      {/*
        Two of the four sections fold behind their counts, so the panel opens
        at roughly one screenful. What stays open is what a click on a node is
        usually *for*: who imports this. Symbols and the outbound imports are
        the reference material — the count says whether they are worth opening.
      */}
      {node && node.symbols.length > 0 && (
        <details className="section">
          <summary>
            <h4>Symbols ({node.symbols.length})</h4>
          </summary>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {node.symbols.slice(0, 20).map((s) => (
              <span
                key={s.name}
                className="pill mono clickable"
                title={`${s.kind}${s.exported ? ' · exported' : ''} · line ${s.line}`}
                onClick={() => onOpenFile(nodeId, s.line)}
              >
                {s.name}
              </span>
            ))}
          </div>
        </details>
      )}

      {details && (
        <>
          <div className="section">
            <h4>Imported by ({details.dependents.length})</h4>
            {details.dependents.slice(0, 20).map((d) => (
              <a key={d} className="deplink mono" onClick={() => onSelect(d)}>
                {d}
              </a>
            ))}
          </div>
          <details className="section">
            <summary>
              <h4>Imports ({details.dependencies.length})</h4>
            </summary>
            {details.dependencies.slice(0, 20).map((d) => (
              <a key={d} className="deplink mono" onClick={() => onSelect(d)}>
                {d}
              </a>
            ))}
          </details>
        </>
      )}

      <div className="section">
        <h4>Local history</h4>
        {history.length === 0 && <span className="muted">no snapshots touch this file yet</span>}
        {history.map((snap) => (
          <div key={snap.hash} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
              {new Date(snap.time).toLocaleTimeString()}
            </span>
            <a className="deplink" onClick={() => onOpenDiff(nodeId, { hash: snap.hash })}>
              diff
            </a>
            <a
              className="deplink"
              style={{ color: UI_STATUS.serious }}
              onClick={() => {
                void api.shadowRestoreFile(snap.hash, nodeId).then(() => onRestored());
              }}
            >
              revert to this
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
