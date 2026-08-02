import { useEffect, useRef, useState } from 'react';
import type { RecentEntry } from '../../electron/core';
import { api, isDesktop } from '../api';
import { FlareMark } from './FlareMark';
import { FolderPicker } from './FolderPicker';
import { NewProjectDialog } from './NewProjectDialog';
import { Spinner } from './Spinner';

/** "3 minutes ago" — precise enough to recognise a project, no more. */
function ago(at: number): string {
  if (at === 0) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  if (d < 30) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return new Date(at).toLocaleDateString();
}

function splitPath(full: string): { name: string; parent: string } {
  const parts = full.replace(/[\\/]+$/, '').split(/[\\/]/);
  return { name: parts[parts.length - 1] || full, parent: parts.slice(0, -1).join('/') };
}

/**
 * What the app opens to.
 *
 * Launch used to restore the last project silently, so this screen — and with
 * it every way to reach a *different* project — was unreachable in normal use.
 * The list is the point: the last thing you worked on is the first row and one
 * Enter away, so restoring is still a keystroke, just not an assumption.
 */
export function StartScreen() {
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api.recentsGet().then(setRecents);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * Keys typed into a field belong to that field.
       *
       * This listens on the window so the recents list is navigable without
       * clicking into it first — which also meant Enter in the picker's path
       * box opened whichever recent happened to be highlighted, instead of the
       * folder just typed. Arrow keys were moving that highlight too.
       */
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      const list = recents ?? [];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(list.length - 1, c + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter' && list[cursor]) {
        e.preventDefault();
        void api.openProject(list[cursor].path);
      } else if (e.key === 'o' && (e.ctrlKey || e.metaKey) && isDesktop) {
        e.preventDefault();
        void api.openProjectDialog();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recents, cursor]);

  return (
    <div className="start" data-testid="start-screen">
      <div className="start-inner">
        <div className="start-head">
          <FlareMark size={46} />
          <div>
            <h1>Flare</h1>
            <p className="start-tag">A dependency graph, a review cockpit, and a terminal for your agent.</p>
          </div>
        </div>

        <div className="start-body">
          <div className="start-actions">
            {isDesktop ? (
              <>
                <div className="start-buttons">
                  <button
                    className="btn primary"
                    data-testid="open-folder"
                    onClick={() => void api.openProjectDialog()}
                  >
                    Open folder…
                  </button>
                  <button
                    className="btn"
                    data-testid="new-project"
                    title="Create a folder and open it as a project"
                    onClick={() => setCreating(true)}
                  >
                    New / open project…
                  </button>
                </div>
                <span className="start-kbd">
                  <kbd>Ctrl</kbd>
                  <kbd>O</kbd>
                </span>
              </>
            ) : (
              /*
               * Served in a browser there is no native dialog, and the files
               * are on the far machine — so the picker walks the backend's
               * filesystem rather than asking anyone to know a path by heart.
               */
              <FolderPicker
                busy={opening}
                onOpen={(path) => {
                  if (path === '') return;
                  setFailed(false);
                  setOpening(true);
                  // a session that starts navigates this page away; getting a
                  // result back at all means it did not open
                  void api.openProject(path).then(() => {
                    setOpening(false);
                    setFailed(true);
                  });
                }}
              />
            )}
            {!isDesktop && (
              <button
                className="btn"
                data-testid="new-project"
                title="Create a folder on that machine and open it as a project"
                onClick={() => setCreating(true)}
              >
                New / open project…
              </button>
            )}
            <p className="start-note" data-testid="start-note">
              {failed && !opening
                ? 'That folder could not be opened. It may have been moved or be unreadable.'
                : isDesktop
                  ? 'Point it at a repository. It indexes imports, watches for edits, and exposes the graph to your agent over MCP.'
                  : 'Folders on the machine running Flare. Each one opens at its own url, so you can keep several going in several tabs.'}
            </p>
          </div>

          <div className="start-recents">
            <h2>Recent</h2>
            {recents === null ? (
              <p className="start-empty">
                <Spinner /> loading…
              </p>
            ) : recents.length === 0 ? (
              <p className="start-empty">Nothing yet — the folders you open show up here.</p>
            ) : (
              <div className="start-list" ref={listRef}>
                {recents.map((entry, i) => {
                  const { name, parent } = splitPath(entry.path);
                  return (
                    <div
                      key={entry.path}
                      className={`start-row${i === cursor ? ' on' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => void api.openProject(entry.path)}
                      title={entry.path}
                      data-testid={`recent-${name}`}
                    >
                      <span className="start-name">{name}</span>
                      <span className="start-path">{parent}</span>
                      <span className="start-when">{ago(entry.openedAt)}</span>
                      <button
                        className="start-forget"
                        title="Remove from this list. The folder is not touched."
                        aria-label={`Remove ${name} from recents`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void api.recentsForget(entry.path).then(setRecents);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {creating && <NewProjectDialog hasProject={false} onClose={() => setCreating(false)} />}
    </div>
  );
}
