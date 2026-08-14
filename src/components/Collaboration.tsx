import { useState } from 'react';
import {
  answerQuestion,
  decideDecision,
  deleteDecision,
  deleteQuestion,
  recordDecision,
  type Board,
  type Decision,
  type Question,
} from '../../shared/tasks';
import { ago } from '../format';

/**
 * The two halves of the collaboration the board could not hold.
 *
 * A task is work someone has already decided to do. These are the things that
 * arrive *while* it is being done and have nowhere to go: a choice the agent
 * made that nobody agreed to, and a question it needs answered. Both used to
 * live in a chat log — which is to say, both were lost.
 */

interface DecisionProps {
  board: Board;
  onChange(board: Board): void;
  onSelectFile(path: string): void;
}

const STATUS_LABEL: Record<Decision['status'], string> = {
  proposed: 'waiting on you',
  agreed: 'agreed',
  declined: 'declined',
};

/** Proposed first: they are the ones holding something up. */
function sortDecisions(decisions: readonly Decision[]): Decision[] {
  const rank = { proposed: 0, declined: 1, agreed: 2 };
  return [...decisions].sort((a, b) => rank[a.status] - rank[b.status] || b.at - a.at);
}

export function DecisionsSection({ board, onChange, onSelectFile }: DecisionProps) {
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', detail: '' });

  const decide = (id: string, status: 'agreed' | 'declined'): void => {
    onChange(decideDecision(board, id, status, verdicts[id] ?? ''));
    setVerdicts((prev) => ({ ...prev, [id]: '' }));
  };

  const decisions = sortDecisions(board.decisions);

  return (
    <div className="collab" data-testid="decisions-section">
      <div className="collab-intro">
        {/*
          The second half of this sentence is the routine's, not ours: under
          "flag" the work carries on and under "park" it waits, and a fixed
          line describing one of them is wrong half the time — on the panel
          where you are deciding what happens next.
        */}
        <span>
          What the agent decided that you have not agreed to. It records these with{' '}
          <code>decision_record</code> before writing the code that assumes them
          {board.routine?.decisions === 'flag'
            ? ', and keeps building — so declining one tells it exactly what to unwind.'
            : ', and leaves anything that rests on them until you say yes.'}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => setAdding((v) => !v)} data-testid="decision-add">
          + Decision
        </button>
      </div>

      {adding && (
        <div className="collab-card new" data-testid="decision-form">
          <input
            className="collab-input"
            placeholder="The decision, in one line"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            data-testid="decision-title-input"
            autoFocus
          />
          <textarea
            className="collab-input"
            rows={3}
            placeholder="Why, and what it commits us to"
            value={draft.detail}
            onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
            data-testid="decision-detail-input"
          />
          <div className="collab-actions">
            <span className="spacer" />
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={draft.title.trim() === ''}
              onClick={() => {
                // a decision you write down yourself is one you have agreed to
                onChange(
                  recordDecision(board, { ...draft, by: 'you', status: 'agreed' }).board,
                );
                setDraft({ title: '', detail: '' });
                setAdding(false);
              }}
              data-testid="decision-save"
            >
              Record it
            </button>
          </div>
        </div>
      )}

      {decisions.length === 0 && !adding && (
        <div className="collab-empty" data-testid="decisions-empty">
          Nothing recorded yet. When your agent makes a call you might have made differently, it
          lands here instead of inside a diff.
        </div>
      )}

      {decisions.map((d) => (
        <div
          key={d.id}
          className={`collab-card decision ${d.status}`}
          data-testid={`decision-${d.id}`}
        >
          <div className="collab-head">
            <span className={`collab-status ${d.status}`}>{STATUS_LABEL[d.status]}</span>
            <span className="collab-title">{d.title}</span>
            <span className="spacer" />
            <span className="collab-meta">
              {d.by} · {ago(d.at)}
            </span>
            <button
              className="row-btn"
              title="Remove this decision"
              onClick={() => onChange(deleteDecision(board, d.id))}
              data-testid={`decision-delete-${d.id}`}
            >
              ✕
            </button>
          </div>

          {d.detail && <div className="collab-body">{d.detail}</div>}
          {d.alternatives && (
            <div className="collab-alt">
              <b>Rejected</b> {d.alternatives}
            </div>
          )}
          {d.paths.length > 0 && (
            <div className="collab-paths">
              {d.paths.map((p) => (
                <a key={p} className="deplink mono" onClick={() => onSelectFile(p)}>
                  {p}
                </a>
              ))}
            </div>
          )}

          {d.status === 'proposed' ? (
            <div className="collab-actions">
              <input
                className="collab-input"
                placeholder="Why, or what to do instead (optional)"
                value={verdicts[d.id] ?? ''}
                onChange={(e) => setVerdicts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                data-testid={`decision-verdict-${d.id}`}
              />
              <button
                className="btn"
                onClick={() => decide(d.id, 'declined')}
                data-testid={`decision-decline-${d.id}`}
              >
                Decline
              </button>
              <button
                className="btn primary"
                onClick={() => decide(d.id, 'agreed')}
                data-testid={`decision-agree-${d.id}`}
              >
                Agree
              </button>
            </div>
          ) : (
            d.verdict && (
              <div className="collab-verdict">
                <b>You said</b> {d.verdict}
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}

interface QuestionProps {
  board: Board;
  onChange(board: Board): void;
}

export function QuestionsSection({ board, onChange }: QuestionProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const questions = [...board.questions].sort(
    (a, b) => Number(a.answeredAt !== null) - Number(b.answeredAt !== null) || b.at - a.at,
  );

  const answer = (q: Question): void => {
    const text = drafts[q.id] ?? '';
    if (text.trim() === '') return;
    onChange(answerQuestion(board, q.id, text));
    setDrafts((prev) => ({ ...prev, [q.id]: '' }));
  };

  return (
    <div className="collab" data-testid="questions-section">
      <div className="collab-intro">
        <span>
          What the agent needs from you. Each names the tasks it blocks, so the rest of the board
          stays workable — it only stops when everything left is waiting on an answer here.
        </span>
      </div>

      {questions.length === 0 && (
        <div className="collab-empty" data-testid="questions-empty">
          Nothing to answer. When your agent needs a decision it cannot make, it asks here with{' '}
          <code>question_ask</code> and carries on with something else.
        </div>
      )}

      {questions.map((q) => {
        const open = q.answeredAt === null;
        return (
          <div
            key={q.id}
            className={`collab-card question ${open ? 'open' : 'answered'}`}
            data-testid={`question-${q.id}`}
          >
            <div className="collab-head">
              <span className={`collab-status ${open ? 'proposed' : 'agreed'}`}>
                {open ? 'waiting on you' : 'answered'}
              </span>
              <span className="collab-title">{q.text}</span>
              <span className="spacer" />
              <span className="collab-meta">
                {q.by} · {ago(q.at)}
              </span>
              <button
                className="row-btn"
                title="Remove this question"
                onClick={() => onChange(deleteQuestion(board, q.id))}
                data-testid={`question-delete-${q.id}`}
              >
                ✕
              </button>
            </div>

            {q.detail && <div className="collab-body">{q.detail}</div>}

            {q.blocks.length > 0 && (
              <div className="collab-blocks">
                <b>Holds up</b>{' '}
                {q.blocks
                  .map((id) => board.tasks.find((t) => t.id === id)?.title ?? id)
                  .join(' · ')}
              </div>
            )}

            {open ? (
              <div className="collab-actions">
                <input
                  className="collab-input"
                  placeholder="Your answer — the agent picks this up over MCP"
                  value={drafts[q.id] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && answer(q)}
                  data-testid={`question-answer-input-${q.id}`}
                />
                <button
                  className="btn primary"
                  onClick={() => answer(q)}
                  data-testid={`question-answer-${q.id}`}
                >
                  Answer
                </button>
              </div>
            ) : (
              <div className="collab-verdict">
                <b>You said</b> {q.answer}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
