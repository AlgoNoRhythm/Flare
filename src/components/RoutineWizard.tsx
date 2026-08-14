import { useEffect, useRef, useState } from 'react';
import {
  formatRoutineForAgent,
  routineRules,
  setRoutine,
  type Board,
  type DecisionPolicy,
  type Routine,
} from '../../shared/tasks';
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
}

const DEFAULTS: Omit<Routine, 'setAt'> = {
  recheckBoard: true,
  decisions: 'flag',
  parkQuestions: true,
  heartbeat: false,
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

export function RoutineWizard({ board, onChange, onClose }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<Omit<Routine, 'setAt'>>(() => {
    const { recheckBoard, decisions, parkQuestions, heartbeat, notes, text } = board.routine ?? DEFAULTS;
    return { recheckBoard, decisions, parkQuestions, heartbeat, notes, text };
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
    key: 'recheckBoard' | 'parkQuestions' | 'heartbeat',
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

        {step === 1 ? (
          <>
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
            {toggle(
              'heartbeat',
              'Check the board when it tries to stop',
              'Flare answers your assistant’s stop hook with the state of the board: if a card is still workable it gets handed back with the card named, instead of the session ending. Adds a Stop hook to .claude/settings.local.json — local to this machine, not committed. Needs curl on the PATH.',
            )}

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

            <div className="modal-actions">
              <span className="spacer" />
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => setStep(2)} data-testid="routine-next">
                Review it →
              </button>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
