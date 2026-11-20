/**
 * The backup set format (spec 5.1): a plain backup.json summary, an encrypted manifest and an encrypted dump.
 * The drill, restore and 10b's updater read sets through readSet.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import { type BackupKey, decryptStream, sha256Stream } from './crypto';

export const SET_FILES = { summary: 'backup.json', dump: 'database.dump.enc', manifest: 'manifest.json.enc' } as const;

export type BackupKind = 'daily' | 'manual' | 'pre_update';

export type Manifest = {
  formatVersion: 1;
  runId: string;
  tables: { schema: string; table: string; rows: number }[];
  sourceFiles: { sha256: string; size: number; storedFileId: string; copied: boolean; reason?: string }[];
  sourceArea: 'included' | 'not_in_use';
};

/** backup.json: nothing sensitive, so an operator can see what a set is without the key. */
export type BackupSummary = {
  formatVersion: 1;
  runId: string;
  kind: BackupKind;
  startedAt: string;
  finishedAt: string;
  keyId: string;
  kainowVersion: string;
  migrationLevel: string;
  databaseBytes: number;
  fileCount: number;
  sourceArea: Manifest['sourceArea'];
  /** SHA-256 of each encrypted file as written; the dump's plain SHA-256 is recorded too (spec 5.2). */
  files: {
    'database.dump.enc': { sha256: string; bytes: number; plainSha256: string };
    'manifest.json.enc': { sha256: string; bytes: number };
  };
};

/** Copies the source area's files into the shared file store (spec 5.4). Task 15 provides it. */
export interface SourceFileCopier {
  copyAll(pool: Pool, key: BackupKey, filesDir: string): Promise<Manifest['sourceFiles']>;
}

export class SetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetReadError';
  }
}

/** Decrypts a whole encrypted file into memory (for the manifest, which is small), checking the stored hash. */
export async function decryptFile(path: string, key: BackupKey): Promise<{ plain: Buffer; sha256: string }> {
  const hash = sha256Stream();
  const parts: Buffer[] = [];
  await pipeline(
    createReadStream(path),
    hash,
    decryptStream(key),
    new Writable({
      write(chunk: Buffer, _e, cb) {
        parts.push(chunk);
        cb();
      },
    }),
  );
  return { plain: Buffer.concat(parts), sha256: hash.digest() };
}

/**
 * Reads a finished set: its summary, and its manifest decrypted and checked against the summary's hash.
 * Throws SetReadError (fixed text) or BackupCryptoError; neither message names a path.
 */
export async function readSet(dir: string, key: BackupKey): Promise<{ summary: BackupSummary; manifest: Manifest }> {
  let summary: BackupSummary;
  try {
    summary = JSON.parse(await readFile(join(dir, SET_FILES.summary), 'utf8')) as BackupSummary;
  } catch {
    throw new SetReadError('The backup set has no readable backup.json.');
  }
  if (summary.formatVersion !== 1) throw new SetReadError('The backup set has an unknown format version.');
  let read: { plain: Buffer; sha256: string };
  try {
    read = await decryptFile(join(dir, SET_FILES.manifest), key);
  } catch (err) {
    if (err instanceof Error && err.name === 'BackupCryptoError') throw err;
    throw new SetReadError('The backup set manifest could not be read.');
  }
  if (read.sha256 !== summary.files[SET_FILES.manifest]?.sha256) {
    throw new SetReadError('The backup set manifest does not match its summary.');
  }
  const manifest = JSON.parse(read.plain.toString('utf8')) as Manifest;
  if (manifest.formatVersion !== 1 || manifest.runId !== summary.runId) {
    throw new SetReadError('The backup set manifest does not match its summary.');
  }
  return { summary, manifest };
}
