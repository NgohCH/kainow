import { writeFileSync } from 'node:fs';
import { newBackupKeyBytes } from './crypto';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = 'Usage: npm run backup-key -- --create <path>';

/** Writes a new backup key file, never over an existing one. Prints only the path and the key id, never the key. Returns the exit code. */
export function runBackupKeyCli(args: string[], io: CliIo): number {
  const at = args.indexOf('--create');
  const path = at >= 0 ? args[at + 1] : undefined;
  if (!path || path.startsWith('--') || args.length !== 2) {
    io.err(USAGE);
    return 2;
  }
  const { bytes, id } = newBackupKeyBytes();
  try {
    // 'wx' fails when the file exists; 0o600 where the OS honours modes.
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    io.err(code === 'EEXIST' ? `A file already exists at ${path}; nothing was written.` : `Could not write the key file at ${path} (${code ?? 'error'}).`);
    return 1;
  }
  io.out(`Backup key written to ${path}`);
  io.out(`Key id: ${id}`);
  io.out('Keep a recovery copy apart from the backups and the database. Without it, backups cannot be restored.');
  return 0;
}

if (require.main === module) {
  process.exit(runBackupKeyCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }));
}
