/**
 * The updater's tick (10b spec 5.2, 7.1): started by the server's cron every five
 * minutes. It takes its own advisory lock (a session lock, separate from the backup
 * lock and from the updates service's transaction lock), does at most one thing, and
 * records that it ran in `updater_ticks` (diagnostic, D115):
 *
 *   approved, or preparing left by a tick that died  → prepare (Task 8)
 *   ready, and its start time reached                → install (Task 9)
 *   installing, found with the lock free             → install again (re-entry, Task 9)
 *   failed_after_migration | failed_needs_attention  → the operator's recovery line, once a day
 *
 * A tick that finds the lock held stops at once and records nothing.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { workingTreeState } from './git';
import { maskSecrets, type Runner } from './runner';
import { OPEN_STATES, type UpdateState } from './states';

export type TickDid = 'nothing' | 'prepared' | 'installed' | 'failed' | 'busy' | 'remind_recovery';

/** The update a tick acts on, as read under its row lock. Steps load anything else they need by id. */
export interface TickUpdate {
  id: string;
  state: UpdateState;
  fromVersion: string;
  toVersion: string;
  tag: string;
  commit: string;
  tagObject: string | null;
  startsAt: Date;
  expectedMinutes: number;
  preUpdateBackupRunId: string | null;
}

export interface TickDeps {
  pool: Pool;
  runner: Runner;
  /** The Kainow folder (the same absolute path inside the container as on the host). */
  installDir: string;
  now: () => Date;
  log: (line: string) => void;
  prepare: (u: TickUpdate) => Promise<void>;
  install: (u: TickUpdate) => Promise<void>;
}

const RECOVERY_STATES: readonly UpdateState[] = ['failed_after_migration', 'failed_needs_attention'];
const DAY_MS = 24 * 60 * 60_000;
const RECOVER_COMMAND = 'docker compose --profile updater run --rm updater node dist/updater/updater-cli.js recover';
/** The trusted release signers file in the Kainow folder (spec 4.3). */
export const TRUSTED_SIGNERS = 'release-signers';

/** The operator's message after a failed update (spec 5.7 step 4), repeated by later ticks once a day. */
export function recoveryLine(state: 'failed_after_migration' | 'failed_needs_attention', tag: string): string {
  const what =
    state === 'failed_after_migration'
      ? `The update to ${tag} failed after the database migration started.`
      : `The update to ${tag} failed, and going back to the previous version did not pass its health checks.`;
  return `${what} Kainow is stopped and shows a notice page. Run: ${RECOVER_COMMAND}. See INSTALL.md, 'After a failed update'.`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The key type a public key blob names (its first length-prefixed string), or null. */
function blobKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len === 0 || len > 64 || blob.length < 4 + len) return null;
  return blob.subarray(4, 4 + len).toString('latin1');
}

/**
 * SHA256 fingerprints (as `ssh-keygen -lf` prints them) of every key in an allowed-signers
 * text, joined with ", "; null when there is none. Computed here because `ssh-keygen -lf`
 * does not read the allowed-signers format (principals and options before the key).
 */
export function signersFingerprint(text: string): string | null {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const b64 = tokens[i + 1];
      if (!BASE64.test(b64)) continue;
      const blob = Buffer.from(b64, 'base64');
      if (blobKeyType(blob) !== tokens[i]) continue;
      out.push(`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`);
      break;
    }
  }
  return out.length ? out.join(', ') : null;
}

async function fingerprintOf(installDir: string): Promise<string | null> {
  try {
    return signersFingerprint(await readFile(join(installDir, TRUSTED_SIGNERS), 'utf8'));
  } catch {
    return null; // no trusted file yet (an installation made before the first release)
  }
}

async function runningTagOf(installDir: string): Promise<string | null> {
  try {
    return (await workingTreeState(installDir)).headTag;
  } catch {
    return null; // not a git checkout, or git failed: the tick still records
  }
}

const toTickUpdate = (r: Record<string, any>): TickUpdate => ({
  id: r.id,
  state: r.state,
  fromVersion: r.from_version,
  toVersion: r.to_version,
  tag: r.tag,
  commit: r.commit,
  tagObject: r.tag_object,
  startsAt: r.starts_at,
  expectedMinutes: r.expected_minutes,
  preUpdateBackupRunId: r.pre_update_backup_run_id,
});

const COLUMNS = `id, state, from_version, to_version, tag, commit, tag_object, starts_at, expected_minutes, pre_update_backup_run_id, finished_at`;

/**
 * The update to act on: the open one, read under the updates service's lock and its row
 * lock, so an update cancelled or rescheduled a moment ago is seen as it now is; otherwise
 * the latest update (for the recovery line).
 */
async function pickUpdate(pool: Pool): Promise<{ u: TickUpdate; finishedAt: Date | null } | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
    let r = (
      await c.query(
        `SELECT ${COLUMNS} FROM updates WHERE state = ANY($1::text[]) ORDER BY approved_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [OPEN_STATES],
      )
    ).rows[0];
    if (!r) r = (await c.query(`SELECT ${COLUMNS} FROM updates ORDER BY approved_at DESC, id DESC LIMIT 1`)).rows[0];
    await c.query('COMMIT');
    return r ? { u: toTickUpdate(r), finishedAt: r.finished_at } : null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Once a day after the failure: the failing tick printed the line itself, so the first repeat is a day later. */
async function recoveryLineDue(pool: Pool, finishedAt: Date | null, now: Date): Promise<boolean> {
  const last = (await pool.query(`SELECT max(at) AS at FROM updater_ticks WHERE did = 'remind_recovery'`)).rows[0].at as Date | null;
  const latest = Math.max(finishedAt?.getTime() ?? -Infinity, last?.getTime() ?? -Infinity);
  return now.getTime() - latest >= DAY_MS;
}

async function tickLocked(deps: TickDeps): Promise<TickDid> {
  const at = deps.now();
  const runningTag = await runningTagOf(deps.installDir);
  const fingerprint = await fingerprintOf(deps.installDir);
  const picked = await pickUpdate(deps.pool);

  let did: TickDid = 'nothing';
  try {
    if (picked) {
      const { u } = picked;
      if (u.state === 'approved' || u.state === 'preparing') {
        await deps.prepare(u);
        did = 'prepared';
      } else if (u.state === 'ready' && u.startsAt.getTime() <= at.getTime()) {
        await deps.install(u);
        did = 'installed';
      } else if (u.state === 'installing') {
        await deps.install(u);
        did = 'installed';
      } else if (RECOVERY_STATES.includes(u.state) && (await recoveryLineDue(deps.pool, picked.finishedAt, at))) {
        deps.log(recoveryLine(u.state as 'failed_after_migration' | 'failed_needs_attention', u.tag));
        did = 'remind_recovery';
      }
    }
  } catch (err) {
    // Full detail goes to the cron log only, with any database URL masked; the steps record fixed codes themselves.
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    deps.log(`The updater stopped during this tick: ${maskSecrets(detail)}`);
    did = 'failed';
  }

  await deps.pool.query(`INSERT INTO updater_ticks (id, at, did, running_tag, key_fingerprint) VALUES ($1, $2, $3, $4, $5)`, [
    uuidv7(),
    at,
    did,
    runningTag,
    fingerprint,
  ]);
  return did;
}

/** One tick: 'busy' at once when another tick holds the updater lock. */
export async function runTick(deps: TickDeps): Promise<{ did: TickDid }> {
  const client = await deps.pool.connect();
  let broken = false;
  const onError = () => (broken = true);
  client.on('error', onError);
  try {
    const got = await client.query(`SELECT pg_try_advisory_lock(hashtext('kainow.updater')) AS ok`);
    if (!got.rows[0].ok) return { did: 'busy' };
    try {
      return { did: await tickLocked(deps) };
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('kainow.updater'))`);
      } catch {
        broken = true; // the session ends with the connection, which releases the lock
      }
    }
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

export const UPDATER_TEXT = {
  usage: 'Usage: node dist/updater/updater-cli.js tick | recover [--yes]',
  busy: 'Another updater tick is running; this one stops.',
  databaseUnreachable: 'The updater could not reach the database.',
} as const;

/**
 * `updater-cli.js tick | recover [--yes]`. Exit 0 done (including busy and nothing to do),
 * 1 the step failed or the database could not be reached, 2 usage. `recover` (recover.ts) checks its own arguments.
 */
export async function runUpdaterCli(argv: string[], deps: TickDeps & { recover?: (args: string[]) => Promise<number> }): Promise<number> {
  if (argv[0] === 'recover' && deps.recover) return deps.recover(argv.slice(1));
  if (argv.length !== 1 || argv[0] !== 'tick') {
    deps.log(UPDATER_TEXT.usage);
    return 2;
  }
  let did: TickDid;
  try {
    did = (await runTick(deps)).did;
  } catch (err) {
    deps.log(`${UPDATER_TEXT.databaseUnreachable} ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  if (did === 'busy') deps.log(UPDATER_TEXT.busy);
  else if (did !== 'nothing' && did !== 'remind_recovery') deps.log(`Tick: ${did}.`);
  return did === 'failed' ? 1 : 0;
}
