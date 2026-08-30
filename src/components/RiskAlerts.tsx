import { useEffect, useRef, useState } from 'react';
import type { RiskAlert } from '../../shared/riskAlerts';
import { ago } from '../format';

/**
 * Risky changes, as a chip in the top bar.
 *
 * This began as a stack of cards floating in a corner, and there is no corner
 * for it. The bottom-right is the terminal — a card there hides the output of
 * the very agent whose change it is reporting on. The top-right is worse: it
 * is where every tab keeps its own controls, so the stack spent its time
 * sitting on `+ Lane`, on `Re-layout`, on the channel's composer, swallowing
 * the clicks meant for them. A panel that permanently covers whatever is
 * underneath it is not an alert; it is an obstacle that happens to contain
 * text.
 *
 * So it takes the shape the review queue next to it already took for the same
 * reason: **a count you can see from across the room, and the detail one click
 * away**. The chip is the part that must always be visible; the cards are the
 * part you open when you are ready to answer them. Being in the bar means it
 * is in its own row and cannot cover anything at all.
 *
 * It still never disappears on its own. That is the whole difference between
 * this and the toasts: a toast is a receipt for something *you* just did, and
 * is gone in four seconds; this is about something an agent did while you were
 * looking elsewhere, so only an answer clears it.
 *
 * Three answers, and they are not the same answer:
 *
 * - **Review** takes you to the change, in the panel built for reading it.
 * - **Dismiss** stops the alert and nothing else. The file is still flagged in
 *   the review queue, still unread, still on disk exactly as the agent left it.
 * - **Dismiss all** does that to the queue, for when a batch of edits has
 *   already been read somewhere else.
 */

interface Props {
  alerts: readonly RiskAlert[];
  onReview(alert: RiskAlert): void;
  onDismiss(alert: RiskAlert): void;
  onDismissAll(): void;
}

export function RiskAlerts({ alerts, onReview, onDismiss, onDismissAll }: Props) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);

  // an empty queue closes itself, so the next batch does not arrive already open
  useEffect(() => {
    if (alerts.length === 0) setOpen(false);
  }, [alerts.length]);

  /*
   * Escape, and a click anywhere else.
   *
   * A popover that only closes by clicking its own button is a popover you
   * have to remember how to get out of, and this one covers the panel you
   * were about to use.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  /*
   * Re-render on a timer so "2m ago" is not frozen at "0s ago".
   *
   * A card can sit here for an hour: the whole point is that nothing removes
   * it. A stale timestamp on a card about a change that happened *while you
   * were away* misreports exactly the thing it is there to report.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (alerts.length === 0 || !open) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [alerts.length, open]);

  if (alerts.length === 0) return null;

  return (
    <div className="ra-anchor" ref={anchor} data-testid="risk-alerts">
      <button
        className={`ra-chip${open ? ' on' : ''}`}
        data-testid="ra-chip"
        aria-expanded={open}
        title={`${alerts.length} change${alerts.length === 1 ? '' : 's'} an agent made to something load-bearing. Click to read them.\n\n${alerts
          .slice(0, 4)
          .map((a) => `${a.path} — ${a.reasons.join(' · ')}`)
          .join('\n')}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ra-mark" aria-hidden="true">
          ⚠︎
        </span>
        <span className="ra-count">{alerts.length}</span>
        <span className="ra-word">risky</span>
      </button>

      {open && (
        <div className="ra-pop" role="region" aria-label="Risky changes">
          <div className="ra-head">
            <span className="ra-title">
              {alerts.length} risky change{alerts.length === 1 ? '' : 's'}
            </span>
            <button
              className="ra-btn ra-quiet"
              data-testid="ra-dismiss-all"
              title="Clear every alert. The files stay flagged in the review queue — this only stops the alerts."
              onClick={onDismissAll}
            >
              Dismiss all
            </button>
          </div>

          <div className="ra-list" aria-live="polite">
            {alerts.map((alert) => (
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
                    onClick={() => {
                      setOpen(false);
                      onReview(alert);
                    }}
                  >
                    Review
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
