/**
 * The updater's only way to run commands (10b spec 5.1): git and docker, through an
 * injectable Runner so the steps can be tested with a scripted fake.
 *
 * Commands run with execFile (never a shell). git goes through git.ts (no global or
 * system config, no prompts). Output is returned, never stored: callers log it with
 * maskSecrets and record only fixed failure codes (spec 5.8).
 */
import { execFile } from 'node:child_process';
import { git } from './git';

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; timeoutMs?: number; env?: Record<string, string> };

export interface Runner {
  run(cmd: 'git' | 'docker', args: string[], opts?: RunOptions): Promise<RunResult>;
}

/** docker commands that do not say otherwise: long enough for `compose up`, far short of a build (callers pass their own). */
const DEFAULT_DOCKER_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs real commands. `defaultCwd` is the Kainow folder, used when a call gives no cwd.
 * Never throws: a command that cannot start is code 127, one killed at its timeout code 124.
 * `binaries` lets a test stand in another program for docker.
 */
export class RealRunner implements Runner {
  constructor(
    private readonly defaultCwd: string,
    private readonly binaries: { docker?: string } = {},
  ) {}

  run(cmd: 'git' | 'docker', args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const cwd = opts.cwd ?? this.defaultCwd;
    if (cmd === 'git') return git(cwd, args, opts.env, opts.timeoutMs);
    return new Promise((resolve) => {
      execFile(
        this.binaries.docker ?? 'docker',
        args,
        {
          cwd,
          env: { ...process.env, ...opts.env },
          timeout: opts.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
            code = typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? 127 : e.killed ? 124 : 1;
          }
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }
}

/**
 * Hides passwords before command output reaches the log: the password of any
 * `postgres://user:password@` (or postgresql://) URL, and the value after any
 * `password=` (any case, so PGPASSWORD= too).
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:@\s/]*:)[^@\s]*@/gi, '$1***@')
    .replace(/(password=)("[^"]*"|'[^']*'|[^\s&;"']+)/gi, '$1***');
}
