import { useEffect, useRef, useState } from 'react';
import {
  formatRoutineForAgent,
  routineRules,
  setRoutine,
  type Board,
  type DecisionPolicy,
  type Routine,
} from '../../shared/tasks';
import {
  HEARTBEAT_DEFAULT_MS,
  HEARTBEAT_INTERVALS,
  defaultHeartbeatCommand,
} from '../../shared/heartbeat';
import type { HeartbeatMode } from '../../shared/tasks';
import { api } from '../api';
import { toast } from './Toasts';

/**
 * Set up what the assistant does when it runs out of work.
 *
 * The three rules here are the ones that decide whether a session ends with a
 * question in a chat window nobody is reading. Left to itself an agent finishes
 * a task and stops; asks something and stops; makes a design decision nobody
 * saw and does not stop. Each switch turns one of those into something the
 * board can carry.
 *
 * Two steps on purpose. The first is the agreement, in the terms a person
 * thinks in; the second is the same thing in the words the agent will read, so
 * nobody has to take on trust what was just switched on.
 */

interface Props {
  board: Board;
  onChange(board: Board): void;
  onClose(): void;
  /** this project's MCP endpoint, for the default heartbeat command */
  mcpUrl?: string | null;
}

const DEFAULTS: Omit<Routine, 'setAt'> = {
  recheckBoard: true,
  decisions: 'flag',
  parkQuestions: true,
  heartbeat: 'off',
  heartbeatEvery: HEARTBEAT_DEFAULT_MS,
  heartbeatCommand: '',
  notes: '',
  text: '',
};

/**
 * The two honest answers to "it made a call you have not seen yet".
 *
 * Not a preference: `flag` buys a session that keeps moving and pays for it if
 * you decline something three files later, `park` buys a codebase with nothing
 * speculative in it and pays for it in idle time. The panel gets the card
 * either way — this only decides what happens while it waits.
 */
/**
 * The two mechanisms, in preference order.
 *
 * Not a preference either: the hook fires at the moment the agent stops and
 * costs nothing until then, while the timer polls and types into a live shell.
 * The timer exists only because not every agent has a hook to answer.
 */
const HEARTBEAT_MODES: { id: Exclude<HeartbeatMode, 'off'>; title: string; detail: string }[] = [
  {
    id: 'stop-hook',
    title: 'Answer its stop hook with the board',
    detail:
      'A session that tries to end while a card is workable is handed that card instead, by name. Adds a Stop hook to .claude/settings.local.json — local to this machine, not committed. Needs curl on the PATH, and an assistant that has stop hooks.',
  },
  {
    id: 'timer',
    title: 'Prompt a quiet terminal on a timer',
    detail:
      'For agents with no stop hook. When a terminal that was running one goes quiet, the line below is typed into it — only ever a terminal an agent has already used, never a shell you are working in.',
  },
];

const POLICIES: { id: Exclude<DecisionPolicy, 'off'>; title: string; detail: string }[] = [
  {
    id: 'flag',
    title: 'Flag it and keep building',
    detail:
      'The work carries on assuming the decision, and the note says which ones it assumed — so declining later tells you exactly what to unwind.',
  },
  {
    id: 'park',
    title: 'Park the work that rests on it',
    detail:
      'It picks up something the decision does not touch and comes back once you have agreed. Nothing expensive gets built on a guess.',
  },
];

export function RoutineWizard({ board, onChange, onClose, mcpUrl = null }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<Omit<Routine, 'setAt'>>(() => {
    const r = board.routine ?? DEFAULTS;
    return {
      recheckBoard: r.recheckBoard,
      decisions: r.decisions,
      parkQuestions: r.parkQuestions,
      heartbeat: r.heartbeat,
      heartbeatEvery: r.heartbeatEvery,
      // the endpoint is only known once the project is open, so the wizard is
      // where a blank command finally gets one
      heartbeatCommand: r.heartbeatCommand || defaultHeartbeatCommand(mcpUrl),
      notes: r.notes,
      text: r.text,
    };
  });

  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * What the agent will read, and what it is made of.
   *
   * `rules` is the editable half — generated from the switches until somebody
   * rewrites it, and then theirs. `preview` is the whole thing including the
   * state of the board, which is counted fresh on every call and so is shown
   * rather than edited.
   */
  const edited = draft.text.trim() !== '';
  const rules = edited ? draft.text : routineRules({ ...draft, setAt: 0 });
  const preview = formatRoutineForAgent(setRoutine(board, draft));

  const save = (): void => {
    onChange(setRoutine(board, draft));
    toast('Routine saved — your agent can read it with working_agreement', 'success');
    onClose();
  };

  const toggle = (
    key: 'recheckBoard' | 'parkQuestions',
    title: string,
    detail: string,
  ) => (
    <label className="routine-rule" data-testid={`routine-${key}`}>
      <input
        type="checkbox"
        checked={draft[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))}
      />
      <span>
        <b>{title}</b>
        <span className="sub">{detail}</span>
      </span>
    </label>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal routine-wizard"
        role="dialog"
        aria-label="Set up the assistant's routine"
        data-testid="routine-wizard"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>When the assistant runs out of work</h2>

        {/*
          The scroll lives on the body, not the dialog: the title stays put and
          Review it / Save stay pinned, because on a short window they were off
          the bottom of the screen with nothing to scroll — the routine could be
          started and never finished. Same shape as .tm-body in TaskModal.
        */}
        {step === 1 ? (
          <div className="routine-body">
            <p className="muted">
              These become the working agreement for this project. Your agent reads them back over
              MCP with <code>working_agreement</code>, so they survive the chat window they were
              agreed in.
            </p>

            {toggle(
              'recheckBoard',
              'Check the board again instead of stopping',
              'Finishing a card is not finishing: take the next one that is not blocked, and only stop when there is nothing workable left.',
            )}
            <div className="routine-rule stack" data-testid="routine-decisions">
              <label className="routine-rule-head">
                <input
                  type="checkbox"
                  checked={draft.decisions !== 'off'}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, decisions: e.target.checked ? 'flag' : 'off' }))
                  }
                />
                <span>
                  <b>Record design decisions it has not agreed with you</b>
                  <span className="sub">
                    The architectural ones — a module boundary, a dependency taken on, a data shape
                    that will spread, a refactor across several files. Not local names, and not
                    anything one edit would undo.
                  </span>
                </span>
              </label>
              {draft.decisions !== 'off' && (
                <div className="routine-choice" role="radiogroup" aria-label="What to do while it waits">
                  {POLICIES.map((p) => (
                    <label
                      key={p.id}
                      className={`routine-option${draft.decisions === p.id ? ' active' : ''}`}
                      data-testid={`routine-decisions-${p.id}`}
                    >
                      <input
                        type="radio"
                        name="decision-policy"
                        checked={draft.decisions === p.id}
                        onChange={() => setDraft((d) => ({ ...d, decisions: p.id }))}
                      />
                      <span>
                        <b>{p.title}</b>
                        <span className="sub">{p.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {toggle(
              'parkQuestions',
              'Park questions and keep going',
              'A question names the tasks it blocks; everything else stays workable. It halts only when every remaining task is waiting on you.',
            )}
            {/*
              The one rule that does not rely on the agent having read the
              others. Everything above is prose it may or may not act on an
              hour into a session; this is a hook, and it fires whether or not
              anything was remembered.
            */}
            {/*
              The heartbeat: one setting, three values, so "both mechanisms on"
              is not a state anyone can reach. The hook is listed first because
              it is strictly better where it is available — it fires at the
              moment that matters, polls nothing, and never types into a shell
              you might be using.
            */}
            <div className="routine-rule stack" data-testid="routine-heartbeat">
              <label className="routine-rule-head">
                <input
                  type="checkbox"
                  checked={draft.heartbeat !== 'off'}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, heartbeat: e.target.checked ? 'stop-hook' : 'off' }))
                  }
                  data-testid="routine-heartbeat-on"
                />
                <span>
                  <b>Keep it working when it would have stopped</b>
                  <span className="sub">
                    The one rule that does not rely on the agent having read the others. Everything
                    above is prose it may or may not act on an hour into a session; this fires
                    whether or not anything was remembered.
                  </span>
                </span>
              </label>
              {draft.heartbeat !== 'off' && (
                <div className="routine-choice" role="radiogroup" aria-label="How to keep it working">
                  {HEARTBEAT_MODES.map((m) => (
                    <label
                      key={m.id}
                      className={`routine-option${draft.heartbeat === m.id ? ' active' : ''}`}
                      data-testid={`routine-heartbeat-${m.id}`}
                    >
                      <input
                        type="radio"
                        name="heartbeat-mode"
                        checked={draft.heartbeat === m.id}
                        onChange={() => setDraft((d) => ({ ...d, heartbeat: m.id }))}
                      />
                      <span>
                        <b>{m.title}</b>
                        <span className="sub">{m.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {draft.heartbeat === 'timer' && (
                <div className="routine-timer" data-testid="routine-heartbeat-timer">
                  <label>
                    <span className="sub">Quiet for</span>
                    <select
                      value={draft.heartbeatEvery}
                      onChange={(e) => setDraft((d) => ({ ...d, heartbeatEvery: Number(e.target.value) }))}
                      data-testid="routine-heartbeat-every"
                    >
                      {HEARTBEAT_INTERVALS.map((i) => (
                        <option key={i.ms} value={i.ms}>
                          {i.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grow">
                    <span className="sub">then send</span>
                    <input
                      className="mono"
                      value={draft.heartbeatCommand}
                      placeholder="Pick up available tasks from …"
                      onChange={(e) => setDraft((d) => ({ ...d, heartbeatCommand: e.target.value }))}
                      data-testid="routine-heartbeat-command"
                    />
                  </label>
                </div>
              )}
            </div>

            <label className="routine-notes">
              <span>House rules (optional)</span>
              <textarea
                value={draft.notes}
                placeholder={'e.g. never touch shared/types.ts without asking\nrun npm test before moving a card to review'}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                data-testid="routine-notes"
                rows={4}
              />
            </label>
          </div>
        ) : (
          <div className="routine-body">
            <p className="muted">
              This is what the agent reads, and you can rewrite it.{' '}
              {edited ? (
                <>
                  <b>Edited by hand</b> — the switches no longer rewrite it, though they still mean
                  what they say: the decision policy and the stop hook are read from them, not from
                  this text.
                </>
              ) : (
                'Until you do, it is generated from the switches, so turning one off removes its rule rather than leaving a sentence behind.'
              )}
            </p>
            {/*
              Editable, because the switches cover what every project wants and
              nothing of what this one wants said in its own words — house
              rules were the escape hatch and they only ever appended.
            */}
            <textarea
              className="routine-preview"
              data-testid="routine-preview"
              spellCheck={false}
              value={rules}
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            />
            {/*
              Shown, not editable: it is counted from the board every time the
              agent asks, so anything typed here would be a snapshot of what
              was outstanding when it was typed.
            */}
            <details className="routine-appendix" data-testid="routine-appendix">
              <summary>Flare appends the state of the board to this</summary>
              <pre>{preview.slice(preview.indexOf('## Right now'))}</pre>
            </details>
          </div>
        )}

        {step === 1 ? (
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => setStep(2)} data-testid="routine-next">
              Review it →
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            <button className="btn" onClick={() => setStep(1)} data-testid="routine-back">
              ← Back
            </button>
            {edited && (
              <button
                className="btn"
                title="Throw away the edits and go back to the text the switches generate"
                onClick={() => setDraft((d) => ({ ...d, text: '' }))}
                data-testid="routine-reset"
              >
                Reset to generated
              </button>
            )}
            <span className="spacer" />
            <button
              className="btn"
              title="Paste it into an agent that cannot reach MCP"
              onClick={() => {
                void api.clipboardWrite(preview);
                toast('Working agreement copied', 'success');
              }}
              data-testid="routine-copy"
            >
              Copy for agent
            </button>
            <button className="btn primary" onClick={save} data-testid="routine-save">
              Save routine
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
