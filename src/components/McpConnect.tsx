import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from './Toasts';

/**
 * How to point an agent at this project's MCP endpoint.
 *
 * The status bar has always been able to copy a `claude mcp add` line, but
 * that is one of three agents this app is built around — the terminal's own
 * hint says "claude · codex · opencode" — and the other two are not commands,
 * they are config files in different formats and different places. Guessing
 * either is worse than no help at all, so both are spelled out.
 */
export interface McpTarget {
  id: string;
  label: string;
  /** where the snippet goes; empty for a shell command */
  where: string;
  snippet(url: string): string;
}

export const MCP_TARGETS: McpTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    where: 'run in a shell',
    snippet: (url) => `claude mcp add --transport http flare ${url}`,
  },
  {
    id: 'codex',
    label: 'Codex',
    where: '~/.codex/config.toml',
    // the features block is only needed by older builds, but it is harmless on
    // new ones and leaving it out is the failure people actually hit
    snippet: (url) =>
      `[features]\nexperimental_use_rmcp_client = true\n\n[mcp_servers.flare]\nurl = "${url}"`,
  },
  {
    id: 'opencode',
    label: 'opencode',
    where: 'opencode.json',
    snippet: (url) =>
      `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "flare": {\n      "type": "remote",\n      "url": "${url}",\n      "enabled": true\n    }\n  }\n}`,
  },
];

/** The project-scoped URL, which is the one that keeps working with several windows open. */
export function mcpUrl(port: number, slug: string | null): string {
  return `http://127.0.0.1:${port}/mcp${slug ? `/${slug}` : ''}`;
}

/**
 * The first thing to say to a fresh agent.
 *
 * Registering the server only makes the tools *reachable*; it does not make
 * the agent read any of them, and everything this project does — taking a card
 * before starting it, announcing files in the channel, writing the session
 * down before it stops — lives behind `working_agreement`. One call fetches
 * all of it, so the whole of the setup a human should have to explain is: call
 * that first.
 *
 * Which is why the prompt is short. A paragraph restating the protocol would
 * be a second copy of it, going stale the moment the routine changes, and the
 * agent is about to be handed the current version by the tool itself.
 */
export function agentPrompt(url: string): string {
  return [
    `This project is open in Flare, which is on MCP at ${url}.`,
    '',
    'Start by calling `working_agreement` — it says how this project wants you to work, what is on the board, and who else is in here. Then take the card it points you at.',
  ].join('\n');
}

interface Props {
  port: number;
  slug: string | null;
  onClose(): void;
}

/**
 * Connecting an agent, as a dialog rather than a strip.
 *
 * It was a panel wedged above the terminal, which gave it one line per thing
 * it had to say and no room for the part that matters most — the sentence you
 * paste into the agent afterwards. Two steps, and they are genuinely two:
 * **register the server**, which is a config change you make once per machine,
 * and **start the agent**, which is a message you send every session. Copying
 * the first without the second is the mistake this dialog exists to stop —
 * an agent with the tools attached and no idea it is meant to read them.
 */
export function McpConnect({ port, slug, onClose }: Props) {
  const [target, setTarget] = useState(MCP_TARGETS[0]);
  const url = mcpUrl(port, slug);
  const prompt = agentPrompt(url);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const copy = (text: string, what: string) => {
    void api.clipboardWrite(text);
    toast(`${what} copied`, 'success');
  };

  return (
    <div
      className="modal-backdrop"
      data-testid="mcp-backdrop"
      onMouseDown={(e) => {
        // only a click that both starts and ends on the backdrop dismisses:
        // dragging a selection out of a snippet must not close it
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal mcp-modal"
        data-testid="mcp-connect"
        role="dialog"
        aria-modal="true"
        aria-label="Connect an agent"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="mcp-head">
          <h2>Connect an agent</h2>
          <span className="spacer" />
          <button className="row-btn" onClick={onClose} title="Close (Esc)" data-testid="mcp-close">
            ✕
          </button>
        </div>

        <div className="mcp-endpoint">
          <span className="mcp-cap">Endpoint</span>
          <code className="mcp-url" data-testid="mcp-url">
            {url}
          </code>
          <button className="btn" onClick={() => copy(url, 'Endpoint URL')} data-testid="mcp-copy-url">
            Copy
          </button>
        </div>

        {/* ---- 1: the config change, once per machine ---- */}
        <div className="mcp-step">
          <div className="mcp-step-head">
            <span className="mcp-num">1</span>
            <b>Register the server</b>
            <span className="mcp-targets">
              {MCP_TARGETS.map((t) => (
                <button
                  key={t.id}
                  className={`sev-btn${t.id === target.id ? ' active' : ''}`}
                  onClick={() => setTarget(t)}
                  data-testid={`mcp-target-${t.id}`}
                >
                  {t.label}
                </button>
              ))}
            </span>
            <span className="spacer" />
            <span className="mcp-where">{target.where}</span>
            <button
              className="btn"
              onClick={() => copy(target.snippet(url), `${target.label} setup`)}
              data-testid="mcp-copy-snippet"
            >
              Copy
            </button>
          </div>
          <pre className="mcp-snippet" data-testid="mcp-snippet">
            {target.snippet(url)}
          </pre>
        </div>

        {/* ---- 2: the message, every session ---- */}
        <div className="mcp-step">
          <div className="mcp-step-head">
            <span className="mcp-num">2</span>
            <b>Say this to the agent</b>
            <span className="spacer" />
            <button
              className="btn primary"
              title="Copy the opening message and close this, so the terminal is ready to paste into"
              onClick={() => {
                copy(prompt, 'Opening prompt');
                onClose();
              }}
              data-testid="mcp-copy-prompt"
            >
              Copy &amp; close
            </button>
          </div>
          <pre className="mcp-snippet prompt" data-testid="mcp-prompt">
            {prompt}
          </pre>
          <div className="mcp-note">
            Attaching the tools does not make an agent read them. This one line does: everything the
            project expects — taking a card before starting it, saying in the channel which files it
            is about to edit, writing the session down before it stops — comes back from that single
            call, in whatever state your ⚙︎ Routine is in right now.
          </div>
        </div>
      </div>
    </div>
  );
}
