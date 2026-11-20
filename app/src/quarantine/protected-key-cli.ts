import { runCreateKeyFileCli, type CliIo } from '../common/key-file-cli';
import { newKeyBytes } from './protected-key';

export type { CliIo };

/** Writes a new key file, never over an existing one. Prints only the path and the key id, never the key. Returns the exit code. */
export function runProtectedKeyCli(args: string[], io: CliIo): number {
  return runCreateKeyFileCli(args, io, {
    usage: 'Usage: npm run protected-key -- --create <path>',
    label: 'Protected key',
    advice: 'Keep a recovery copy apart from the database backups. Without it, quarantined originals cannot be restored.',
    newKey: newKeyBytes,
  });
}

if (require.main === module) {
  process.exit(runProtectedKeyCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }));
}
