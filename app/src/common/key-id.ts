import { createHash } from 'node:crypto';

/** The id of a key file: the first 16 hex characters of the SHA-256 of the key bytes. Safe to store and print. */
export function keyIdOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}
