import { useRef, useEffect } from 'react';

export type GraphViewKind = 'canvas' | 'wheel' | 'districts';

interface Props {
  view: GraphViewKind;
  onClose(): void;
}

interface Row {
  keys: string;
  what: string;
}

const COMMON: Row[] = [
  { keys: 'click', what: 'select a file — the details panel opens on the right' },
  { keys: 'double-click', what: 'open it in the editor (a folder unfolds instead)' },
  { keys: 'ctrl + click', what: 'add to the selection (works like the file tree)' },
  { keys: 'right-click', what: 'rename, delete, copy paths in an agent-friendly tree' },
  { keys: 'ctrl + drag', what: 'box-select everything inside the rectangle' },
  { keys: 'Delete', what: 'delete the current selection (snapshotted first)' },
];

const PER_VIEW: Record<GraphViewKind, Row[]> = {
  canvas: [
    { keys: 'hover', what: 'blue = what it imports, amber = what imports it' },
    { keys: 'shift + click', what: 'trace the dependency path from the selected file to this one' },
    { keys: 'drag a card', what: 'move it — the position is remembered per project' },
    { keys: 'drag the board', what: 'pan; scroll to zoom, double-click empty space to fit' },
    { keys: 'zoom out', what: 'cards drop their badges so the shape of the repo stays readable' },
  ],
  wheel: [
    { keys: 'drag', what: 'spin the wheel; alt + scroll rotates it precisely' },
    { keys: 'click a node', what: 'pin its dependencies — blue out, amber in — and keep them pinned' },
    { keys: 'click empty space', what: 'release the pin' },
    { keys: 'hover a band', what: 'isolate that directory; click the band to fold or unfold it' },
    { keys: 'shift + drag', what: 'pan the wheel; scroll zooms' },
  ],
  districts: [
    { keys: 'tile area', what: 'lines of code — shade is whichever lens is active' },
    { keys: 'click a tile', what: 'select it and outline every file it is connected to' },
    { keys: 'click a header', what: 'fold or unfold that directory' },
    { keys: 'scroll', what: 'zoom into a dense district; drag to pan once zoomed' },
  ],
};

const GLOBAL: Row[] = [
  { keys: 'V', what: 'swap the pointer tool: move the canvas, or drag to select files' },
  { keys: 'Ctrl + K', what: 'command palette — every command and file' },
  { keys: 'Ctrl + B', what: 'toggle the sidebar' },
  { keys: 'Ctrl 0 + −', what: 'fit the view, zoom in, zoom out' },
  { keys: 'Enter', what: 'in the search box: jump the graph to the first match' },
  { keys: 'Esc', what: 'clear focus mode and collapse expanded symbols' },
  { keys: '?', what: 'open this cheat sheet' },
];

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="help-section">
      <h4>{title}</h4>
      <dl>
        {rows.map((r) => (
          <div key={r.keys + r.what} className="help-row">
            <dt>{r.keys}</dt>
            <dd>{r.what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const VIEW_TITLE: Record<GraphViewKind, string> = {
  canvas: 'Canvas',
  wheel: 'Wheel',
  districts: 'Districts',
};

export function HelpOverlay({ view, onClose }: Props) {
  /*
   * Subscribe once, through a ref.
   *
   * `onClose` is an inline arrow at the call site, so it has a new identity on
   * every render of the app — which made this effect tear down and re-add its
   * listener constantly. A listener added while a keydown is still being
   * dispatched does not receive that event, so any state change elsewhere in
   * the same Escape press could swallow the one that was meant to close this.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  return (
    <div className="palette-backdrop" onMouseDown={onClose} data-testid="help-overlay">
      <div className="help-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h3>How to drive the graph</h3>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="help-cols">
          <Section title={`${VIEW_TITLE[view]} view`} rows={PER_VIEW[view]} />
          <Section title="Any view" rows={COMMON} />
          <Section title="Keyboard" rows={GLOBAL} />
        </div>
        <div className="help-foot">
          The <b>colour</b> row picks the question you are asking; the <b>view</b> row picks how the answer
          is drawn. Both stay in sync, so you can switch either without losing your place.
        </div>
      </div>
    </div>
  );
}
