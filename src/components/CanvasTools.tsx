/**
 * The controls that act on the view rather than on the code.
 *
 * The pointer mode was a small toggle in the toolbar among the lens buttons,
 * which is the wrong place for it: it is not a display option, it is the mode
 * the pointer is in — the same decision every canvas tool makes, and every one
 * of them puts it on the canvas as a palette you can see without looking for
 * it. Zoom, re-centre and the shortcut list followed it down here for the same
 * reason: they are things you do *to the canvas*, and having them along the top
 * pushed the graph itself further down the screen.
 *
 * Both drag gestures stay available in either mode: whichever tool is not
 * selected is what Ctrl gives you. So picking one is a preference about which
 * is one-handed, never a corner you can get stuck in.
 */

interface Props {
  selectMode: boolean;
  onChange(selectMode: boolean): void;
  zoomPct: number;
  onZoom(direction: 1 | -1): void;
  onFit(): void;
  onCenter(): void;
  onHelp(): void;
}

export function CanvasTools({ selectMode, onChange, zoomPct, onZoom, onFit, onCenter, onHelp }: Props) {
  return (
    <>
      <div className="canvas-tools" role="radiogroup" aria-label="Pointer tool" data-testid="canvas-tools">
        <button
          role="radio"
          aria-checked={!selectMode}
          aria-label="Move the canvas"
          className={`tool${selectMode ? '' : ' active'}`}
          title="Move — drag the canvas to pan it. Hold Ctrl to select instead. (V)"
          onClick={() => onChange(false)}
          data-testid="tool-pan"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            {/* an open hand: the universal "you are moving the surface" */}
            <path
              d="M8 12V6.5a1.3 1.3 0 0 1 2.6 0V11m0-1.2V5.3a1.3 1.3 0 0 1 2.6 0V11m0-1.4a1.3 1.3 0 0 1 2.6 0V12m0-.9a1.3 1.3 0 0 1 2.6 0v4.2c0 2.9-2.2 5.2-5 5.2h-1.3c-1.5 0-2.9-.7-3.8-1.9L5 15.4a1.4 1.4 0 0 1 .4-2c.6-.4 1.4-.3 1.9.2L8 14.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          role="radio"
          aria-checked={selectMode}
          aria-label="Select files"
          className={`tool${selectMode ? ' active' : ''}`}
          title="Select — drag a box over the files you want. Hold Ctrl to pan instead. (V)"
          onClick={() => onChange(true)}
          data-testid="tool-select"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            {/* the arrow pointer, drawn solid so it reads at this size */}
            <path
              d="M6 3.2 18.4 12.6l-5.2.5 2.9 6-2.4 1.1-2.8-5.9-3.9 3.4z"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* the view controls sit in the opposite corner, out of the way of the
          left-to-right flow the layout puts the foundations at */}
      <div className="canvas-tools right" data-testid="view-tools">
        <button
          className="tool"
          aria-label="Centre the view"
          title="Centre — bring the graph back to the middle without changing the zoom"
          onClick={onCenter}
          data-testid="tool-center"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            {/* a reticle: crosshair through a ring, with a dot on the target */}
            <circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <path
              d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className="tool"
          aria-label="Fit everything on screen"
          title="Fit everything on screen (Ctrl+0, or double-click empty space)"
          onClick={onFit}
          data-testid="zoom-fit"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            {/* four corner brackets: the frame closing in on the content */}
            <path
              d="M3.5 8.5v-5h5M15.5 3.5h5v5M20.5 15.5v5h-5M8.5 20.5h-5v-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="tool-sep" />
        <button className="tool wide" title="Zoom out (Ctrl+−)" aria-label="Zoom out" onClick={() => onZoom(-1)}>
          −
        </button>
        <span className="tool-zoom" data-testid="zoom-readout" title="current zoom">
          {zoomPct}%
        </span>
        <button className="tool wide" title="Zoom in (Ctrl++)" aria-label="Zoom in" onClick={() => onZoom(1)}>
          +
        </button>
        <span className="tool-sep" />
        <button
          className="tool wide"
          title="Every click, drag and shortcut in this view (?)"
          aria-label="Hints"
          onClick={onHelp}
          data-testid="btn-help"
        >
          ?
        </button>
      </div>
    </>
  );
}
