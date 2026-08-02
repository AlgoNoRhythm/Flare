import { FlareMark } from './FlareMark';

/**
 * What the canvas says when there is nothing to draw.
 *
 * A graph of nothing renders as a blank rectangle, which is exactly what a
 * broken one looks like — and "Start empty" lands here by definition, so it
 * was the first thing a new project showed. Searching does not reach this
 * state: a filter dims the cards it excludes rather than removing them, so an
 * empty board really does mean an empty project.
 */
export function GraphEmpty() {
  return (
    <div className="graph-empty" data-testid="graph-empty">
      <FlareMark size={40} />
      <p className="graph-empty-title">No code here yet.</p>
      <p>
        This folder holds nothing Flare can graph. It is being watched, so the map draws itself as
        soon as the first file lands — you do not need to refresh or reopen anything.
      </p>
      <p className="graph-empty-quiet">
        The terminal below runs in this folder. That is where you would start an agent, and every
        file it writes is snapshotted and attributed as it goes.
      </p>
    </div>
  );
}
