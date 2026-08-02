import { describe, expect, it } from 'vitest';
import {
  detectAgents,
  extractNewCommands,
  splitSnapshots,
  matchAgent,
  type ProcessInfo,
} from '../electron/services/agents';

describe('matchAgent', () => {
  it('matches agent CLIs in command lines', () => {
    expect(matchAgent('node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')).toBe('claude');
    expect(matchAgent('"C:\\Program Files\\nodejs\\node.exe" /usr/local/bin/claude --continue')).toBe('claude');
    expect(matchAgent('codex.exe exec "fix the tests"')).toBe('codex');
    expect(matchAgent('/home/u/.local/bin/opencode')).toBe('opencode');
    expect(matchAgent('cmd /c ""C:\\tmp\\claude.cmd""')).toBe('claude');
  });

  it('does not match unrelated processes', () => {
    expect(matchAgent('powershell.exe')).toBeNull();
    expect(matchAgent('node build.js')).toBeNull();
    expect(matchAgent('C:\\code\\myproject\\src\\amplifier.ts')).toBeNull();
    expect(matchAgent('chrome.exe --type=renderer')).toBeNull();
  });
});

describe('detectAgents', () => {
  const processes: ProcessInfo[] = [
    { pid: 100, ppid: 1, command: 'powershell.exe' }, // terminal 1 shell
    { pid: 101, ppid: 100, command: 'node claude-code/cli.js' },
    { pid: 102, ppid: 101, command: 'node some-mcp-server.js' },
    { pid: 200, ppid: 1, command: 'powershell.exe' }, // terminal 2 shell
    { pid: 201, ppid: 200, command: 'vim notes.txt' },
    { pid: 300, ppid: 1, command: 'powershell.exe' }, // terminal 3 shell
    { pid: 301, ppid: 300, command: 'cmd /c codex.cmd' },
  ];

  it('finds agents per terminal via descendant walk', () => {
    const status = detectAgents(
      processes,
      new Map([
        ['t1', 100],
        ['t2', 200],
        ['t3', 300],
      ]),
    );
    expect(status).toEqual({ t1: 'claude', t2: null, t3: 'codex' });
  });

  it('handles missing roots gracefully', () => {
    const status = detectAgents(processes, new Map([['tX', 999]]));
    expect(status).toEqual({ tX: null });
  });
});

describe('extractNewCommands', () => {
  const roots = new Map([['t1', 100]]);
  const base: ProcessInfo[] = [
    { pid: 100, ppid: 1, command: 'powershell.exe' },
    { pid: 101, ppid: 100, command: 'node claude-code/cli.js' },
  ];

  it('reports only new descendant processes, skipping noise', () => {
    const seen = new Set(base.map((p) => p.pid));
    const next: ProcessInfo[] = [
      ...base,
      { pid: 102, ppid: 101, command: 'git status --porcelain' },
      { pid: 103, ppid: 101, command: 'C:\\WINDOWS\\system32\\conhost.exe 0x4' },
      { pid: 900, ppid: 1, command: 'notepad.exe' }, // not under a terminal
    ];
    const cmds = extractNewCommands(seen, next, roots);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ pid: 102, terminalId: 't1', command: 'git status --porcelain' });
  });

  it('reports nothing when snapshot is unchanged', () => {
    const seen = new Set(base.map((p) => p.pid));
    expect(extractNewCommands(seen, base, roots)).toHaveLength(0);
  });

  it('skips bare shells but keeps commands with arguments', () => {
    const seen = new Set([100]);
    const next: ProcessInfo[] = [
      ...base,
      { pid: 105, ppid: 100, command: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
      { pid: 106, ppid: 100, command: 'powershell.exe -Command npm test' },
    ];
    const cmds = extractNewCommands(seen, next, roots);
    const texts = cmds.map((c) => c.command);
    expect(texts).toContain('powershell.exe -Command npm test');
    expect(texts).not.toContain('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    // the agent process itself is also logged (it is a command that was run)
    expect(texts).toContain('node claude-code/cli.js');
  });
});

describe('splitSnapshots', () => {
  const END = '##END##';

  it('splits on delimiter lines and keeps the tail buffered', () => {
    const { blocks, rest } = splitSnapshots([`a`, `b`, END, `c`, END, `partial`].join(String.fromCharCode(10)));
    expect(blocks).toEqual([toBlock([`a`, `b`]), toBlock([`c`])]);
    expect(rest).toBe('partial');
  });

  it('does not split on a command line that merely contains the delimiter', () => {
    // the sampler own process used to do exactly this, cutting every snapshot
    // in half and making live processes appear to vanish
    const noisy = `1	0	powershell -Command "while(1){ Write-Output '` + END + `' }"`;
    const { blocks } = splitSnapshots([noisy, `2	1	node app.js`, END, ``].join(String.fromCharCode(10)));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('node app.js');
  });

  it('reassembles a snapshot delivered across several chunks', () => {
    const first = splitSnapshots([`1	0	a`, `2	1	`].join(String.fromCharCode(10)));
    expect(first.blocks).toHaveLength(0);
    const second = splitSnapshots(first.rest + [`b`, END, ``].join(String.fromCharCode(10)));
    expect(second.blocks).toEqual([toBlock([`1	0	a`, `2	1	b`])]);
  });
});

/** join lines the way splitSnapshots emits them: every line newline-terminated */
function toBlock(lines: string[]): string {
  return lines.map((l) => l + String.fromCharCode(10)).join('');
}
