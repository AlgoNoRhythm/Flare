import { useMemo, useState } from 'react';
import type { FileMetrics, Insights, Issue, IssueSeverity } from '../../shared/insights';
import { formatPathsTree } from '../../shared/pathFormat';
import { INK, UI_STATUS, info } from '../theme';
import { agentColor } from '../graph/lenses';
import { api } from '../api';
import { toast } from './Toasts';
import { num, plural, scoreLabel } from '../format';

/**
 * Resolved per render, not at import.
 *
 * A module-level map of hexes is read once, when the bundle loads, and then
 * keeps the palette it was built with — which is invisible until the day the
 * theme can change underneath it.
 */
function sevColor(severity: IssueSeverity): string {
  if (severity === 'critical') return UI_STATUS.critical;
  return severity === 'warning' ? UI_STATUS.warning : info();
}

const SEV_ICON: Record<IssueSeverity, string> = { critical: '●', warning: '⚠︎', info: 'ℹ︎' };

type SortKey =
  | 'risk'
  | 'hotspot'
  | 'refactor'
  | 'complexity'
  | 'loc'
  | 'churn'
  | 'fanIn'
  | 'blastRadius'
  | 'coveragePct'
  | 'reuse'
  | 'todos'
  | 'path';

interface Props {
  insights: Insights | null;
  onSelectFile(path: string): void;
  onOpenFile(path: string): void;
}

/** Column definitions — the header tooltip is the only documentation there is. */
const COLUMNS: { key: SortKey; label: string; help: string; bar?: boolean; numeric?: boolean }[] = [
  { key: 'path', label: 'File', help: 'Click a row to select it on the graph, double-click to open it' },
  {
    key: 'risk',
    label: 'Risk',
    help: 'Regression risk 0–100: how much breaks if this file changes (dependents × complexity × missing tests × cycles)',
    bar: true,
  },
  {
    key: 'hotspot',
    label: 'Hotspot',
    help: 'Churn × complexity 0–100: rewritten often AND hard to change — the classic refactor signal',
    bar: true,
  },
  {
    key: 'refactor',
    label: 'Refactor',
    help: 'Refactor priority 0–100: size, complexity density and how many files depend on it',
    bar: true,
  },
  {
    key: 'complexity',
    label: 'Complexity',
    help: 'Cyclomatic complexity: how many independent branches run through this file — every if, &&, case, catch, ternary and loop adds one. A proxy for how many paths you have to hold in your head to change it safely.',
    bar: true,
  },
  { key: 'loc', label: 'Size', help: 'Lines of code', bar: true },
  { key: 'churn', label: 'Churn', help: 'Git commits touching this file, plus 3× rewrites this session', bar: true },
  { key: 'fanIn', label: 'Importers', help: 'How many files import this one directly', bar: true },
  { key: 'blastRadius', label: 'Blast', help: 'How many files break transitively if this one breaks', bar: true },
  {
    key: 'coveragePct',
    label: 'Cover',
    help: 'Line coverage from lcov.info — “~” means a test imports it but no lcov data. The one column that is not relative to this repo: 80% is 80% whether or not everything else is worse.',
    numeric: true,
  },
  {
    key: 'reuse',
    label: 'Reuse',
    help: 'How cleanly this file could be lifted out and reused, 0–100: 100 is self-contained logic, low means welded to the disk, a framework, or the rest of the repo. Absolute, like coverage — not a ranking within this project. “·” means there is too little in the file to ask.',
    numeric: true,
  },
  { key: 'todos', label: 'TODO', help: 'TODO / FIXME / HACK comments left in the file', bar: true },
];

function covColor(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  return pct >= 70 ? UI_STATUS.good : pct >= 40 ? UI_STATUS.warning : UI_STATUS.critical;
}

/**
 * Reuse reads the opposite way to the other scores: high is good.
 *
 * So it is coloured like coverage rather than like risk — otherwise the one
 * column where 100 is a compliment would be lit up in the same red that means
 * "look at this" everywhere else in the table.
 */
function reuseColor(value: number | null): string | undefined {
  if (value === null) return undefined;
  return value >= 70 ? UI_STATUS.good : value >= 40 ? UI_STATUS.warning : UI_STATUS.critical;
}

/*
 * Colour is reserved for the top band. At the old >=40 threshold most of the
 * table qualified as "warning", and 169 rows × 7 columns of amber is not a
 * warning, it is wallpaper — the bars alone carry the ranking below that.
 */
function scoreColor(value: number): string {
  return value >= 70 ? UI_STATUS.critical : value >= 55 ? UI_STATUS.warning : INK.muted;
}

function Tile({
  value,
  label,
  sub,
  tone,
  title,
}: {
  value: string | number;
  label: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'crit';
  title: string;
}) {
  return (
    <div className={`stat-tile${tone ? ` ${tone}` : ''}`} title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function InsightsPanel({ insights, onSelectFile, onOpenFile }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('risk');
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [ruleFilter, setRuleFilter] = useState<string | null>(null);
  const [sevFilter, setSevFilter] = useState<IssueSeverity | null>(null);

  const rows = useMemo(() => {
    if (!insights) return [];
    const q = filter.trim().toLowerCase();
    const filtered = q ? insights.files.filter((f) => f.path.toLowerCase().includes(q)) : insights.files;
    const value = (f: FileMetrics): number | string => {
      switch (sortKey) {
        case 'churn':
          return f.churnGit + f.churnSession * 3;
        case 'coveragePct':
          return f.coveragePct ?? -1;
        case 'reuse':
          // unscored files sort with the unliftable rather than the pristine
          return f.reuse ?? -1;
        case 'path':
          return f.path;
        default:
          return f[sortKey];
      }
    };
    return [...filtered].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortAsc ? cmp : -cmp;
    });
  }, [insights, sortKey, sortAsc, filter]);

  const issues = useMemo(() => {
    if (!insights) return [];
    return insights.issues.filter(
      (i) => (!ruleFilter || i.rule === ruleFilter) && (!sevFilter || i.severity === sevFilter),
    );
  }, [insights, ruleFilter, sevFilter]);

  if (!insights) {
    return <div className="empty-state">computing insights…</div>;
  }
  const s = insights.summary;
  const infos = insights.issues.length - s.criticals - s.warnings;

  const header = (col: (typeof COLUMNS)[number]) => (
    <th
      key={col.key}
      title={`${col.help}\n(click to sort)`}
      className={`${sortKey === col.key ? 'sorted' : ''}${col.key === 'path' ? '' : ' num'}`}
      onClick={() => {
        if (sortKey === col.key) setSortAsc(!sortAsc);
        else {
          setSortKey(col.key);
          setSortAsc(col.key === 'path');
        }
      }}
    >
      {col.label}
      {col.bar && <span className="col-scale">/100</span>}
      <span className="sort-caret">{sortKey === col.key ? (sortAsc ? '▲' : '▼') : ''}</span>
    </th>
  );

  /**
   * A metric cell on the shared 0–100 scale, underlined by a bar so a column
   * scans instantly. `raw` is the number the score came from: it stays in the
   * tooltip always, and replaces the score when the reader asks for raw
   * values, because "720 lines" is a fact and "62/100" is a comparison.
   */
  const score = (value: number, label: string, raw?: string) => (
    <td
      className="num score"
      title={
        raw === undefined
          ? `${label}: ${scoreLabel(value)} — relative to the rest of this repo, where 100 is its worst file`
          : `${label}: ${raw} — ${scoreLabel(value)} relative to the rest of this repo, where 100 is its highest`
      }
      style={{ '--v': value, '--c': scoreColor(value) } as React.CSSProperties}
    >
      <span style={{ color: value >= 55 ? scoreColor(value) : undefined }}>
        {showRaw && raw !== undefined ? raw : value}
      </span>
    </td>
  );

  const copyIssuePaths = (issue: Issue) => {
    const text = formatPathsTree(issue.paths);
    void api.clipboardWrite(text);
    toast(`${issue.paths.length} path${issue.paths.length === 1 ? '' : 's'} copied for your agent`, 'success');
  };

  return (
    <div className="insights" data-testid="insights-panel">
      <div className="insights-summary" data-testid="insights-summary">
        <Tile
          value={s.files}
          label="files"
          sub={`${num(s.loc)} lines of code`}
          title="Code files in the dependency graph, and their total line count"
        />
        <Tile
          value={s.avgCoverage === null ? '—' : `${s.avgCoverage}%`}
          label="coverage"
          sub={s.avgCoverage === null ? 'no lcov.info' : 'lines executed'}
          tone={s.avgCoverage === null ? undefined : s.avgCoverage >= 70 ? 'good' : s.avgCoverage >= 40 ? 'warn' : 'crit'}
          title="Average line coverage across files present in lcov.info. Drop a coverage/lcov.info in the repo and it is picked up live."
        />
        <Tile
          value={s.reuse === null ? '—' : `${s.reuse}`}
          label="reuse"
          sub={s.reuse === null ? 'nothing to score' : 'weighted by size'}
          tone={s.reuse === null ? undefined : s.reuse >= 70 ? 'good' : s.reuse >= 40 ? 'warn' : 'crit'}
          title="How much of the code you have written could be lifted out and reused, 0–100, weighted by file size. Low means the logic is entangled with the disk, a framework, or the rest of the repo. Sort the table by Reuse to see what is holding it down."
        />
        <Tile
          value={s.unreviewed}
          label="unreviewed"
          sub={s.untestedChanged > 0 ? `${s.untestedChanged} of them untested` : 'all reviewed'}
          tone={s.untestedChanged > 0 ? 'crit' : s.unreviewed > 0 ? 'warn' : 'good'}
          title="Files changed since your last check — already saved, not waiting on you. The untested ones are where agent mistakes hide longest. Dismiss the marker or revert them from the Review tab."
        />
        <Tile
          value={s.cycles}
          label="cycles"
          sub="import loops"
          tone={s.cycles > 0 ? 'warn' : 'good'}
          title="Groups of files that import each other in a loop. Edits inside a cycle ripple unpredictably."
        />
        <Tile
          value={s.orphans}
          label="orphans"
          sub="nothing imports them"
          title="Files no other file imports. Entry points and scripts are expected here; anything else is probably dead."
        />
        <Tile
          value={s.neverRead}
          label="unread"
          sub={s.changedThisSession > 0 ? `of ${s.changedThisSession} changed` : 'nothing changed yet'}
          tone={s.neverRead > 0 ? 'warn' : 'good'}
          title="Files that changed this session that no human has opened in the editor since. Comprehension debt: the code works, but nobody could maintain it without the agent. Opening a file is the evidence — approving it is only a claim."
        />
        <Tile value={s.todos} label="TODOs" sub="in comments" title="TODO / FIXME / HACK comments left in the code" />
        <span className="spacer" />
        <div className="health-tile">
          <span className="health-cap">open issues</span>
          <span className="health-sev crit" title={`${plural(s.criticals, 'critical issue')} — fix before shipping`}>
            {SEV_ICON.critical} {s.criticals} critical
          </span>
          <span className="health-sev warn" title={`${plural(s.warnings, 'warning')} — worth a look`}>
            {SEV_ICON.warning} {s.warnings} warning{s.warnings === 1 ? '' : 's'}
          </span>
          <span className="health-sev info" title={`${plural(infos, 'informational finding')} — context, not a problem`}>
            {SEV_ICON.info} {infos} info
          </span>
        </div>
      </div>

      <div className="insights-body">
        <div className="issues-col">
          <div className="issues-head">
            <h4>
              Issues <span className="muted">({issues.length})</span>
            </h4>
            <div className="sev-filters">
              {(
                [
                  { id: null, label: 'all', count: insights.issues.length },
                  { id: 'critical' as const, label: SEV_ICON.critical, count: s.criticals },
                  { id: 'warning' as const, label: SEV_ICON.warning, count: s.warnings },
                  { id: 'info' as const, label: SEV_ICON.info, count: infos },
                ] as const
              ).map((f) => (
                <button
                  key={f.label}
                  className={`sev-btn${sevFilter === f.id ? ' active' : ''}`}
                  title={f.id === null ? 'show every issue' : `show only ${f.id} issues`}
                  onClick={() => setSevFilter(f.id)}
                  data-testid={`sev-${f.id ?? 'all'}`}
                >
                  {f.label} {f.count}
                </button>
              ))}
            </div>
            {ruleFilter && (
              <span className="pill clickable" title="clear the rule filter" onClick={() => setRuleFilter(null)}>
                {ruleFilter} ✕
              </span>
            )}
          </div>
          <div className="issues-list" data-testid="issues-list">
            {issues.length === 0 && (
              <div className="issues-empty">
                <div className="issues-empty-mark">✓</div>
                nothing to flag here
              </div>
            )}
            {issues.map((issue: Issue) => (
              <div
                key={issue.id}
                className={`issue sev-${issue.severity}`}
                style={{ borderLeftColor: sevColor(issue.severity) }}
                data-testid={`issue-${issue.rule}`}
              >
                <div className="issue-title">
                  <span className="issue-name">{issue.title}</span>
                  <span
                    className="pill clickable rule-pill"
                    title={`show only ${issue.rule} issues`}
                    onClick={() => setRuleFilter(issue.rule)}
                  >
                    {issue.rule}
                  </span>
                </div>
                <div className="issue-detail">{issue.detail}</div>
                <div className="issue-paths">
                  {issue.paths.slice(0, 4).map((p) => (
                    <a
                      key={p}
                      className="deplink mono"
                      title="select on the graph (double-click opens it)"
                      onClick={() => onSelectFile(p)}
                      onDoubleClick={() => onOpenFile(p)}
                    >
                      {p}
                    </a>
                  ))}
                  {issue.paths.length > 4 && <span className="muted">+{issue.paths.length - 4} more</span>}
                  <button
                    className="issue-copy"
                    title="copy these paths as an indented tree, ready to paste into your agent"
                    onClick={() => copyIssuePaths(issue)}
                  >
                    copy paths
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="metrics-col">
          <div className="issues-head">
            <h4>
              File metrics{' '}
              <span className="muted">
                ({rows.length}
                {rows.length !== insights.files.length ? ` of ${insights.files.length}` : ''})
              </span>
            </h4>
            <span className="muted metrics-hint">sorted by {COLUMNS.find((c) => c.key === sortKey)?.label}</span>
            {/* Scores make a row comparable across columns; raw values are the
                facts behind them. Neither replaces the other, so both are one
                click apart and the tooltip always carries the raw number. */}
            <span className="unit-toggle" data-testid="metrics-units">
              <button
                className={showRaw ? '' : 'on'}
                title="Show every metric on one scale: 0–100, where 100 is the highest value in this repo"
                onClick={() => setShowRaw(false)}
                data-testid="units-scaled"
              >
                0–100
              </button>
              <button
                className={showRaw ? 'on' : ''}
                title="Show the underlying counts — lines, commits, importers"
                onClick={() => setShowRaw(true)}
                data-testid="units-raw"
              >
                raw
              </button>
            </span>
            <input
              className="search"
              style={{ width: 160, padding: '2px 8px' }}
              placeholder="filter files…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="metrics-scroll">
            <table className="metrics-table" data-testid="metrics-table">
              <thead>
                <tr>{COLUMNS.map(header)}</tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr
                    key={f.path}
                    className={f.unreviewed ? 'unreviewed' : ''}
                    onClick={() => onSelectFile(f.path)}
                    onDoubleClick={() => onOpenFile(f.path)}
                    data-testid={`metrics-row-${f.path}`}
                    title={`${f.path}\nclick to select on the graph · double-click to open`}
                  >
                    <td className="mono file-cell">
                      {f.lastAgent && f.lastAgent !== 'you' && (
                        <span title={`last touched by ${f.lastAgent}`} style={{ color: agentColor(f.lastAgent) }}>
                          ●{' '}
                        </span>
                      )}
                      <span className="file-dir">{f.path.includes('/') ? `${f.path.slice(0, f.path.lastIndexOf('/'))}/` : ''}</span>
                      <span className="file-base">{f.path.split('/').pop()}</span>
                    </td>
                    {score(f.risk, 'risk')}
                    {score(f.hotspot, 'hotspot')}
                    {score(f.refactor, 'refactor priority')}
                    {score(f.scores.complexity, 'complexity', num(f.complexity))}
                    {score(f.scores.loc, 'size', `${num(f.loc)} lines`)}
                    {score(
                      f.scores.churn,
                      'churn',
                      f.churnSession > 0
                        ? `${plural(f.churnGit, 'commit')} + ${f.churnSession} this session`
                        : plural(f.churnGit, 'commit'),
                    )}
                    {score(f.scores.fanIn, 'importers', plural(f.fanIn, 'file'))}
                    {score(f.scores.blastRadius, 'blast radius', plural(f.blastRadius, 'file'))}
                    <td className="num" style={{ color: covColor(f.coveragePct) }}>
                      {f.coveragePct === null ? (
                        <span title={f.isTest ? 'this is a test file' : f.testedBy > 0 ? 'a test imports it, but no lcov data' : 'no coverage data'}>
                          {f.isTest ? '—' : f.testedBy > 0 ? '~' : '·'}
                        </span>
                      ) : (
                        `${Math.round(f.coveragePct)}%`
                      )}
                    </td>
                    <td className="num" style={{ color: reuseColor(f.reuse) }}>
                      {f.reuse === null ? (
                        <span title="too little in this file to ask whether it could be reused">·</span>
                      ) : (
                        <span
                          title={
                            f.reuseBlockers.length > 0
                              ? `bound to ${f.reuseBlockers.join(', ')}${f.drag > 0 ? `; drags ${plural(f.drag, 'file')}` : ''}`
                              : f.drag > 0
                                ? `self-contained, but drags ${plural(f.drag, 'file')} along`
                                : 'self-contained: no host, framework or project dependencies'
                          }
                        >
                          {f.reuse}
                        </span>
                      )}
                    </td>
                    {f.todos > 0 ? (
                      score(f.scores.todos, 'TODOs', num(f.todos))
                    ) : (
                      <td className="num">
                        <span className="zero">·</span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
