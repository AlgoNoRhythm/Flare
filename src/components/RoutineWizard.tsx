import { useEffect, useRef, useState } from 'react';
import {
  formatRoutineForAgent,
  setRoutine,
  type Board,
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
  flagDecisions: true,
  parkQuestions: true,
  notes: '',
};

export function RoutineWizard({ board, onChange, onClose }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<Omit<Routine, 'setAt'>>(() => {
    const { recheckBoard, flagDecisions, parkQuestions, notes } = board.routine ?? DEFAULTS;
    return { recheckBoard, flagDecisions, parkQuestions, notes };
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

  /* the preview is the real thing: rendered from a board carrying this draft */
  const preview = formatRoutineForAgent(setRoutine(board, draft));

  const save = (): void => {
    onChange(setRoutine(board, draft));
    toast('Routine saved — your agent can read it with working_agreement', 'success');
    onClose();
  };

  const toggle = (
    key: 'recheckBoard' | 'flagDecisions' | 'parkQuestions',
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
            {toggle(
              'flagDecisions',
              'Flag design decisions it has not agreed with you',
              'Anything a reasonable person could disagree with is recorded as proposed, and nothing expensive gets built on it until you agree.',
            )}
            {toggle(
              'parkQuestions',
              'Park questions and keep going',
              'A question names the tasks it blocks; everything else stays workable. It halts only when every remaining task is waiting on you.',
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
              This is what the agent reads. It is generated from the switches, so turning one off
              removes its rule rather than leaving a sentence behind.
            </p>
            <pre className="routine-preview" data-testid="routine-preview">
              {preview}
            </pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => setStep(1)} data-testid="routine-back">
                ← Back
              </button>
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
