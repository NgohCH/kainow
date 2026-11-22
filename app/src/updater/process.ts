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
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let outcome: 'timeout' | 'overflow' | null = null;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stopTree = (why: 'timeout' | 'overflow') => {
      if (outcome) return;
      outcome = why;
      if (child.pid !== undefined) killTree(child.pid, opts.killGraceMs ?? 5_000);
    };
    const timer = setTimeout(() => stopTree('timeout'), opts.timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (outcome === 'overflow') return;
      size += chunk.length;
      if (size > opts.maxBuffer) {
        stopTree('overflow');
        return;
      }
      into.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || child.pid === undefined) {
        finish({ code: CODE_NOT_STARTED, stdout: '', stderr: '' });
      }
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(err).toString();
      if (outcome === 'timeout') return finish({ code: CODE_TIMEOUT, stdout, stderr });
      if (outcome === 'overflow') return finish({ code: CODE_OUTPUT_TOO_LARGE, stdout, stderr });
      finish({ code: code ?? 1, stdout, stderr });
    });
  });
}
