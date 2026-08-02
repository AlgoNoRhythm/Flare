import { useEffect, useRef, useState } from 'react';
import { api, isDesktop } from '../api';
import { FolderPicker } from './FolderPicker';
import { Spinner } from './Spinner';

/**
 * Start working on a project.
 *
 * Two ways in, because they are genuinely different intentions and only one of
 * them was reachable: point Flare at a folder that already has code in it, or
 * make an empty one and start from nothing. The second is the rarer case, so
 * it is the second tab.
 *
 * Both walk the backend's own filesystem rather than the viewer's, which is
 * the only thing that works when the files are on another machine — so the
 * same dialog serves a window and a browser tab.
 */

type Mode = 'open' | 'create';

interface Props {
  onClose(): void;
  /**
   * A project is already open here, so opening another one in this window ends
   * it — its watcher, its shadow history and whatever is running in its
   * terminals. When there is nothing to lose, as on the start screen, there is
   * nothing to ask about either.
   */
  hasProject: boolean;
}

export function NewProjectDialog({ onClose, hasProject }: Props) {
  const [mode, setMode] = useState<Mode>('open');
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  /*
   * Subscribe once.
   *
   * `onClose` is an inline arrow from the parent, so depending on it re-runs
   * this effect on every one of the parent's renders — and a listener added
   * while an event is already being dispatched never receives that event. The
   * same shape once made Escape stop closing the cheat sheet.
   */
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || latest.current.busy) return;
      e.stopPropagation();
      latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * What "done" looks like differs by transport, so each action says so
   * explicitly rather than sharing a guess.
   *
   * In a window, opening here resolves with the project; served over the
   * network it navigates the page away and never resolves at all. Opening
   * elsewhere always comes straight back, having handed the project to a
   * second window or a second tab. What is left is the failure, which is the
   * only thing this dialog still has to show.
   */
  const run = (detached: boolean): void => {
    if (busy) return;
    const path = chosen.trim();
    if (path === '') return;
    if (mode === 'create' && name.trim() === '') return;
    setBusy(true);
    setError(null);

    const done = (failure: string | null): void => {
      setBusy(false);
      if (failure) setError(failure);
      else onClose();
    };

    if (mode === 'create') {
      void api
        .createProject(path, name.trim(), detached)
        .then((result) => done(result?.error ?? null));
      return;
    }
    void api
      .openProject(path, detached)
      .then((info) =>
        done(
          detached || info
            ? null
            : 'That folder could not be opened. It may have been moved or be unreadable.',
        ),
      );
  };

  const ready = chosen.trim() !== '' && (mode === 'open' || name.trim() !== '');
  const elsewhere = isDesktop ? 'in a new window' : 'in a new tab';
  const target =
    mode === 'create' && chosen !== ''
      ? `${chosen}${chosen.endsWith('/') || chosen.endsWith('\\') ? '' : '/'}${name.trim() || '…'}`
      : chosen;

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal new-project"
        role="dialog"
        aria-label="New or open project"
        data-testid="new-project-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>New / open project</h2>

        <div className="wizard-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'open'}
            className={`wizard-tab${mode === 'open' ? ' active' : ''}`}
            onClick={() => {
              setMode('open');
              setError(null);
            }}
            data-testid="wizard-tab-open"
          >
            Open a folder
          </button>
          <button
            role="tab"
            aria-selected={mode === 'create'}
            className={`wizard-tab${mode === 'create' ? ' active' : ''}`}
            onClick={() => {
              setMode('create');
              setError(null);
            }}
            data-testid="wizard-tab-create"
          >
            Start empty
          </button>
        </div>

        <p className="start-note">
          {mode === 'open'
            ? 'Point Flare at a folder that already has code in it. Folders holding a repository are marked.'
            : 'Choose where it goes and name the folder. Flare creates it and opens it, so everything written into it from then on is tracked.'}
        </p>

        <FolderPicker
          hideConfirm
          onOpen={(path) => {
            setChosen(path);
            setError(null);
            if (mode === 'create') nameRef.current?.focus();
          }}
          onPathChange={(path) => {
            setChosen(path);
            setError(null);
          }}
        />

        {mode === 'create' && (
          <div className="new-project-name">
            <label htmlFor="new-project-name">Folder name</label>
            <input
              id="new-project-name"
              ref={nameRef}
              className="start-input"
              value={name}
              spellCheck={false}
              placeholder="my-service"
              data-testid="new-project-name"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  run(false);
                }
              }}
            />
          </div>
        )}

        <p className="new-project-target mono" data-testid="new-project-target">
          {target === '' ? 'Pick a folder above.' : target}
        </p>

        {error && (
          <p className="new-project-error" data-testid="new-project-error">
            {error}
          </p>
        )}

        <div className="task-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <span className="spacer" />
          {/*
            Offered only when there is something to lose. One window holds one
            project, so opening here closes the one you were working on —
            worth being a deliberate choice rather than the only option.
          */}
          {hasProject && (
            <button
              className="btn"
              onClick={() => run(true)}
              disabled={busy || !ready}
              title={`Leave this project open and start the other one ${elsewhere}`}
              data-testid="new-project-elsewhere"
            >
              {mode === 'create' ? 'Create' : 'Open'} {elsewhere}
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => run(false)}
            disabled={busy || !ready}
            title={hasProject ? 'Replace the project open here' : undefined}
            data-testid="new-project-here"
          >
            {busy ? <Spinner /> : null}
            {busy ? ' Opening…' : hasProject ? `${mode === 'create' ? 'Create' : 'Open'} here` : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
