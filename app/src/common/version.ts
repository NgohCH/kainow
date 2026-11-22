import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The version of the running Kainow, read from app/package.json; 'unknown' when it cannot be read. */
export function runningVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
