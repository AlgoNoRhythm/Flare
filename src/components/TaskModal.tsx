import { useEffect, useRef } from 'react';
import type { Lane, Task } from '../../shared/tasks';
import { ago } from '../format';

/**
 * One task, at a size you can actually read it at.
 *
 * A lane is a column ~240px wide, which is the right size for *scanning* a
 * board and the wrong size for everything else a task carries: a brief written
 * to be handed to an agent runs to a paragraph or five, and the progress notes
 * an agent appends over an hour's work are the record of what it did. Both of
 * those were being read four words to a line, or behind a `<details>`, or not
 * at all.
 *
 * So editing moved here rather than being duplicated here. Two surfaces that
 * both edit a task is two places to fix a bug in, and the narrow one was the
 * one nobody wanted — the card keeps a clamped preview and stays a thing you
 * scan, and everything you would open a task *for* happens at this size.
 *
 * Reachable four ways, because the old single route (click the title, which
 * nothing said you could do) is exactly the discoverability problem this is
 * fixing: double-click the card, the ⤢ button, the Edit button, or the title.
 */

interface Props {
  task: Task;
  lanes: readonly Lane[];
  draft: { title: string; brief: string; paths: string };
  onDraft(draft: { title: string; brief: string; paths: string }): void;
  /** files currently selected on the graph, for the one-click add */
  selectedPaths: readonly string[];
  onSave(): void;
  onCancel(): void;
  onDelete(): void;
  onLane(laneId: string): void;
  onSelectFile(path: string): void;
  onOpenFile(path: string): void;
  onCopyForAgent(): void;
}

export function TaskModal({
  task,
  lanes,
  draft,
  onDraft,
  selectedPaths,
  onSave,
  onCancel,
  onDelete,
  onLane,
  onSelectFile,
  onOpenFile,
  onCopyForAgent,
}: Props) {
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, [task.id]);

  const paths = draft.paths.split('\n').map((p) => p.trim()).filter(Boolean);

  return (
    <div
      className="modal-backdrop"
      data-testid="task-modal-backdrop"
      onMouseDown={(e) => {
        // only a click that both starts and ends on the backdrop dismisses:
        // dragging a text selection out of the textarea used to close it
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="modal task-modal"
        data-testid="task-modal"
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSave();
          }
        }}
      >
        <div className="tm-head">
          <input
            ref={titleRef}
            className="task-input title tm-title"
            value={draft.title}
            placeholder="What needs doing?"
            onChange={(e) => onDraft({ ...draft, title: e.target.value })}
            data-testid="task-title-input"
          />
          <select
            className="lane-select"
            value={task.laneId}
            title="move to another lane"
            onChange={(e) => onLane(e.target.value)}
            data-testid="task-modal-lane"
          >
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </div>

        <div className="tm-body">
          <label className="tm-label" htmlFor="tm-brief">
            Brief — what an agent is handed
          </label>
          <textarea
            id="tm-brief"
            className="task-input brief tm-brief"
            value={draft.brief}
            placeholder="The detail an agent needs: what to change, what done looks like, what to avoid."
            onChange={(e) => onDraft({ ...draft, brief: e.target.value })}
            data-testid="task-brief-input"
          />

          <label className="tm-label" htmlFor="tm-paths">
            Files — one per line
          </label>
          <textarea
            id="tm-paths"
            className="task-input paths mono tm-paths"
            value={draft.paths}
            placeholder={'src/api.ts'}
            onChange={(e) => onDraft({ ...draft, paths: e.target.value })}
            data-testid="task-paths-input"
          />
          <div className="tm-pathrow">
            {selectedPaths.length > 0 && (
              <button
                className="row-btn"
                title="add the files currently selected on the graph"
                onClick={() =>
                  onDraft({
                    ...draft,
                    paths: [...new Set([...paths, ...selectedPaths])].join('\n'),
                  })
                }
              >
                + {selectedPaths.length} selected on the graph
              </button>
            )}
            <span className="spacer" />
            {paths.map((p) => (
              <a
                key={p}
                className="deplink mono"
                title={`${p} — click to select on the graph, double-click to open`}
                onClick={() => onSelectFile(p)}
                onDoubleClick={() => onOpenFile(p)}
              >
                {p.split('/').pop()}
              </a>
            ))}
          </div>

          {/*
            The progress log, finally readable. This is what an agent wrote
            back over MCP while it worked — on the card it was a `<details>`
            summary saying "4 notes", which is a count where the content was
            the point.
          */}
          {task.notes.length > 0 && (
            <>
              <div className="tm-label">
                Progress — {task.notes.length} note{task.notes.length === 1 ? '' : 's'}
              </div>
              <div className="tm-notes" data-testid="task-modal-notes">
                {task.notes.map((note, i) => (
                  <div key={i} className="task-note">
                    <span className="note-by">{note.by}</span>
                    <span className="tm-note-text">{note.text}</span>
                    <span className="note-when">{ago(note.at)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/*
          Delete sits at the far end and Save at the near one: they were the
          other way round once, which put the irreversible action exactly where
          the eye goes for the primary one.
        */}
        <div className="task-actions">
          <button className="btn danger" title="delete this task" onClick={onDelete} data-testid="task-delete">
            Delete
          </button>
          <span className="spacer" />
          <button
            className="row-btn primary"
            title="Copy the brief plus what the graph knows about its files — ready to paste into an agent"
            onClick={onCopyForAgent}
            data-testid="task-modal-copy"
          >
            ⧉ Copy for agent
          </button>
          <button className="btn" title="Esc" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" title="Ctrl+Enter" onClick={onSave} data-testid="task-save">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
