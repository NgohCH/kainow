import { runCreateKeyFileCli, type CliIo } from '../common/key-file-cli';
import { newBackupKeyBytes } from './crypto';

export type { CliIo };

/** Writes a new backup key file, never over an existing one. Prints only the path and the key id, never the key. Returns the exit code. */
export function runBackupKeyCli(args: string[], io: CliIo): number {
  return runCreateKeyFileCli(args, io, {
    usage: 'Usage: npm run backup-key -- --create <path>',
    label: 'Backup key',
    advice: 'Keep a recovery copy apart from the backups and the database. Without it, backups cannot be restored.',
    newKey: newBackupKeyBytes,
  });
}

if (require.main === module) {
  process.exit(runBackupKeyCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }));
}
