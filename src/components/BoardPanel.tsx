import { useMemo, useRef, useState } from 'react';
import {
  addLane,
  addNote,
  createTask,
  deleteTask,
  moveLane,
  moveTask,
  removeLane,
  renameLane,
  tasksInLane,
  updateTask,
  type Board,
  type Task,
} from '../../shared/tasks';
import { api } from '../api';
import { toast } from './Toasts';
import type { ModalRequest } from './Menus';

/**
 * The board.
 *
 * Tasks here exist to be handed to an agent, so the card's primary action is
 * "copy for the agent" — which emits the brief plus what the graph knows about
 * the files it names. The same lanes are queryable over MCP, so an agent can
 * pull its next task and move it to review without a human relaying anything.
 */

interface Props {
  board: Board;
  /** files currently selected on the graph / in the tree */
  selectedPaths: readonly string[];
  onChange(board: Board): void;
  onSelectFile(path: string): void;
  onOpenFile(path: string): void;
  onModal(request: ModalRequest): void;
}

function ago(time: number): string {
  const s = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function BoardPanel({ board, selectedPaths, onChange, onSelectFile, onOpenFile, onModal }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; brief: string; paths: string }>({
    title: '',
    brief: '',
    paths: '',
  });
  const dragged = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ laneId: string; index: number } | null>(null);

  const byLane = useMemo(
    () => new Map(board.lanes.map((lane) => [lane.id, tasksInLane(board, lane.id)])),
    [board],
  );

  const startEdit = (task: Task) => {
    setEditing(task.id);
    setDraft({ title: task.title, brief: task.brief, paths: task.paths.join('\n') });
  };

  const commitEdit = (id: string) => {
    onChange(
      updateTask(board, id, {
        title: draft.title,
        brief: draft.brief,
        paths: draft.paths
          .split(/[\n,]/)
          .map((p) => p.trim().replace(/\\/g, '/'))
          .filter(Boolean),
      }),
    );
    setEditing(null);
  };

  const addTask = (laneId: string) => {
    const result = createTask(board, {
      title: 'New task',
      laneId,
      paths: [...selectedPaths],
    });
    onChange(result.board);
    startEdit(result.task);
  };

  const copyForAgent = async (task: Task) => {
    // formatted in the main process so this is byte-identical to what the
    // agent gets from the task_get MCP tool
    const text = (await api.boardFormat(task.id)) ?? task.title;
    void api.clipboardWrite(text);
    toast(`"${task.title}" copied — paste it into your agent`, 'success');
  };

  const drop = (laneId: string, index: number) => {
    const id = dragged.current;
    dragged.current = null;
    setDropTarget(null);
    if (id) onChange(moveTask(board, id, laneId, index));
  };

  return (
    <div className="board" data-testid="board-panel">
      <div className="board-head">
        <span className="board-title">Tasks</span>
        <span className="muted board-hint">
          Cards are written to be pasted into an agent. Your agent can also read these lanes over MCP
          with <code>tasks_list</code>, and move a card with <code>task_update</code>.
        </span>
        <span className="spacer" />
        <button
          className="btn"
          title="Add a lane to this board"
          onClick={() =>
            onModal({
              title: 'New lane',
              input: { placeholder: 'Blocked', initial: '' },
              confirmLabel: 'Add lane',
              onConfirm: (value) => value.trim() && onChange(addLane(board, value)),
            })
          }
          data-testid="board-add-lane"
        >
          + Lane
        </button>
      </div>

      <div className="board-lanes">
        {board.lanes.map((lane, laneIndex) => {
          const tasks = byLane.get(lane.id) ?? [];
          return (
            <div
              key={lane.id}
              className={`lane${dropTarget?.laneId === lane.id ? ' dropping' : ''}`}
              data-testid={`lane-${lane.id}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDropTarget({ laneId: lane.id, index: tasks.length });
              }}
              onDrop={() => drop(lane.id, dropTarget?.laneId === lane.id ? dropTarget.index : tasks.length)}
            >
              <div className="lane-head">
                <span
                  className="lane-title"
                  title="rename this lane"
                  onDoubleClick={() =>
                    onModal({
                      title: `Rename "${lane.title}"`,
                      input: { initial: lane.title },
                      confirmLabel: 'Rename',
                      onConfirm: (value) => onChange(renameLane(board, lane.id, value)),
                    })
                  }
                >
                  {lane.title}
                </span>
                <span className="lane-count">{tasks.length}</span>
                <span className="spacer" />
                <button
                  className="row-btn"
                  title="move this lane left"
                  disabled={laneIndex === 0}
                  onClick={() => onChange(moveLane(board, lane.id, laneIndex - 1))}
                >
                  ‹
                </button>
                <button
                  className="row-btn"
                  title="move this lane right"
                  disabled={laneIndex === board.lanes.length - 1}
                  onClick={() => onChange(moveLane(board, lane.id, laneIndex + 1))}
                >
                  ›
                </button>
                <button
                  className="row-btn danger"
                  title={
                    board.lanes.length <= 1
                      ? 'a board needs at least one lane'
                      : 'remove this lane — its tasks move to the first lane'
                  }
                  disabled={board.lanes.length <= 1}
                  onClick={() => onChange(removeLane(board, lane.id))}
                  data-testid={`lane-remove-${lane.id}`}
                >
                  ✕
                </button>
              </div>

              <div className="lane-body">
                {tasks.map((task, index) => {
                  const isEditing = editing === task.id;
                  return (
                    <div
                      key={task.id}
                      className={`task-card${isEditing ? ' editing' : ''}`}
                      data-testid={`task-${task.id}`}
                      draggable={!isEditing}
                      onDragStart={() => {
                        dragged.current = task.id;
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropTarget({ laneId: lane.id, index });
                      }}
                      onDrop={(e) => {
                        e.stopPropagation();
                        drop(lane.id, index);
                      }}
                    >
                      {isEditing ? (
                        <div
                          className="task-edit"
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setEditing(null);
                            }
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                              e.preventDefault();
                              commitEdit(task.id);
                            }
                          }}
                        >
                          <input
                            className="task-input title"
                            value={draft.title}
                            autoFocus
                            placeholder="What needs doing?"
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                            data-testid="task-title-input"
                          />
                          <textarea
                            className="task-input brief"
                            value={draft.brief}
                            rows={5}
                            placeholder="The detail an agent needs: what to change, what done looks like, what to avoid."
                            onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
                            data-testid="task-brief-input"
                          />
                          <textarea
                            className="task-input paths mono"
                            value={draft.paths}
                            rows={3}
                            placeholder={'Files, one per line\nsrc/api.ts'}
                            onChange={(e) => setDraft({ ...draft, paths: e.target.value })}
                            data-testid="task-paths-input"
                          />
                          {selectedPaths.length > 0 && (
                            <button
                              className="row-btn"
                              title="add the files currently selected on the graph"
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  paths: [...new Set([...draft.paths.split('\n').filter(Boolean), ...selectedPaths])].join('\n'),
                                })
                              }
                            >
                              + {selectedPaths.length} selected on the graph
                            </button>
                          )}
                          {/*
                            Delete sits at the far end and Save at the near one:
                            they were the other way round, which put the
                            irreversible action exactly where the eye goes for
                            the primary one.
                          */}
                          <div className="task-actions">
                            <button
                              className="btn danger"
                              title="delete this task"
                              onClick={() => {
                                onChange(deleteTask(board, task.id));
                                setEditing(null);
                              }}
                              data-testid="task-delete"
                            >
                              Delete
                            </button>
                            <span className="spacer" />
                            <button className="btn" title="Esc" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                            <button
                              className="btn primary"
                              title="Ctrl+Enter"
                              onClick={() => commitEdit(task.id)}
                              data-testid="task-save"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="task-title" onClick={() => startEdit(task)}>
                            {task.title}
                          </div>
                          {task.brief && <div className="task-brief">{task.brief}</div>}
                          {task.paths.length > 0 && (
                            <div className="task-paths">
                              {task.paths.slice(0, 4).map((p) => (
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
                              {task.paths.length > 4 && <span className="muted">+{task.paths.length - 4}</span>}
                            </div>
                          )}
                          {task.notes.length > 0 && (
                            <details className="task-notes">
                              <summary>
                                {task.notes.length} note{task.notes.length === 1 ? '' : 's'} ·{' '}
                                {ago(task.notes[task.notes.length - 1].at)}
                              </summary>
                              {task.notes.map((note, i) => (
                                <div key={i} className="task-note">
                                  <span className="note-by">{note.by}</span>
                                  <span>{note.text}</span>
                                </div>
                              ))}
                            </details>
                          )}
                          <div className="task-foot">
                            <button
                              className="row-btn primary"
                              title="Copy the brief plus what the graph knows about its files — ready to paste into an agent"
                              onClick={() => void copyForAgent(task)}
                              data-testid={`task-copy-${task.id}`}
                            >
                              ⧉ Copy for agent
                            </button>
                            {/* editing was only reachable by clicking the title,
                                which nothing on the card said you could do */}
                            <button
                              className="row-btn"
                              title="Edit this task's title, brief and files"
                              onClick={() => startEdit(task)}
                              data-testid={`task-edit-${task.id}`}
                            >
                              Edit
                            </button>
                            <span className="spacer" />
                            <select
                              className="lane-select"
                              value={task.laneId}
                              title="move to another lane"
                              onChange={(e) => onChange(updateTask(board, task.id, { laneId: e.target.value }))}
                              data-testid={`task-lane-${task.id}`}
                            >
                              {board.lanes.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.title}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="task-note-add">
                            <input
                              className="task-input note"
                              placeholder="log progress…"
                              title="Enter to append a note — agents append here too, over MCP"
                              onKeyDown={(e) => {
                                const input = e.target as HTMLInputElement;
                                if (e.key === 'Enter' && input.value.trim()) {
                                  onChange(addNote(board, task.id, 'you', input.value));
                                  input.value = '';
                                }
                              }}
                              data-testid={`task-note-${task.id}`}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                <button className="lane-add" onClick={() => addTask(lane.id)} data-testid={`lane-add-${lane.id}`}>
                  + Task
                  {selectedPaths.length > 0 && (
                    <span className="muted"> with {selectedPaths.length} selected file{selectedPaths.length === 1 ? '' : 's'}</span>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
