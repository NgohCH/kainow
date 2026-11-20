import { writeFileSync } from 'node:fs';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface KeyFileCliOptions {
  usage: string;
  /** Names the key in the first output line, e.g. "Protected key". */
  label: string;
  /** Last output line: why the operator must keep a recovery copy. */
  advice: string;
  newKey(): { bytes: Buffer; id: string };
}

/** `--create <path>`: writes a new key file, never over an existing one. Prints only the path and the key id, never the key. Returns the exit code. */
export function runCreateKeyFileCli(args: string[], io: CliIo, opts: KeyFileCliOptions): number {
  const at = args.indexOf('--create');
  const path = at >= 0 ? args[at + 1] : undefined;
  if (!path || path.startsWith('--') || args.length !== 2) {
    io.err(opts.usage);
    return 2;
  }
  const { bytes, id } = opts.newKey();
  try {
    // 'wx' fails when the file exists; 0o600 where the OS honours modes.
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    io.err(code === 'EEXIST' ? `A file already exists at ${path}; nothing was written.` : `Could not write the key file at ${path} (${code ?? 'error'}).`);
    return 1;
  }
  io.out(`${opts.label} written to ${path}`);
  io.out(`Key id: ${id}`);
  io.out(opts.advice);
  return 0;
}
