import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DirListing } from '../api';
import { Spinner } from './Spinner';

/**
 * Pick a project folder by looking at the filesystem, not by typing its path.
 *
 * Served over the network the files are on the far machine, where no native
 * dialog can reach — and a bare path box is only usable by someone who
 * already knows the answer. This walks the backend's own filesystem, marks
 * the folders that look like repositories, and still lets a known path be
 * typed straight in, because that is faster when you do know.
 */

interface Props {
  onOpen(path: string): void;
  /** true while the caller is starting a session for the chosen folder */
  busy?: boolean;
  /** what the confirm button says — it picks a parent as often as a project */
  chooseLabel?: string;
  /** told whenever the folder in view changes, so a caller can act on it */
  onPathChange?(path: string): void;
  /** the caller offers its own actions and does not want a second one here */
  hideConfirm?: boolean;
}

export function FolderPicker({
  onOpen,
  busy = false,
  chooseLabel = 'Open this folder',
  onPathChange,
  hideConfirm = false,
}: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [typed, setTyped] = useState('');
  const requestId = useRef(0);
  // read through a ref so a caller passing an inline arrow does not re-run the
  // listing on every one of its renders
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;

  /*
   * Has the path been typed into since this listing was asked for?
   *
   * Going somewhere puts that folder in the box — that is the point of the
   * box. But the first listing is asked for on mount and arrives whenever it
   * arrives, and it was landing on top of a path typed in the meantime: the
   * box said one folder and the dialog opened another, whichever won the race.
   * A listing only fills the box if nothing has been typed since.
   */
  const typedSince = useRef(false);

  const go = useCallback((to?: string) => {
    const mine = ++requestId.current;
    typedSince.current = false;
    setLoading(true);
    void api.browseDir(to).then((result) => {
      // a slow listing must not overwrite a newer one the user has moved on to
      if (mine !== requestId.current) return;
      setListing(result);
      setLoading(false);
      if (typedSince.current) return;
      setTyped(result?.path ?? '');
      onPathChangeRef.current?.(result?.path ?? '');
    });
  }, []);

  useEffect(() => {
    go();
  }, [go]);

  const crumbs = (listing?.path ?? '').split(/[\\/]/).filter(Boolean);

  return (
    <div className="picker" data-testid="folder-picker">
      <div className="picker-bar">
        <button
          className="btn"
          disabled={!listing?.parent || loading}
          title="Up one folder"
          onClick={() => go(listing?.parent ?? undefined)}
          data-testid="picker-up"
        >
          ↑
        </button>
        <button className="btn" title="Home" onClick={() => go(listing?.home)} data-testid="picker-home">
          Home
        </button>
        <input
          className="start-input"
          value={typed}
          spellCheck={false}
          aria-label="Folder path"
          data-testid="picker-path"
          onChange={(e) => {
            typedSince.current = true;
            setTyped(e.target.value);
            onPathChangeRef.current?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              go(typed.trim());
            }
          }}
        />
      </div>

      <div className="picker-crumbs mono" title={listing?.path}>
        {crumbs.length === 0 ? '/' : crumbs.join(' / ')}
      </div>

      <div className="picker-list" data-testid="picker-list">
        {loading ? (
          <div className="picker-empty">
            <Spinner /> reading…
          </div>
        ) : listing?.error ? (
          <div className="picker-empty">{listing.error}</div>
        ) : listing?.dirs.length === 0 ? (
          <div className="picker-empty">no folders in here</div>
        ) : (
          listing?.dirs.map((dir) => (
            <div
              key={dir.path}
              className={`picker-row${dir.project ? ' is-project' : ''}`}
              title={dir.path}
              onDoubleClick={() => onOpen(dir.path)}
              onClick={() => go(dir.path)}
              data-testid={`picker-dir-${dir.name}`}
            >
              <span className="picker-name">{dir.name}</span>
              {dir.project && <span className="picker-tag">project</span>}
            </div>
          ))
        )}
      </div>

      <div className="picker-foot">
        <span className="start-note">
          Click to go in, double-click to open. Folders holding a repository are marked.
        </span>
        {!hideConfirm && (
          <button
            className="btn primary"
            disabled={busy || loading || !listing}
            onClick={() => listing && onOpen(typed.trim() || listing.path)}
            data-testid="picker-open"
          >
            {busy ? <Spinner /> : null}
            {busy ? ' Opening…' : chooseLabel}
          </button>
        )}
      </div>
    </div>
  );
}
