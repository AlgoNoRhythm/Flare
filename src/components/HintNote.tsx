import { useState, type ReactNode } from 'react';

/**
 * Explanatory chrome that can be put away.
 *
 * Review, the board and the channel each opened with a sentence or two of
 * manual burned into the panel — right the first time you see the panel,
 * noise every day after. The text is unchanged; what is new is the ✕, and
 * that the choice sticks per machine. It is not per project: the sentences
 * explain the app, not the repo.
 */
export function HintNote({
  id,
  className,
  children,
}: {
  /** storage key suffix; also names the note in tests */
  id: string;
  className: string;
  children: ReactNode;
}) {
  const key = `flare.hint.${id}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className={className} data-testid={`hint-${id}`}>
      <span className="hint-body">{children}</span>
      <button
        className="hint-dismiss"
        title="Got it — hide this explanation"
        aria-label="Hide this explanation"
        onClick={() => {
          try {
            localStorage.setItem(key, '1');
          } catch {
            // storage unavailable: it hides for this window, returns next time
          }
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
