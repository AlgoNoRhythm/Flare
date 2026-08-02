import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git with args; never throws — returns exit code instead. */
export function runGit(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const rawCode: unknown = err ? (err as { code?: unknown }).code ?? 1 : 0;
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          code: typeof rawCode === 'number' ? rawCode : 1,
        });
      },
    );
  });
}
