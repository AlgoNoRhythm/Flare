import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { agentColor } from '../graph/lenses';
import { onThemeChange } from '../theme';
import { McpConnect } from './McpConnect';
import type { CommandLogEntry } from '../../shared/types';
import { KIND_LABEL, shortenCommand, type CommandKind } from '../../shared/commands';
import { dueForHeartbeat, heartbeatState, type HeartbeatRoutine } from '../../shared/heartbeat';

interface TermInstance {
  id: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  unsubs: (() => void)[];
}

/**
 * Terminals are named per client, not per app.
 *
 * The backend keys terminals by id, and creating one that already exists kills
 * the one already there. That is harmless when a session has exactly one UI —
 * and wrong the moment Flare is served over the network, where a second
 * browser tab, or just a reload, would start counting at `term-1` again and
 * take down a terminal somebody was working in. Naming them per client keeps
 * every tab's terminals its own.
 */
const CLIENT_ID = (
  globalThis.crypto?.randomUUID?.() ?? `${Math.random()}${Date.now()}`
)
  .replace(/\W/g, '')
  .slice(0, 8);

let nextTermNumber = 1;

interface Props {
  projectRoot: string | null;
  height: number;
  /** terminal id -> detected agent CLI running inside it, if any. */
  agents?: Record<string, string | null>;
  /** shell commands observed in the terminals (newest last). */
  commands?: CommandLogEntry[];
  /**
   * Bumped by the explorer's "Open terminal here": each new value opens a
   * terminal in that directory. A counter rather than a path so asking twice
   * for the same folder still opens a second terminal.
   */
  openAt?: { dir: string; nonce: number } | null;
  /** the MCP endpoint agents in these terminals should be pointed at */
  mcp?: { port: number; slug: string | null };
  /**
   * The project's heartbeat, straight off the routine.
   *
   * Read-only here: this bar *shows* what is set and offers the way to set it,
   * but the setting itself lives in the Routine, which is one place rather
   * than two that have to agree.
   */
  heartbeat?: HeartbeatRoutine | null;
  /** open the Routine wizard — where the heartbeat is actually set */
  onOpenRoutine?(): void;
}

const KIND_HINT: Record<CommandKind, string> = {
  destructive: 'Hard to undo — a snapshot was taken when this started',
  verify: 'Proves something: tests, type checks, linters, builds',
  network: 'Reaches the network',
  write: 'Changes files, recoverably',
  read: 'Reads only',
};

/**
 * The terminal wears the app's own colours.
 *
 * Read from the stylesheet rather than restated here: the cursor is the brand
 * orange, and the selection is warm rather than the stock editor blue that
 * belonged to nothing in this app.
 */
function terminalTheme(): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string; selectionForeground: string } {
  const read = (name: string, fallback: string): string => {
    if (typeof document === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };
  const background = read('--n0', '#0c0e11');
  return {
    background,
    foreground: read('--n12', '#dfe2e8'),
    cursor: read('--accent', '#e08a52'),
    cursorAccent: background,
    selectionBackground: read('--accent-bg-strong', '#4a2c1b'),
    selectionForeground: read('--accent-pale', '#f7d6bf'),
  };
}

export function TerminalPanel({
  projectRoot,
  height,
  agents = {},
  commands = [],
  openAt = null,
  mcp,
  heartbeat = null,
  onOpenRoutine,
}: Props) {
  const [kindFilter, setKindFilter] = useState<CommandKind | null>(null);
  const [showCommands, setShowCommands] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (showCommands && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [commands.length, showCommands]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const termsRef = useRef<Map<string, TermInstance>>(new Map());
  const [termIds, setTermIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  /*
   * The heartbeat's timer half: when a terminal that was running an agent goes
   * quiet, type the chosen line into it.
   *
   * Both timestamps are refs rather than state because neither should cause a
   * render — the terminal is a canvas, and re-rendering the panel around it on
   * every tick would be a lot of work to change nothing on screen.
   */
  const agentSeenAt = useRef<Record<string, number>>({});
  const promptedAt = useRef<Record<string, number>>({});
  const heartbeatRef = useRef(heartbeat);
  heartbeatRef.current = heartbeat;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const beat = heartbeatState(heartbeat);

  useEffect(() => {
    const now = Date.now();
    for (const [id, agent] of Object.entries(agents)) {
      if (agent) agentSeenAt.current[id] = now;
    }
  }, [agents]);

  useEffect(() => {
    if (heartbeat?.heartbeat !== 'timer') return;
    const tick = (): void => {
      const due = dueForHeartbeat({
        // read live, not closed over: the routine can change while this timer
        // is already running, and switching to the hook has to take effect at
        // that moment rather than at the next mount
        routine: heartbeatRef.current,
        terminals: [...termsRef.current.keys()],
        agents: agentsRef.current,
        agentSeenAt: agentSeenAt.current,
        promptedAt: promptedAt.current,
        now: Date.now(),
      });
      for (const id of due) {
        promptedAt.current[id] = Date.now();
        // the newline is what submits it — an agent's prompt reads a line
        api.ptyWrite(id, `${heartbeatRef.current?.heartbeatCommand ?? ''}\r`);
      }
    };
    // a minute is fine: the interval being waited out is measured in tens of
    // them, and this only reads two maps
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [heartbeat?.heartbeat]);

  /*
   * xterm paints to a canvas of its own, so it is one of the three things in
   * the app that a stylesheet cannot reach. Repainting open terminals is a
   * matter of handing each one a new theme object — the scrollback is
   * untouched, so a switch mid-session does not cost you what is on screen.
   */
  useEffect(
    () =>
      onThemeChange(() => {
        for (const inst of termsRef.current.values()) inst.term.options.theme = terminalTheme();
      }),
    [],
  );

  const createTerminal = (cwd?: string) => {
    const body = bodyRef.current;
    if (!body) return;
    // a new terminal you cannot see is not a new terminal
    setShowCommands(false);
    const id = `term-${CLIENT_ID}-${nextTermNumber++}`;
    const host = document.createElement('div');
    host.className = 'terminal-host';
    host.style.display = 'none';
    body.appendChild(host);

    const term = new Terminal({
      // xterm measures the first face that resolves; a Windows-only stack fell
      // through to Courier on macOS and to whatever Fontconfig picked on Linux
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", "Liberation Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      theme: terminalTheme(),
      allowProposedApi: true,
      scrollback: 8000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const unsubs: (() => void)[] = [];
    unsubs.push(
      api.on('evt:ptyData', (payload) => {
        const p = payload as { id: string; data: string };
        if (p.id === id) term.write(p.data);
      }),
    );
    unsubs.push(
      api.on('evt:ptyExit', (payload) => {
        const p = payload as { id: string; exitCode: number };
        if (p.id === id) term.write(`\r\n\x1b[90m[process exited with code ${p.exitCode}]\x1b[0m\r\n`);
      }),
    );
    /*
     * Copy and paste, without giving up interrupt.
     *
     * Ctrl+C in a terminal means "stop the thing that is running", and with an
     * agent in here that is the one key you cannot afford to lose. So it keeps
     * that meaning — unless there is a selection, in which case there is
     * nothing to interrupt that you meant, and it copies. This is what Windows
     * Terminal and VS Code do, and Ctrl+Shift+C works either way for anyone who
     * expects the older convention.
     *
     * Paste needs the clipboard the *viewer* is sitting at. Served over the
     * network the backend's clipboard belongs to another machine entirely, so
     * the browser's own is asked first and the backend's is the fallback.
     */
    const paste = async (): Promise<void> => {
      let text = '';
      try {
        text = (await navigator.clipboard?.readText()) ?? '';
      } catch {
        // no permission, or no clipboard API — fall through
      }
      if (text === '') text = await api.clipboardRead();
      if (text !== '') api.ptyWrite(id, text);
    };

    const copySelection = (): boolean => {
      const text = term.getSelection();
      if (text === '') return false;
      void api.clipboardWrite(text);
      term.clearSelection();
      return true;
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && (e.shiftKey || term.hasSelection())) {
        if (copySelection()) {
          e.preventDefault();
          return false;
        }
        // nothing selected: let Ctrl+C through as an interrupt
        return !e.shiftKey;
      }
      if (key === 'v') {
        e.preventDefault();
        void paste();
        return false;
      }
      return true;
    });

    term.onData((data) => api.ptyWrite(id, data));
    term.onResize(({ cols, rows }) => api.ptyResize(id, cols, rows));

    const instance: TermInstance = { id, term, fit, host, unsubs };
    termsRef.current.set(id, instance);
    setTermIds((ids) => [...ids, id]);
    setActiveId(id);

    // create pty after first fit so cols/rows are right
    requestAnimationFrame(() => {
      host.style.display = 'block';
      fit.fit();
      void api.ptyCreate(id, term.cols, term.rows, cwd);
      term.focus();
    });
  };

  const closeTerminal = (id: string) => {
    const inst = termsRef.current.get(id);
    if (!inst) return;
    for (const u of inst.unsubs) u();
    void api.ptyDispose(id);
    inst.term.dispose();
    inst.host.remove();
    termsRef.current.delete(id);
    setTermIds((ids) => {
      const rest = ids.filter((t) => t !== id);
      setActiveId((cur) => (cur === id ? (rest[rest.length - 1] ?? null) : cur));
      return rest;
    });
  };

  /**
   * Dismiss the connect panel and hand the terminal back.
   *
   * The panel sits above the terminal and takes its height, so the point of
   * closing it is almost always "now let me paste this" — which needs the
   * terminal both refitted and focused, not merely revealed.
   */
  const closeConnect = () => {
    setShowConnect(false);
    const inst = activeId ? termsRef.current.get(activeId) : null;
    requestAnimationFrame(() => {
      inst?.fit.fit();
      inst?.term.focus();
    });
  };

  // Escape is the reflex for "get this out of my way"
  useEffect(() => {
    if (!showConnect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeConnect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConnect, activeId]);

  // show only the active terminal, and re-measure it whenever it comes back
  useEffect(() => {
    for (const [id, inst] of termsRef.current) {
      inst.host.style.display = id === activeId ? 'block' : 'none';
    }
    if (activeId && !showCommands) {
      const inst = termsRef.current.get(activeId);
      requestAnimationFrame(() => {
        // Returning from Commands does not change activeId, so this has to
        // depend on the view too — the terminal was display:none and xterm's
        // measured geometry is stale until it is fitted again.
        inst?.fit.fit();
        inst?.term.focus();
      });
    }
  }, [activeId, showCommands]);

  // refit on panel resize
  useEffect(() => {
    const inst = activeId && !showCommands ? termsRef.current.get(activeId) : null;
    if (inst) {
      requestAnimationFrame(() => inst.fit.fit());
    }
  }, [height, activeId, showCommands, showConnect]);

  // auto-create first terminal once a project is open
  const startedRef = useRef(false);
  useEffect(() => {
    if (projectRoot && !startedRef.current) {
      startedRef.current = true;
      createTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  const lastOpenAt = useRef(0);
  useEffect(() => {
    if (!openAt || openAt.nonce === lastOpenAt.current) return;
    lastOpenAt.current = openAt.nonce;
    createTerminal(openAt.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt]);

  useEffect(
    () => () => {
      for (const id of [...termsRef.current.keys()]) closeTerminal(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="terminal-panel" style={{ height }} data-testid="terminal-panel">
      <div className="terminal-tabs">
        {termIds.map((id, i) => (
          <div
            key={id}
            /*
             * Active only when the terminal view is the one on screen. While
             * Commands is open a terminal tab kept the same `active` styling,
             * so two tabs in one row both looked selected and clicking the
             * terminal appeared to do nothing — it set activeId behind a view
             * that was still showing the command log.
             */
            className={`tab${!showCommands && id === activeId ? ' active' : ''}${
              showCommands && id === activeId ? ' current' : ''
            }`}
            onClick={() => {
              setActiveId(id);
              setShowCommands(false);
            }}
            title={showCommands ? 'Back to this terminal' : undefined}
            data-testid={`terminal-tab-${id}`}
          >
            <span>terminal {i + 1}</span>
            {agents[id] && (
              <span
                className="agent-badge"
                data-testid={`agent-badge-${id}`}
                style={{ color: agentColor(agents[id]!), fontSize: 11 }}
              >
                ● {agents[id]}
              </span>
            )}
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(id);
              }}
            >
              ✕
            </span>
          </div>
        ))}
        <button className="btn" style={{ marginLeft: 4, padding: '1px 8px' }} onClick={() => createTerminal()} data-testid="terminal-new">
          +
        </button>
        <div
          className={`tab${showCommands ? ' active' : ''}`}
          style={{ marginLeft: 8 }}
          onClick={() => setShowCommands((s) => !s)}
          title={
            showCommands
              ? 'Back to the terminal — or click any terminal tab'
              : 'Processes started in these terminals, with what each one did. Sampled from the process tree, so commands that finish in well under a second may not appear.'
          }
          data-testid="commands-toggle"
        >
          <span>▤ Commands</span>
          {commands.length > 0 && <span className="muted">{commands.length}</span>}
        </div>

        {showCommands ? (
          <div className="cmd-filters">
            {([null, 'destructive', 'verify', 'network', 'write', 'read'] as const).map((k) => {
              const count = k === null ? commands.length : commands.filter((c) => (c.kind ?? 'read') === k).length;
              return (
                <button
                  key={k ?? 'all'}
                  className={`sev-btn${kindFilter === k ? ' active' : ''}${k === 'destructive' && count > 0 ? ' danger' : ''}`}
                  title={k === null ? 'every command' : KIND_HINT[k]}
                  onClick={() => setKindFilter(k)}
                  data-testid={`cmd-filter-${k ?? 'all'}`}
                >
                  {k === null ? 'all' : KIND_LABEL[k]} {count}
                </button>
              );
            })}
          </div>
        ) : (
          <>
            {/*
              What happens when that agent stops, beside where you start one.

              A status, not an editor: it says what is set and takes you to the
              Routine, which is the one place it is set. A second control here
              writing a second field is exactly what made this hard to find.

              Left of the connect affordance rather than right of it, because
              the risk-alert stack floats over the bottom-right corner and
              anything pushed that far along the bar stops being clickable.
            */}
            {onOpenRoutine && (
              <button
                className={`btn hb-chip${beat.mode === 'off' ? '' : ' on'}`}
                title={`${beat.detail}

Click to change it in the Routine.`}
                onClick={onOpenRoutine}
                data-testid="heartbeat-chip"
              >
                <span data-testid="heartbeat-label">
                  {beat.mode === 'off' ? '♡' : '♥'} {beat.label}
                </span>
              </button>
            )}
            <span className="muted" style={{ marginLeft: 10, fontSize: 11 }}>
              run your agent here — claude · codex · opencode
            </span>
            {mcp && mcp.port > 0 && (
              <button
                className={`btn mcp-btn${showConnect ? ' on' : ''}`}
                title="Point that agent at this project: the endpoint, and the exact setup for each of the three"
                onClick={() => setShowConnect((v) => !v)}
                data-testid="mcp-connect-toggle"
              >
                ◆ Connect agent
              </button>
            )}
          </>
        )}
      </div>
      {showConnect && mcp && mcp.port > 0 && !showCommands && (
        <McpConnect port={mcp.port} slug={mcp.slug} onClose={closeConnect} />
      )}
      <div className="terminal-body" ref={bodyRef} style={{ display: showCommands ? 'none' : 'block' }} />
      {showCommands && (
        <div className="command-log" ref={logRef} data-testid="command-log">
          {commands.length === 0 && (
            <div className="muted" style={{ padding: 10 }}>
              no commands observed yet — processes started in these terminals, by you or an agent,
              are sampled and land here
            </div>
          )}
          {commands
            .filter((c) => kindFilter === null || (c.kind ?? 'read') === kindFilter)
            .map((c, i) => {
              const kind = c.kind ?? 'read';
              return (
                <div
                  key={`${c.pid}-${c.time}-${i}`}
                  className={`command-row kind-${kind}`}
                  data-testid="command-row"
                >
                  <span className="cmd-time">{new Date(c.time).toLocaleTimeString()}</span>
                  <span className="cmd-agent" style={{ color: agentColor(c.agent ?? 'you') }}>
                    {c.agent ?? 'you'}
                  </span>
                  <span className={`cmd-kind ${kind}`} title={KIND_HINT[kind]}>
                    {KIND_LABEL[kind]}
                  </span>
                  <span className="cmd-text mono" title={c.command}>
                    {shortenCommand(c.command, 160)}
                  </span>
                  {c.outcome && (
                    <span className={`cmd-outcome ${c.outcome}`} title={c.evidence ?? 'no verdict line found'}>
                      {c.outcome}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
