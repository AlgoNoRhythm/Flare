import { useState } from 'react';
import type { ChangeBurst } from '../../shared/activity';
import {
  OUTCOME_LABEL,
  auditSummary,
  type SessionSummary,
} from '../../shared/session';
import { agentColor, agentShape } from '../graph/lenses';
import { ago } from '../format';

/**
 * What the agents say they did, over the top of what they did.
 *
 * Everything else in this panel answers a question about one change. This
 * answers the one a person actually arrives with — *what happened while I was
 * away* — and it is the only thing here Flare did not derive, because the
 * answer does not exist in any burst. It exists as a story, and the only
 * participant who knows the story is the agent that lived it, which is why it
 * is asked for over MCP before the session ends.
 *
 * It is not taken on trust. Every chapter is bound to the writes underneath
 * it, so the prose carries its own evidence: the files it named that really
 * changed, the ones that never did, and — the line that makes the rest worth
 * reading — the files that changed and no chapter mentions at all. A summary
 * is only as good as what it leaves out, and this is the only place you can
 * see what it left out.
 */

interface Props {
  summaries: readonly SessionSummary[];
  bursts: readonly ChangeBurst[];
  onSelectFile(path: string): void;
  onOpenFile(path: string): void;
}

const VERDICT_HINT: Record<string, string> = {
  passed: 'A test or type check ran after the last of these files changed, and passed.',
  failed: 'The last check over these files failed. This chapter describes known-broken work.',
  unchecked: 'Nothing has run over these files since they changed.',
};

export function SessionStory({ summaries, bursts, onSelectFile, onOpenFile }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (summaries.length === 0) return null;

  return (
    <div className="story" data-testid="session-story">
      <button
        className="story-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
        data-testid="story-toggle"
        title="What the agents said they did this session, checked against what Flare watched them do"
      >
        {collapsed ? '▸' : '▾'} what the {summaries.length === 1 ? 'agent says it' : 'agents say they'} did
      </button>

      {!collapsed &&
        summaries.map((summary) => {
          const audit = auditSummary(summary, bursts);
          const color = agentColor(summary.by);
          return (
            <div
              key={summary.id}
              className="story-card"
              style={{ '--agent': color } as React.CSSProperties}
              data-testid={`story-${summary.by}`}
            >
              <div className="story-head">
                <span className="story-mark">{agentShape(summary.by)}</span>
                <span className="story-who">{summary.byName}</span>
                <span className="story-headline">{summary.headline}</span>
                <span className="spacer" />
                <span
                  className={`story-coverage${audit.unaccounted.length > 0 ? ' warn' : ''}`}
                  title={
                    audit.total === 0
                      ? 'Flare attributed no file changes to this agent, so there is nothing to check the summary against.'
                      : `${audit.accounted} of the ${audit.total} files it changed are covered by a chapter below.`
                  }
                >
                  {audit.total > 0 ? `${audit.accounted}/${audit.total} files` : 'no writes'}
                </span>
                <span className="story-when">{ago(summary.at)}</span>
              </div>

              {summary.chapters.length === 0 && (
                <div className="story-chapter">
                  <div className="story-detail muted">
                    No chapters — a headline on its own says what the session was called, not what
                    it did.
                  </div>
                </div>
              )}

              {summary.chapters.map((chapter, i) => {
                const entry = audit.chapters[i];
                return (
                  <div key={`${summary.id}-${i}`} className={`story-chapter ${chapter.outcome}`}>
                    <div className="story-chapter-head">
                      <span className="story-title">{chapter.title}</span>
                      {chapter.outcome !== 'done' && (
                        <span className={`story-outcome ${chapter.outcome}`}>
                          {OUTCOME_LABEL[chapter.outcome]}
                        </span>
                      )}
                      {entry && entry.changed.length > 0 && (
                        <span
                          className={`story-verdict ${entry.verified}`}
                          title={VERDICT_HINT[entry.verified]}
                        >
                          {entry.verified === 'passed'
                            ? 'verified'
                            : entry.verified === 'failed'
                              ? 'checks failed'
                              : 'unchecked'}
                        </span>
                      )}
                    </div>
                    {chapter.detail && <div className="story-detail">{chapter.detail}</div>}
                    <div className="story-files">
                      {entry?.changed.map((p) => (
                        <a
                          key={p}
                          className="deplink mono"
                          title={`${p} — click to select, double-click to open`}
                          onClick={() => onSelectFile(p)}
                          onDoubleClick={() => onOpenFile(p)}
                        >
                          {p}
                        </a>
                      ))}
                      {/*
                        Named and never touched. Worth its own mark rather than
                        being dropped: prose describing work that did not happen
                        is the one kind of wrong a reader cannot catch from the
                        diff, because there is no diff to catch it in.
                      */}
                      {entry?.absent.map((p) => (
                        <span key={p} className="story-absent mono" title="named here, but this never changed">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}

              {audit.unaccounted.length > 0 && (
                <div className="story-gap" data-testid={`story-gap-${summary.by}`}>
                  <b>Not mentioned above</b>
                  <span className="muted">
                    {' '}
                    — {summary.byName} changed {audit.unaccounted.length} file
                    {audit.unaccounted.length === 1 ? '' : 's'} that no chapter accounts for. The
                    bursts below are the only record of why.
                  </span>
                  <div className="story-files">
                    {audit.unaccounted.map((p) => (
                      <a
                        key={p}
                        className="deplink mono"
                        onClick={() => onSelectFile(p)}
                        onDoubleClick={() => onOpenFile(p)}
                      >
                        {p}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
