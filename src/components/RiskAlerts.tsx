import { useEffect, useState } from 'react';
import type { RiskAlert } from '../../shared/riskAlerts';
import { ago } from '../format';

/**
 * Risky changes, queued in the corner.
 *
 * The pattern is a meeting reminder: one card per thing that wants an answer,
 * stacked newest-first, staying put until it gets one. Deliberately not the
 * transient toasts next door — those are receipts for something you just did,
 * and are gone in four seconds. These are about something an *agent* did while
 * you were looking elsewhere, so disappearing on their own is the one thing
 * they must not do.
 *
 * Three answers, and they are not the same answer:
 *
 * - **Review** takes you to the change, in the panel built for reading it.
 * - **Dismiss** stops the popup and nothing else. The file is still flagged in
 *   the review queue, still unread, still on disk exactly as the agent left it.
 * - **Dismiss all** does that to the queue, for when a batch of edits has
 *   already been read somewhere else.
 *
 * Past `VISIBLE` the rest collapse behind a count, because a stack tall enough
 * to reach the toolbar stops being an alert and becomes scenery.
 */

interface Props {
  alerts: readonly RiskAlert[];
  onReview(alert: RiskAlert): void;
  onDismiss(alert: RiskAlert): void;
  onDismissAll(): void;
}

const VISIBLE = 3;

export function RiskAlerts({ alerts, onReview, onDismiss, onDismissAll }: Props) {
  const [expanded, setExpanded] = useState(false);

  // an empty queue collapses again, so the next batch does not arrive already
  // unfolded to whatever depth the last one reached
  useEffect(() => {
    if (alerts.length === 0) setExpanded(false);
  }, [alerts.length]);

  /*
   * Re-render on a timer so "2m ago" is not frozen at "0s ago".
   *
   * A card can sit here for an hour: the whole point is that nothing removes
   * it. A stale timestamp on a card about a change that happened *while you
   * were away* misreports exactly the thing it is there to report.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [alerts.length]);

  if (alerts.length === 0) return null;

  const shown = expanded ? alerts : alerts.slice(0, VISIBLE);
  const hidden = alerts.length - shown.length;

  return (
    <div className="risk-alerts" data-testid="risk-alerts" role="region" aria-label="Risky changes">
      <div className="ra-head">
        <span className="ra-title">
          <span className="ra-mark" aria-hidden="true">
            ⚠︎
          </span>
          {alerts.length} risky change{alerts.length === 1 ? '' : 's'}
        </span>
        <button
          className="ra-btn ra-quiet"
          data-testid="ra-dismiss-all"
          title="Clear every alert. The files stay flagged in the review queue — this only stops the popups."
          onClick={onDismissAll}
        >
          Dismiss all
        </button>
      </div>

      <div className="ra-list" aria-live="polite">
        {shown.map((alert) => (
          <div key={alert.id} className="ra-card" data-testid={`ra-card-${alert.path}`}>
            <div className="ra-card-head">
              <span className="ra-path mono" title={alert.path}>
                {alert.path}
              </span>
              <span className="ra-when">{ago(alert.at)}</span>
            </div>
            <div className="ra-why">{alert.reasons.join(' · ')}</div>
            <div className="ra-foot">
              <span className="ra-agent" title="who was running when this file changed">
                {alert.agent}
              </span>
              <span className="spacer" />
              <button
                className="ra-btn ra-quiet"
                data-testid={`ra-dismiss-${alert.path}`}
                title="Stop showing this alert. The change stays in the review queue, and on disk."
                onClick={() => onDismiss(alert)}
              >
                Dismiss
              </button>
              <button
                className="ra-btn ra-primary"
                data-testid={`ra-review-${alert.path}`}
                title="Open this change in the review panel"
                onClick={() => onReview(alert)}
              >
                Review
              </button>
            </div>
          </div>
        ))}
      </div>

      {(hidden > 0 || expanded) && (
        <button
          className="ra-more"
          data-testid="ra-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {hidden > 0 ? `${hidden} more…` : 'Show fewer'}
        </button>
      )}
    </div>
  );
}
