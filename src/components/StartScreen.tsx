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
 *
 * It is the same screen in a window and in a tab. The folder picker walks the
 * filesystem of whichever machine Flare is running on, which is the only thing
 * that works when that machine is not the one in front of you — and it works
 * just as well when it is. The desktop keeps the system's own dialog as a
 * second way in, on the shortcut it has always had, rather than as a
 * different screen.
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

  /*
   * Open a folder, and say so if it did not.
   *
   * In a window the project comes back and this screen is replaced. Served,
   * a session that starts navigates the page away and the call never resolves
   * at all. So an answer with nothing in it is the one outcome left to show.
   */
  const openPath = (path: string): void => {
    if (path === '') return;
    setFailed(false);
    setOpening(true);
    void api.openProject(path).then((info) => {
      if (info) return;
      setOpening(false);
      setFailed(true);
    });
  };

  /** the native picker where there is one, the in-app one where there is not */
  const openDialog = (): void => {
    if (isDesktop) void api.openProjectDialog();
    else setCreating(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openDialog();
        return;
      }
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <FolderPicker busy={opening} onOpen={openPath} />
            <div className="start-buttons">
              <button
                className="btn"
                data-testid="new-project"
                title="Create a folder on the machine running Flare and open it as a project"
                onClick={() => setCreating(true)}
              >
                New / open project…
              </button>
              {isDesktop && (
                <button
                  className="btn"
                  data-testid="open-folder"
                  title="Pick the folder with the system's own dialog"
                  onClick={() => void api.openProjectDialog()}
                >
                  System dialog…
                  <span className="start-kbd">
                    <kbd>Ctrl</kbd>
                    <kbd>O</kbd>
                  </span>
                </button>
              )}
            </div>
            <p className="start-note" data-testid="start-note">
              {failed && !opening
                ? 'That folder could not be opened. It may have been moved or be unreadable.'
                : 'Point it at a repository on the machine running Flare. It indexes imports, watches for edits, and exposes the graph to your agent over MCP.'}
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
