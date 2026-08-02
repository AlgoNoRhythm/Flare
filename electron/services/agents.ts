import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Agent-agnostic activity detection: we own the terminals, so we watch each
 * PTY's process tree for known coding-agent CLIs (claude, codex, opencode, …).
 * Works for any agent without cooperation from it; richer per-tool adapters
 * can layer on top later.
 */

const agentRe = (token: string) =>
  new RegExp(`(^|[\\\\/\\s"'])${token}(\\.(exe|cmd|ps1|js|mjs))?(["'\\s\\\\/]|$)`, 'i');

export const AGENT_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'claude', re: agentRe('claude(-code)?') },
  { name: 'codex', re: agentRe('codex') },
  { name: 'opencode', re: agentRe('opencode') },
  { name: 'aider', re: agentRe('aider') },
  { name: 'gemini', re: agentRe('gemini') },
  { name: 'goose', re: agentRe('goose') },
  { name: 'amp', re: agentRe('amp') },
];

export function matchAgent(commandLine: string): string | null {
  for (const { name, re } of AGENT_PATTERNS) {
    if (re.test(commandLine)) return name;
  }
  return null;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Find the agent (if any) running under each root pid. Pure — unit-testable. */
export function detectAgents(
  processes: ProcessInfo[],
  roots: Map<string, number>,
): Record<string, string | null> {
  const children = new Map<number, ProcessInfo[]>();
  for (const p of processes) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const result: Record<string, string | null> = {};
  for (const [termId, rootPid] of roots) {
    let found: string | null = null;
    const queue = [...(children.get(rootPid) ?? [])];
    const seen = new Set<number>();
    while (queue.length > 0 && !found) {
      const proc = queue.shift()!;
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      found = matchAgent(proc.command);
      if (!found) queue.push(...(children.get(proc.pid) ?? []));
    }
    result[termId] = found;
  }
  return result;
}

/** Noise we never log as "commands": terminals' own plumbing. */
const COMMAND_IGNORE_RE =
  /conhost\.exe|OpenConsole\.exe|winpty|WmiPrvSE|\\cmd\.exe["']?\s*$|powershell\.exe["']?\s*$|pwsh\.exe["']?\s*$|^-?(bash|zsh|sh|fish)$/i;

export interface CommandEvent {
  pid: number;
  terminalId: string;
  command: string;
  time: number;
}

/**
 * Diff a process snapshot against previously seen pids: any new process under
 * a terminal's tree is a command that was executed there. Pure — unit-testable.
 */
export function extractNewCommands(
  seenPids: Set<number>,
  processes: ProcessInfo[],
  roots: Map<string, number>,
  /** pids already reported and not yet confirmed dead — never report twice */
  tracked: ReadonlySet<number> = new Set(),
): CommandEvent[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const p of processes) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: CommandEvent[] = [];
  const now = Date.now();
  for (const [terminalId, rootPid] of roots) {
    const queue = [...(children.get(rootPid) ?? [])];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const proc = queue.shift()!;
      if (visited.has(proc.pid)) continue;
      visited.add(proc.pid);
      queue.push(...(children.get(proc.pid) ?? []));
      if (seenPids.has(proc.pid) || tracked.has(proc.pid)) continue;
      if (proc.command.trim() === '' || COMMAND_IGNORE_RE.test(proc.command)) continue;
      out.push({ pid: proc.pid, terminalId, command: proc.command.trim(), time: now });
    }
  }
  return out;
}

/**
 * One persistent shell process that emits process snapshots every ~1.2s —
 * far cheaper than spawning powershell per poll, and fast enough to catch
 * most commands agents run.
 */
/**
 * The snapshot delimiter. The sampler is itself a process, so its own command
 * line shows up in every snapshot — which means the delimiter must never
 * appear *literally* in the command that produces it, or each snapshot gets
 * split in half at our own process's line. Both shells below therefore build
 * this string by concatenation.
 */
const SNAPSHOT_END = '##END##';

/**
 * Split a stream of sampler output into complete snapshots. A boundary is a
 * line that is *only* the delimiter: a process whose command line contains it
 * (the sampler's own, historically) must not cut a snapshot in half.
 */
export function splitSnapshots(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let block = '';
  let nl: number;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim() === SNAPSHOT_END) {
      blocks.push(block);
      block = '';
    } else {
      block += `${line}\n`;
    }
  }
  return { blocks, rest: block + rest };
}

export class ProcessSampler {
  private child: ChildProcess | null = null;
  private buffer = '';

  constructor(
    private onSnapshot: (processes: ProcessInfo[]) => void,
    private intervalMs = 1200,
  ) {}

  /**
   * Change the cadence, restarting the sampler only if it actually moved.
   *
   * The sleep is baked into the shell loop, so this respawns — ~200ms, paid
   * on a mode change and nothing else.
   */
  setInterval(ms: number): void {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (this.child) this.start();
  }

  start(): void {
    this.stop();
    const seconds = Math.max(0.05, this.intervalMs / 1000);
    if (process.platform === 'win32') {
      this.child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$d = '##' + 'END' + '##'; while($true){ Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,Name | ForEach-Object { $c = if ($_.CommandLine) { $_.CommandLine } else { $_.Name }; "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$c" }; Write-Output $d; Start-Sleep -Milliseconds ${Math.round(seconds * 1000)} }`,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } else {
      this.child = spawn(
        'sh',
        [
          '-c',
          `d="##EN""D##"; while true; do ps -eo pid=,ppid=,args= | awk '{printf "%s\\t%s\\t", $1, $2; for(i=3;i<=NF;i++) printf "%s ", $i; print ""}'; echo "$d"; sleep ${seconds}; done`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
    }
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      const { blocks, rest } = splitSnapshots(this.buffer + chunk);
      this.buffer = rest;
      for (const block of blocks) this.onSnapshot(parseTabbed(block));
      // guard against runaway buffers if the delimiter never arrives
      if (this.buffer.length > 8 * 1024 * 1024) this.buffer = '';
    });
    this.child.on('exit', () => {
      this.child = null;
    });
  }

  stop(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // already dead
      }
      this.child = null;
    }
  }
}

function parseTabbed(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length >= 2) {
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) {
        out.push({ pid, ppid, command: parts.slice(2).join('\t') });
      }
    }
  }
  return out;
}

const ACTIVE_WINDOW_MS = 10_000;
/** Sleep between samples while an agent is working, and while it is not. */
const ACTIVE_POLL_MS = 150;
const IDLE_POLL_MS = 1200;

export interface LoggedCommand extends CommandEvent {
  agent: string | null;
}

export class AgentMonitor {
  private sampler: ProcessSampler | null = null;
  private idlePollMs = IDLE_POLL_MS;
  private lastStatus: Record<string, string | null> = {};
  /** agent name -> last seen running (epoch ms). */
  private lastSeen = new Map<string, number>();
  private seenPids = new Set<number>();
  /** pids of commands we reported, so we can also report when they finish */
  private liveCommandPids = new Set<number>();
  /** pid -> consecutive samples it has been absent from */
  private missedSamples = new Map<number, number>();
  private firstSnapshot = true;

  constructor(
    private getRoots: () => Map<string, number>,
    private onStatus: (status: Record<string, string | null>) => void,
    private onCommand?: (command: LoggedCommand) => void,
    /** a previously-reported command's process has exited */
    private onCommandEnd?: (pid: number) => void,
  ) {}

  start(intervalMs = IDLE_POLL_MS): void {
    this.stop();
    this.idlePollMs = intervalMs;
    this.sampler = new ProcessSampler((processes) => this.handleSnapshot(processes), intervalMs);
    this.sampler.start();
  }

  /**
   * Poll hard while an agent is working, idle the rest of the time.
   *
   * A command is only in the log if it was alive across a sample boundary, so
   * the cadence *is* the capture rate — at the old fixed 1.2s sleep (a ~1.6s
   * cycle once the WMI query is counted) only commands over ~1.5s were logged,
   * which measured as one in eight of a realistic mix. The query costs ~400ms
   * whatever we do, so sampling this hard all day is not free; it is worth it
   * exactly while an agent is running, and pointless while nothing is.
   */
  private retune(): void {
    const busy = this.liveCommandPids.size > 0 || this.attribution() !== 'you';
    this.sampler?.setInterval(busy ? ACTIVE_POLL_MS : this.idlePollMs);
  }

  stop(): void {
    this.sampler?.stop();
    this.sampler = null;
  }

  private handleSnapshot(processes: ProcessInfo[]): void {
    // a truncated or dropped sample would look like "everything exited and
    // then started again"; a real machine always has processes
    if (processes.length === 0) return;
    const roots = this.getRoots();
    const status = roots.size > 0 ? detectAgents(processes, roots) : {};
    const now = Date.now();
    for (const agent of Object.values(status)) {
      if (agent) this.lastSeen.set(agent, now);
    }
    if (JSON.stringify(status) !== JSON.stringify(this.lastStatus)) {
      this.lastStatus = status;
      this.onStatus(status);
    }
    if (!this.firstSnapshot && roots.size > 0 && this.onCommand) {
      for (const cmd of extractNewCommands(this.seenPids, processes, roots, this.liveCommandPids)) {
        this.liveCommandPids.add(cmd.pid);
        this.missedSamples.delete(cmd.pid);
        this.onCommand({ ...cmd, agent: status[cmd.terminalId] ?? null });
      }
    }
    const alive = new Set(processes.map((p) => p.pid));
    // a tracked pid that vanished has exited: that is when its output is
    // complete and a verdict can be read from it
    if (this.onCommandEnd) {
      for (const pid of this.liveCommandPids) {
        if (alive.has(pid)) {
          this.missedSamples.delete(pid);
          continue;
        }
        // require two consecutive misses: one flaky sample must not end a
        // command that is still running (and re-open it as a new one)
        const misses = (this.missedSamples.get(pid) ?? 0) + 1;
        if (misses < 2) {
          this.missedSamples.set(pid, misses);
          continue;
        }
        this.missedSamples.delete(pid);
        this.liveCommandPids.delete(pid);
        this.onCommandEnd(pid);
      }
    }
    this.seenPids = alive;
    this.firstSnapshot = false;
    this.retune();
  }

  /** Who should a change burst landing now be attributed to? */
  attribution(): string {
    const now = Date.now();
    const active = [...this.lastSeen.entries()]
      .filter(([, t]) => now - t < ACTIVE_WINDOW_MS)
      .map(([name]) => name);
    if (active.length === 0) return 'you';
    if (active.length === 1) return active[0];
    return 'mixed';
  }
}
