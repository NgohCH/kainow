/**
 * Drill step 7 (spec 8.1): in the drill's temporary database, open one sealed value of each kind with the mounted
 * protected key, using each kind's own open path and additional data, and discard the plain value at once.
 * Results are Passed, Failed or Not tested; details are fixed texts, never a value, a key or an error message.
 */
import type { Pool, PoolClient } from 'pg';
import { keyReadable } from '../ai/key-check';
import type { Provider } from '../ai/keys';
import type { ProtectedKey } from '../quarantine/protected-key';
import { storageSecretReadable } from '../storage/secret';

export type CheckName =
  | 'set_checksums'
  | 'decrypt'
  | 'migration_level'
  | 'space'
  | 'restore'
  | 'row_counts'
  | 'source_files'
  | 'sealed_ai_key'
  | 'sealed_quarantine'
  | 'sealed_storage_secret'
  | 'duration';

export type Check = { name: CheckName; result: 'passed' | 'failed' | 'not_tested'; detail?: string };

type Db = Pick<Pool | PoolClient, 'query'>;

export const SEALED_TEXT = {
  none: 'None present.',
  noKey: 'A sealed value is present, but no protected key is mounted.',
  otherKey: 'A sealed value is present, but it was sealed with another protected key.',
  unreadable: 'A sealed value could not be opened with the mounted protected key.',
  opened: 'One sealed value opened with the mounted protected key.',
} as const;

const UNDEFINED_TABLE = '42P01';

/** The row, or null when there is none or the table is not in this database (an older backup). */
async function oneRow<T>(db: Db, sql: string): Promise<T | null> {
  try {
    return ((await db.query(sql)).rows[0] as T | undefined) ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

type AiKeyRow = { ciphertext: Buffer; nonce: Buffer; tag: Buffer; key_id: string; connection_id: string; project_id: string; provider: Provider };

async function aiKey(db: Db, key: ProtectedKey | null): Promise<Check> {
  const row = await oneRow<AiKeyRow>(
    db,
    `SELECT k.ciphertext, k.nonce, k.tag, k.key_id, c.id AS connection_id, c.project_id, m.provider
       FROM ai_connection_keys k
       JOIN ai_connections c ON c.id = k.connection_id
       JOIN ai_models m ON m.id = c.model_ref
      WHERE k.superseded_at IS NULL
      ORDER BY k.saved_at DESC, k.id DESC
      LIMIT 1`,
  );
  const name = 'sealed_ai_key';
  if (!row) return { name, result: 'not_tested', detail: SEALED_TEXT.none };
  if (!key) return { name, result: 'failed', detail: SEALED_TEXT.noKey };
  if (row.key_id !== key.id) return { name, result: 'failed', detail: SEALED_TEXT.otherKey };
  let ok = false;
  try {
    // The AI key's own open path (ai/key-check.ts), with its binding as additional data; nothing is kept.
    ok = keyReadable(key, { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag, keyId: row.key_id }, {
      connectionId: row.connection_id,
      projectId: row.project_id,
      provider: row.provider,
    });
  } catch {
    ok = false;
  }
  return ok ? { name, result: 'passed', detail: SEALED_TEXT.opened } : { name, result: 'failed', detail: SEALED_TEXT.unreadable };
}

type OriginalRow = { ciphertext: Buffer; nonce: Buffer; tag: Buffer; key_id: string };

async function quarantineOriginal(db: Db, key: ProtectedKey | null): Promise<Check> {
  const row = await oneRow<OriginalRow>(
    db,
    `SELECT ciphertext, nonce, tag, key_id FROM quarantine_originals ORDER BY sweep DESC, id DESC LIMIT 1`,
  );
  const name = 'sealed_quarantine';
  if (!row) return { name, result: 'not_tested', detail: SEALED_TEXT.none };
  if (!key) return { name, result: 'failed', detail: SEALED_TEXT.noKey };
  if (row.key_id !== key.id) return { name, result: 'failed', detail: SEALED_TEXT.otherKey };
  try {
    // Quarantine originals are sealed without additional data (quarantine/clean.ts); the plain value is dropped here.
    key.decrypt({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag }).fill(0);
    return { name, result: 'passed', detail: SEALED_TEXT.opened };
  } catch {
    return { name, result: 'failed', detail: SEALED_TEXT.unreadable };
  }
}

type SecretRow = { ciphertext: Buffer; nonce: Buffer; tag: Buffer; key_id: string };

/** Sub-project 9's storage connection secret (the current one), opened with its binding as additional data. */
async function storageSecret(db: Db, key: ProtectedKey | null): Promise<Check> {
  const row = await oneRow<SecretRow>(
    db,
    `SELECT ciphertext, nonce, tag, key_id FROM storage_connection_secrets WHERE superseded_at IS NULL ORDER BY saved_at DESC, id DESC LIMIT 1`,
  );
  const name = 'sealed_storage_secret';
  if (!row) return { name, result: 'not_tested', detail: SEALED_TEXT.none };
  if (!key) return { name, result: 'failed', detail: SEALED_TEXT.noKey };
  if (row.key_id !== key.id) return { name, result: 'failed', detail: SEALED_TEXT.otherKey };
  let ok = false;
  try {
    ok = storageSecretReadable(key, { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag, keyId: row.key_id });
  } catch {
    ok = false;
  }
  return ok ? { name, result: 'passed', detail: SEALED_TEXT.opened } : { name, result: 'failed', detail: SEALED_TEXT.unreadable };
}

/** One check per sealed kind, in a fixed order. */
export async function sealedChecks(drillDb: Db, protectedKey: ProtectedKey | null): Promise<Check[]> {
  return [await aiKey(drillDb, protectedKey), await quarantineOriginal(drillDb, protectedKey), await storageSecret(drillDb, protectedKey)];
}
