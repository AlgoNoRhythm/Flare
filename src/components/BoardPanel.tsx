import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addLane,
  addNote,
  createTask,
  deleteTask,
  moveLane,
  moveTask,
  openQuestions,
  proposedDecisions,
  removeLane,
  renameLane,
  tasksInLane,
  updateTask,
  type Board,
  type Task,
} from '../../shared/tasks';
import { api } from '../api';
import { toast } from './Toasts';
import { DecisionsSection, QuestionsSection } from './Collaboration';
import { TaskModal } from './TaskModal';
import { RoutineWizard } from './RoutineWizard';
import { HintNote } from './HintNote';
import { IconCopy, IconExpand, IconGear } from './icons';
import type { ModalRequest } from './Menus';

type Section = 'tasks' | 'decisions' | 'questions';

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
  /** bumped from elsewhere (the terminal bar's heartbeat chip) to open the Routine */
  openRoutine?: number;
  /** this project's MCP endpoint, for the routine's default heartbeat command */
  mcpUrl?: string | null;
}

function ago(time: number): string {
  const s = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function BoardPanel({
  board,
  selectedPaths,
  onChange,
  onSelectFile,
  onOpenFile,
  onModal,
  openRoutine = 0,
  mcpUrl = null,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; brief: string; paths: string }>({
    title: '',
    brief: '',
    paths: '',
  });
  const dragged = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ laneId: string; index: number } | null>(null);
  const [section, setSection] = useState<Section>('tasks');
  const [wizardOpen, setWizardOpen] = useState(false);

  /*
   * Opened from somewhere else — the terminal bar's heartbeat chip.
   *
   * A counter, so a second click reopens it after you have closed it; the
   * initial 0 is skipped so arriving at the board does not pop the wizard.
   */
  useEffect(() => {
    if (openRoutine) setWizardOpen(true);
  }, [openRoutine]);

  const byLane = useMemo(
    () => new Map(board.lanes.map((lane) => [lane.id, tasksInLane(board, lane.id)])),
    [board],
  );

  /** The task the modal is open on, or null. Resolved fresh so an agent's
      note landing over MCP while you have it open is not written back out. */
  const editingTask = editing ? (board.tasks.find((t) => t.id === editing) ?? null) : null;

  const startEdit = (task: Task) => {
    setEditing(task.id);
    setDraft({ title: task.title, brief: task.brief, paths: task.paths.join('\n') });
  };

  const commitEdit = (id: string, asDraft = false) => {
    onChange(
      updateTask(board, id, {
        title: draft.title,
        brief: draft.brief,
        paths: draft.paths
          .split(/[\n,]/)
          .map((p) => p.trim().replace(/\\/g, '/'))
          .filter(Boolean),
        // saving properly is what turns a draft back into a card
        draft: asDraft,
      }),
    );
    setEditing(null);
  };

  /**
   * Leave without saving. A card that was created a moment ago and never
   * given a word is not a task, it is a mis-click — it goes. Anything with
   * content stays exactly as it was before the edit began.
   */
  const discardEdit = (task: Task) => {
    const untouched =
      task.title === 'New task' && task.brief === '' && task.paths.length === 0 && task.notes.length === 0;
    if (untouched) onChange(deleteTask(board, task.id));
    setEditing(null);
  };

  /*
   * "+ Task" makes an empty card. It used to attach whatever was selected on
   * the graph, which is right when you asked for a task *about* those files
   * (the New task button on a node, the bulk bar) and a surprise otherwise —
   * a selection left over from an hour ago is not a brief. Those two doors
   * still carry their files; this one starts blank, and the modal offers the
   * selection as one click if it is wanted.
   */
  const addTask = (laneId: string) => {
    const result = createTask(board, { title: 'New task', laneId, paths: [] });
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

  const waitingDecisions = proposedDecisions(board).length;
  const waitingQuestions = openQuestions(board).length;

  return (
    <div className="board" data-testid="board-panel">
      <div className="board-head">
        <span className="board-title">Control panel</span>
        {/*
          Three things the same conversation produces and only one of which the
          board could hold: the work, the calls made along the way, and what
          the agent needs from you. They are sections rather than three panels
          because they are one collaboration.
        */}
        <div className="collab-nav" role="tablist" aria-label="Control panel sections">
          {(
            [
              ['tasks', 'Tasks', board.tasks.length],
              ['decisions', 'Design decisions', waitingDecisions],
              ['questions', 'Questions', waitingQuestions],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              role="tab"
              aria-selected={section === id}
              className={`collab-nav-tab${section === id ? ' active' : ''}`}
              onClick={() => setSection(id)}
              data-testid={`collab-nav-${id}`}
            >
              {label}
              {count > 0 && (
                <span className={`collab-nav-count${id === 'tasks' ? '' : ' waiting'}`}>{count}</span>
              )}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className={`btn${board.routine ? '' : ' primary'}`}
          title={
            board.routine
              ? 'Change what the assistant does when it runs out of work'
              : 'Set up what the assistant does when it runs out of work'
          }
          onClick={() => setWizardOpen(true)}
          data-testid="board-routine"
        >
          <IconGear /> Routine{board.routine ? '' : '…'}
        </button>
        {section === 'tasks' && (
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
        )}
      </div>

      {section === 'tasks' && (
        <HintNote id="board" className="board-hint-row muted">
          Cards are written to be pasted into an agent. Your agent can also read these lanes over MCP
          with <code>tasks_list</code>, and move a card with <code>task_update</code>.
        </HintNote>
      )}

      {wizardOpen && (
        <RoutineWizard board={board} onChange={onChange} onClose={() => setWizardOpen(false)} mcpUrl={mcpUrl} />
      )}

      {section === 'decisions' && (
        <DecisionsSection board={board} onChange={onChange} onSelectFile={onSelectFile} />
      )}
      {section === 'questions' && <QuestionsSection board={board} onChange={onChange} />}

      {section === 'tasks' && (
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
                      // a card is for scanning; everything you would open a
                      // task *for* happens at full size. Controls opt out:
                      // double-click in the note input selects a word, and
                      // that must not rip the modal open under the caret.
                      onDoubleClick={(e) => {
                        if ((e.target as HTMLElement).closest('input, select, textarea, a')) return;
                        startEdit(task);
                      }}
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
                      <div
                        className="task-title"
                        title="Open this task at full size — or double-click the card"
                        onClick={() => startEdit(task)}
                      >
                        {/* the label is its own element: the row also holds
                            the expand affordance, and "the title" should mean
                            the title */}
                        <span className="task-title-text">{task.title}</span>
                        {task.draft && (
                          <span
                            className="task-draft"
                            title="Saved as a draft — not offered to agents until you save it properly"
                          >
                            draft
                          </span>
                        )}
                        <button
                          className="task-expand"
                          title="Open this task at full size"
                          aria-label="Open this task at full size"
                          data-testid={`task-expand-${task.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(task);
                          }}
                        >
                          <IconExpand size={12} />
                        </button>
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
                              <IconCopy size={12} /> Copy for agent
                            </button>
                            {/* editing was only reachable by clicking the title,
                                which nothing on the card said you could do */}
                            <button
                              className="row-btn"
                              title="Open this task at full size to edit its title, brief, files and notes"
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
                    </div>
                  );
                })}

                <button className="lane-add" onClick={() => addTask(lane.id)} data-testid={`lane-add-${lane.id}`}>
                  + Task
                </button>
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/*
        Mounted at the panel root, not inside the card: a dialog nested in a
        draggable, overflow-scrolled lane inherits the lane's clipping and its
        drag handlers, which is how it ends up scrolling with the column it is
        supposed to be covering.
      */}
      {editingTask && (
        <TaskModal
          task={editingTask}
          lanes={board.lanes}
          draft={draft}
          onDraft={setDraft}
          selectedPaths={selectedPaths}
          onSave={() => commitEdit(editingTask.id)}
          onSaveDraft={() => commitEdit(editingTask.id, true)}
          onCancel={() => discardEdit(editingTask)}
          onDelete={() => {
            onChange(deleteTask(board, editingTask.id));
            setEditing(null);
          }}
          onLane={(laneId) => onChange(updateTask(board, editingTask.id, { laneId }))}
          onSelectFile={onSelectFile}
          onOpenFile={onOpenFile}
          onCopyForAgent={() => void copyForAgent(editingTask)}
        />
      )}
    </div>
  );
}
