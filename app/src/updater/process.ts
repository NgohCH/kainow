/**
 * Runs one program for the updater (git, docker) and, at its timeout, kills the whole
 * process tree, not only the direct child: `docker compose` runs the Compose plugin as a
 * child of the docker CLI, and git starts helpers (git-remote-https, ssh, ssh-keygen).
 * An orphaned build or `up` must never keep running after the step recorded a failure.
 *
 * On Linux (where the updater runs) the child leads its own process group (detached), and
 * the group gets SIGTERM, then SIGKILL after a short grace. On Windows (developer test runs)
 * there are no process groups: `taskkill /pid <pid> /T /F` ends the tree.
 *
 * Never throws. Codes: the program's own exit code; 124 timeout; 125 output over maxBuffer
 * (the tree is killed too); 127 the program could not be started; 1 ended by a signal.
 */
import { execFile, spawn } from 'node:child_process';

export const CODE_TIMEOUT = 124;
export const CODE_OUTPUT_TOO_LARGE = 125;
export const CODE_NOT_STARTED = 127;

export type ProcessResult = { code: number; stdout: string; stderr: string };
export type ProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  /** Between SIGTERM and SIGKILL to the group (Linux). Default 5 s. */
  killGraceMs?: number;
};

function killTree(pid: number, graceMs: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      // the group is already gone
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), graceMs).unref();
}

export function runProcess(file: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let hard: NodeJS.Timeout | undefined;
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      resolve(r);
    };
    let outcome: 'timeout' | 'overflow' | null = null;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      // A synchronous spawn error (a bad argument or environment value): still never throws (final review #21).
      finish({ code: CODE_NOT_STARTED, stdout: '', stderr: '' });
      return;
    }
    const result = (): ProcessResult => {
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(err).toString();
      return { code: outcome === 'timeout' ? CODE_TIMEOUT : CODE_OUTPUT_TOO_LARGE, stdout, stderr };
    };
    const stopTree = (why: 'timeout' | 'overflow') => {
      if (outcome) return;
      outcome = why;
      const grace = opts.killGraceMs ?? 5_000;
      if (child.pid !== undefined) killTree(child.pid, grace);
      // A descendant that escaped the kill can hold the pipes open, so 'close' may never come: settle anyway shortly
      // after the grace (final review #20), so a hung tick never keeps the updater's lock.
      hard = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(result());
      }, grace + 2_000);
      hard.unref();
    };
    timer = setTimeout(() => stopTree('timeout'), opts.timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (outcome === 'overflow') return;
      size += chunk.length;
      if (size > opts.maxBuffer) {
        stopTree('overflow');
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || child.pid === undefined) {
        finish({ code: CODE_NOT_STARTED, stdout: '', stderr: '' });
      }
    });
    child.on('close', (code) => {
      if (outcome) return finish(result());
      finish({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
  });
}
