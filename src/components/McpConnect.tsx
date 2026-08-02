import { useState } from 'react';
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

export function McpConnect({ port, slug, onClose }: { port: number; slug: string | null; onClose(): void }) {
  const [target, setTarget] = useState(MCP_TARGETS[0]);
  const url = mcpUrl(port, slug);

  const copy = (text: string, what: string) => {
    void api.clipboardWrite(text);
    toast(`${what} copied`, 'success');
  };

  /**
   * Copying the setup is the last thing anyone does here — the next action is
   * pasting it, usually into the terminal this panel is sitting on top of. So
   * copying dismisses the panel and hands the terminal back rather than
   * leaving it covered and waiting to be closed.
   */
  const copyAndClose = () => {
    copy(target.snippet(url), `${target.label} setup`);
    onClose();
  };

  return (
    <div className="mcp-connect" data-testid="mcp-connect">
      <div className="mcp-row">
        <span className="mcp-cap">Endpoint</span>
        <code className="mcp-url" data-testid="mcp-url">
          {url}
        </code>
        <button className="btn" onClick={() => copy(url, 'Endpoint URL')} data-testid="mcp-copy-url">
          Copy URL
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose} title="Close (Esc)" data-testid="mcp-close">
          ✕ Close
        </button>
      </div>

      <div className="mcp-row">
        <span className="mcp-cap">Setup</span>
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
        <span className="mcp-where">{target.where}</span>
        <span className="spacer" />
        <button
          className="btn primary"
          title="Copy the snippet and close this, so the terminal is ready to paste into"
          onClick={copyAndClose}
          data-testid="mcp-copy-snippet"
        >
          Copy &amp; close
        </button>
      </div>

      <pre className="mcp-snippet" data-testid="mcp-snippet">
        {target.snippet(url)}
      </pre>
    </div>
  );
}
