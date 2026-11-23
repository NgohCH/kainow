/**
 * The operator's recovery command after a failed update (10b spec 5.9, D123): `updater-cli.js recover [--yes]`.
 *
 *   failed_after_migration:  stop notice → stop api, worker → close connections → rename kainow (kept, never dropped)
 *                            → create an empty kainow → previous tag confirmed → 10a restore of the pre-update set
 *                            → the update record put right in the restored database → up api, worker → health
 *   failed_needs_attention:  stop notice → previous tag confirmed → up api, worker → health
 *                            → update maintenance off, the update recovered (no migration ran: no rename, no restore)
 *
 * A recover that stopped after the rename (the restore failed, say) is run again: it finds `kainow` empty or missing and
 * the set-aside database holding the failed update, and carries on from the restore. A restored copy whose record was
 * not put right is never started: it is recreated empty and restored again (a restore that stopped on a row-count
 * mismatch leaves a copy that looks the same and must not be used).
 *
 * The updater's tick lock is held on the Kainow database while recover works, so a tick never sees the restored
 * `installing` row before the record is put right (Review Focus 5). Before the rename the database stops taking new
 * connections, so a tick started by cron cannot hold the rename up.
 *
 * Never printed: the database URL or any password. Command output reaches the operator masked.
 */
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { notifyAdmins } from '../ops/notify';
import { todayUtc8 } from '../projects/membership';
import { auditUpdateRecovered } from './audit';
import { HEALTH_LIMIT_MS, PREVIOUS_SIGNERS, waitHealthy } from './install';
import { composeFlags } from './prepare';
import { maskSecrets, type RunResult, type Runner } from './runner';
import { FAILURE_TEXT, stateWords, type FailureCode, type UpdateState } from './states';
import { TRUSTED_SIGNERS } from './tick';

/** The Kainow database (compose.yaml: POSTGRES_DB and POSTGRES_USER). */
export const KAINOW_DB = 'kainow';
const DB_USER = 'kainow';
const LINK = '#/admin/operations';
const SHORT_MS = 2 * 60_000;
/** 10a's restore stops pg_restore after 6 hours; this leaves it room to report. */
const RESTORE_TIMEOUT_MS = 6.5 * 60 * 60_000;
const RENAME_TRIES = 10;
const RECREATE_COMMANDS = `docker compose exec -T db dropdb -U ${DB_USER} ${KAINOW_DB}; docker compose exec -T db createdb -U ${DB_USER} ${KAINOW_DB}`;
const SEE_INSTALL = "See INSTALL.md, 'After a failed update'.";

/** The failed update, as recover reads it (with its pre-update backup set's name). */
export interface RecoverUpdate {
  id: string;
  state: UpdateState;
  tag: string;
  fromVersion: string;
  toVersion: string;
  failureCode: FailureCode | null;
  preUpdateRunId: string | null;
  preUpdateSet: string | null;
}

/** Where recover starts. */
export type Situation =
  /** The latest update in `kainow` needs recovery; nothing has been done yet. */
  | { kind: 'fresh'; update: RecoverUpdate }
  /** An earlier recover set the failed database aside; `kainow` is empty (or missing: created first). */
  | { kind: 'set_aside'; update: RecoverUpdate; failedDb: string; createKainow: boolean }
  | { kind: 'refused'; message: string };

/** What the store found, for decideSituation. */
export interface Found {
  /** null when there is no `kainow` database. */
  kainow: { empty: boolean; hasUpdates: boolean; latest: RecoverUpdate | null; reason: string | null } | null;
  /** The newest `kainow_failed_*` database and the latest update in it. */
  setAside: { name: string; latest: RecoverUpdate | null } | null;
}

export const RECOVER_TEXT = {
  usage: 'Usage: node dist/updater/updater-cli.js recover [--yes]',
  databaseUnreachable: 'The updater could not reach the database server.',
  busy: 'An updater tick is running; try again in a minute.',
  nothing: 'There is no failed update to recover from.',
  notNeeded: (tag: string, state: UpdateState) => `The latest update (${tag}) is: ${stateWords(state)}. There is nothing to recover.`,
  noBackup: `The failed update has no pre-update backup recorded, so recover cannot restore it. Nothing was changed. ${SEE_INSTALL}`,
  partial: `The Kainow database is a restored copy that an earlier recover or restore did not finish, and it must not be started. Drop and recreate it empty, then run recover again: ${RECREATE_COMMANDS}`,
  /** Never drop advice: this may be the failed database itself, half-migrated (spec 5.7), which is kept (spec 5.9 step 3). */
  unrecognised: `The Kainow database is not recognised: it holds no update record and is not a restored copy. It may be the failed database itself, half-migrated. Do not drop it. Nothing was changed. ${SEE_INSTALL}`,
  inProgress: (tag: string) =>
    `The update to ${tag} is still in progress, or its failure is not yet recorded. Nothing was changed. Wait for the next updater tick (every five minutes), then run recover again if it says to.`,
  badName: (name: string) => `The set-aside database name ${name} is not as expected; nothing was changed. ${SEE_INSTALL}`,
  declined: 'Nothing was changed.',
  prompt: 'Type yes to continue: ',
  notAtTag: (tag: string) =>
    `The Kainow folder is not at ${tag}. Check it out (git -c advice.detachedHead=false checkout --detach ${tag}) and run recover again. ${SEE_INSTALL}`,
  signersFailed: `The trusted signers file could not be put back to the previous one. ${SEE_INSTALL}`,
  renameFailed: (name: string) => `The failed database could not be renamed to ${name}; nothing was changed and Kainow still shows the notice page. ${SEE_INSTALL}`,
  createFailed: `The empty kainow database could not be created. Run recover again once the database service is working. ${SEE_INSTALL}`,
  restoreFailed: (kept: string) =>
    `The restore did not finish (its messages are above). The failed database is kept as ${kept}. Fix the cause and run recover again; if the restore said to recreate the target, do that first: ${RECREATE_COMMANDS}`,
  fixFailed: `The update record in the restored database could not be put right, so Kainow was not started. Recreate the kainow database empty and run recover again: ${RECREATE_COMMANDS}`,
  startFailed: (version: string) =>
    `Kainow v${version} did not start or did not pass its health checks within ${HEALTH_LIMIT_MS / 60_000} minutes; the notice page is shown again. ${SEE_INSTALL}`,
  back: (version: string) => `Kainow is back on v${version}. Review and choose Resume on the Operations page.`,
  backWritable: (version: string) => `Kainow is back on v${version}.`,
} as const;

/** What setAsideName gives; checked before it goes into the rename's SQL. */
export const SET_ASIDE_PATTERN = /^kainow_failed_\d{8}_[0-9a-f]{8}$/;

/** `kainow_failed_<YYYYMMDD>_<first 8 hex of the update id>` (the date in UTC+8, as everywhere in Kainow). */
export function setAsideName(updateId: string, now: Date): string {
  return `${KAINOW_DB}_failed_${todayUtc8(now).replace(/-/g, '')}_${updateId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

const idSuffix = (updateId: string) => `_${updateId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
const RECOVERABLE: readonly UpdateState[] = ['failed_after_migration', 'failed_needs_attention'];

/** Pure: where recover starts, from what the store found (spec 5.9 step 1, and a re-run after a partial recover). */
export function decideSituation(f: Found): Situation {
  const k = f.kainow;
  if (k?.latest) {
    if (RECOVERABLE.includes(k.latest.state)) return { kind: 'fresh', update: k.latest };
    // A restored copy whose record was never put right (or one a stopped restore left behind) is never started.
    if (k.latest.state === 'installing' && k.reason === 'restored_from_backup') return { kind: 'refused', message: RECOVER_TEXT.partial };
    if (k.latest.state === 'installing') return { kind: 'refused', message: RECOVER_TEXT.inProgress(k.latest.tag) };
    return { kind: 'refused', message: RECOVER_TEXT.notNeeded(k.latest.tag, k.latest.state) };
  }
  if (k && k.hasUpdates) return { kind: 'refused', message: RECOVER_TEXT.nothing };
  const s = f.setAside;
  // The rename provably happened: a set-aside database holds the failed update.
  const renamed = !!(s?.latest && s.latest.state === 'failed_after_migration' && s.name.endsWith(idSuffix(s.latest.id)));
  if (k && !k.empty) {
    // Drop advice only for a copy that is provably the restore target, never for what may be the failed database.
    if (renamed || k.reason === 'restored_from_backup') return { kind: 'refused', message: RECOVER_TEXT.partial };
    return { kind: 'refused', message: RECOVER_TEXT.unrecognised };
  }
  // `kainow` is empty or missing: an earlier recover renamed the failed database.
  if (renamed && s?.latest) {
    return { kind: 'set_aside', update: s.latest, failedDb: s.name, createKainow: k === null };
  }
  return { kind: 'refused', message: RECOVER_TEXT.nothing };
}

/** What recover reads and writes in the databases; pgRecoverStore, or one in memory for tests. */
export interface RecoverStore {
  situation(): Promise<Situation>;
  /** The updater's tick lock on the Kainow database, held until releaseKainow or close: false when a tick holds it. */
  lockUpdater(wait: boolean): Promise<boolean>;
  /** Releases the lock and ends this command's connections to the Kainow database (before the rename). */
  releaseKainow(): Promise<void>;
  /** fixRestoredRecord on the restored Kainow database, reading the later steps from the set-aside one. */
  fixRecord(update: RecoverUpdate, failedDb: string, now: Date): Promise<void>;
  /** failed_needs_attention: update maintenance off, the update recovered, audit and notices. False when it moved on. */
  finishInPlace(update: RecoverUpdate, now: Date): Promise<boolean>;
  close(): Promise<void>;
}

export interface RecoverDeps {
  runner: Runner;
  /** The Kainow folder. */
  installDir: string;
  projectName: () => Promise<string>;
  store: RecoverStore;
  now: () => Date;
  log: (line: string) => void;
  /** Asks the operator; null when nobody can answer (no terminal). */
  ask: (question: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
}

const tail = (r: RunResult): string => maskSecrets(`${r.stdout}\n${r.stderr}`.trim().slice(-8000));

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

function planLines(sit: Exclude<Situation, { kind: 'refused' }>, aside: string): string[] {
  const u = sit.update;
  const prev = `v${u.fromVersion}`;
  const head = `Recovering from the failed update to ${u.tag} (${u.failureCode ?? 'no failure code'}). Kainow goes back to ${prev}.`;
  if (u.state === 'failed_needs_attention') {
    return [
      head,
      'No database migration ran, so nothing is restored. This will:',
      '  1. stop the notice page;',
      `  2. check that the Kainow folder is at ${prev};`,
      `  3. start Kainow ${prev} and wait for its health checks;`,
      '  4. end the update maintenance, record the update as recovered and tell the Enterprise Administrators.',
    ];
  }
  const keep =
    sit.kind === 'fresh'
      ? `  2. keep the failed database as ${aside} (nothing is dropped) and create an empty kainow database;`
      : `  2. use the empty kainow database (the failed one is already kept as ${aside});`;
  return [
    head,
    'This will:',
    '  1. stop the notice page;',
    keep,
    `  3. check that the Kainow folder is at ${prev};`,
    `  4. restore the pre-update backup set ${u.preUpdateSet}: Kainow starts read-only, everyone is signed out, and queued emails and jobs are not sent;`,
    '  5. record the update as recovered and tell the Enterprise Administrators;',
    `  6. start Kainow ${prev} and wait for its health checks.`,
  ];
}

/** `recover [--yes]` (spec 5.9). Exit 0 recovered, 1 refused or failed, 2 usage. */
export async function runRecover(argv: string[], deps: RecoverDeps): Promise<number> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--yes')) {
    deps.log(RECOVER_TEXT.usage);
    return 2;
  }
  const yes = argv.length === 1;
  const { runner, installDir, store, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    let sit: Situation;
    try {
      sit = await store.situation();
    } catch (err) {
      log(`${RECOVER_TEXT.databaseUnreachable} ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
      return 1;
    }
    if (sit.kind === 'refused') {
      log(sit.message);
      return 1;
    }
    const u = sit.update;
    const migrated = u.state === 'failed_after_migration';
    if (migrated && (!u.preUpdateSet || !u.preUpdateRunId)) {
      log(RECOVER_TEXT.noBackup);
      return 1;
    }
    const aside = sit.kind === 'set_aside' ? sit.failedDb : setAsideName(u.id, deps.now());
    for (const line of planLines(sit, aside)) log(line);
    if (!yes) {
      const answer = await deps.ask(RECOVER_TEXT.prompt);
      if (answer?.replace(/\r?\n$/, '') !== 'yes') {
        log(RECOVER_TEXT.declined);
        return 1;
      }
    }

    const flags = composeFlags(installDir, await deps.projectName(), installDir);
    const compose = (args: string[], timeoutMs = SHORT_MS) => runner.run('docker', [...flags, ...args], { cwd: installDir, timeoutMs });
    const psql = (...sql: string[]) =>
      compose(['exec', '-T', 'db', 'psql', '-U', DB_USER, '-d', 'postgres', ...(sql.length > 1 ? ['-v', 'ON_ERROR_STOP=1'] : []), ...sql.flatMap((s) => ['-c', s])]);
    const previousTag = `v${u.fromVersion}`;

    /** Spec 5.9 step 4: the folder at the previous tag, and the trusted signers file the previous one. */
    const confirmPrevious = async (): Promise<boolean> => {
      const t = await runner.run('git', ['tag', '--points-at', 'HEAD'], { cwd: installDir });
      const tags = t.code === 0 ? t.stdout.split(/\r?\n/).map((x) => x.trim()) : [];
      if (!tags.includes(previousTag)) {
        log(RECOVER_TEXT.notAtTag(previousTag));
        return false;
      }
      // The failed install puts the kept file back itself; a copy still kept means that did not happen.
      const previous = join(installDir, PREVIOUS_SIGNERS);
      try {
        await rm(join(installDir, `${TRUSTED_SIGNERS}.tmp`), { force: true });
        if (await exists(previous)) await rename(previous, join(installDir, TRUSTED_SIGNERS));
      } catch {
        log(RECOVER_TEXT.signersFailed);
        return false;
      }
      return true;
    };

    /** Spec 5.9 step 7: the previous version up and healthy; otherwise the notice page again. */
    const startPrevious = async (): Promise<boolean> => {
      const up = await compose(['up', '-d', '--no-deps', 'api', 'worker'], 10 * 60_000);
      let ok = up.code === 0;
      if (!ok) log(`Starting api and worker on ${previousTag} failed (${up.code}): ${tail(up)}`);
      if (ok) ok = await waitHealthy({ runner, installDir, compose, now: () => deps.now().getTime(), log, sleep }, u.fromVersion);
      if (ok) return true;
      await compose(['stop', 'api', 'worker'], 5 * 60_000);
      const notice = await compose(['up', '-d', '--no-deps', 'notice']);
      if (notice.code !== 0) log(`Starting the notice page failed (${notice.code}): ${tail(notice)}`);
      log(RECOVER_TEXT.startFailed(u.fromVersion));
      return false;
    };

    if (sit.kind === 'fresh' && !(await store.lockUpdater(false))) {
      log(RECOVER_TEXT.busy);
      return 1;
    }

    // ---- 2. the notice page off (it holds Kainow's port) ----
    const notice = await compose(['stop', 'notice']);
    if (notice.code !== 0) log(`Stopping the notice page failed (${notice.code}): ${tail(notice)}`);

    if (!migrated) {
      // ---- no migration ran (spec 5.6's last paragraph): previous version, health, then maintenance off ----
      if (!(await confirmPrevious())) return 1;
      if (!(await startPrevious())) return 1;
      if (!(await store.finishInPlace(u, deps.now()))) {
        log(`The update to ${u.tag} was no longer waiting for recovery; nothing was recorded.`);
        return 1;
      }
      log(`The update to ${u.tag} is recorded as recovered and the update maintenance has ended.`);
      log(RECOVER_TEXT.backWritable(u.fromVersion));
      return 0;
    }

    // ---- 3. keep the failed database ----
    let createKainow = sit.kind === 'set_aside' ? sit.createKainow : true;
    if (sit.kind === 'fresh') {
      if (!SET_ASIDE_PATTERN.test(aside)) {
        log(RECOVER_TEXT.badName(aside));
        return 1;
      }
      const stop = await compose(['stop', 'api', 'worker'], 5 * 60_000);
      if (stop.code !== 0) log(`Stopping api and worker failed (${stop.code}): ${tail(stop)}`);
      await store.releaseKainow();
      // No new connection from here (a tick started by cron, say), then every other one ended.
      const close = await psql(
        `ALTER DATABASE ${KAINOW_DB} WITH ALLOW_CONNECTIONS false`,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${KAINOW_DB}' AND pid <> pg_backend_pid()`,
      );
      let renamed = close.code === 0;
      if (!renamed) log(`Closing the connections to the database failed (${close.code}): ${tail(close)}`);
      for (let i = 0; renamed === true && i < RENAME_TRIES; i++) {
        // A terminated backend may take a moment to go.
        const r = await psql(`ALTER DATABASE ${KAINOW_DB} RENAME TO ${aside}`);
        if (r.code === 0) break;
        if (i === RENAME_TRIES - 1) {
          log(`Renaming the database failed (${r.code}): ${tail(r)}`);
          renamed = false;
        } else await sleep(1_000);
      }
      if (!renamed) {
        await psql(`ALTER DATABASE ${KAINOW_DB} WITH ALLOW_CONNECTIONS true`);
        log(RECOVER_TEXT.renameFailed(aside));
        const back = await compose(['up', '-d', '--no-deps', 'notice']);
        if (back.code !== 0) log(`Starting the notice page failed (${back.code}): ${tail(back)}`);
        return 1;
      }
      const allow = await psql(`ALTER DATABASE ${aside} WITH ALLOW_CONNECTIONS true`);
      if (allow.code !== 0) log(`Allowing connections to ${aside} failed (${allow.code}); its later steps may not be copied.`);
      log(`The failed database is kept as ${aside}.`);
      createKainow = true;
    }
    if (createKainow) {
      const c = await compose(['exec', '-T', 'db', 'createdb', '-U', DB_USER, KAINOW_DB]);
      if (c.code !== 0) {
        log(`Creating the kainow database failed (${c.code}): ${tail(c)}`);
        log(RECOVER_TEXT.createFailed);
        return 1;
      }
    }
    // Held until the record is put right, so no tick sees the restored `installing` row.
    await store.lockUpdater(true);

    // ---- 4. the folder at the previous tag ----
    if (!(await confirmPrevious())) return 1;

    // ---- 5. 10a's restore of the pre-update set, on the previous version's ops image ----
    const restore = await compose(
      ['run', '--rm', 'ops', 'node', 'dist/ops/restore-cli.js', '--set', u.preUpdateSet!, '--reason', `Recovering from failed update to ${u.tag}`],
      RESTORE_TIMEOUT_MS,
    );
    for (const line of `${restore.stdout}\n${restore.stderr}`.split(/\r?\n/).filter((l) => l.trim())) log(maskSecrets(line));
    if (restore.code !== 0) {
      log(RECOVER_TEXT.restoreFailed(aside));
      return 1;
    }

    // ---- 6. the update record put right, before Kainow starts ----
    try {
      await store.fixRecord(u, aside, deps.now());
    } catch (err) {
      log(`Putting the update record right failed: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
      log(RECOVER_TEXT.fixFailed);
      return 1;
    }
    log(`The update to ${u.tag} is recorded as recovered in the restored database.`);
    await store.releaseKainow();

    // ---- 7. the previous version up; 8. the message ----
    if (!(await startPrevious())) return 1;
    log(RECOVER_TEXT.back(u.fromVersion));
    return 0;
  } finally {
    await store.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The database side
// ---------------------------------------------------------------------------------------------------------------------

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    c.release(broken);
  }
}

const stateChange = (c: PoolClient, id: string, now: Date, detail: Record<string, unknown>) =>
  c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'state_changed', NULL, NULL, $4)`, [
    uuidv7(now.getTime()),
    id,
    now,
    JSON.stringify(detail),
  ]);

/** The latest update (ORDER BY approved_at DESC, id DESC) with its pre-update backup set's name; null when none. */
export async function readLatestUpdate(db: Pool | PoolClient): Promise<RecoverUpdate | null> {
  const r = (
    await db.query(
      `SELECT u.id, u.state, u.tag, u.from_version, u.to_version, u.failure_code, u.pre_update_backup_run_id, b.set_name
         FROM updates u LEFT JOIN backup_runs b ON b.id = u.pre_update_backup_run_id
        ORDER BY u.approved_at DESC, u.id DESC LIMIT 1`,
    )
  ).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    state: r.state,
    tag: r.tag,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    failureCode: r.failure_code,
    preUpdateRunId: r.pre_update_backup_run_id,
    preUpdateSet: r.set_name,
  };
}

/** The urgent notice to the Enterprise Administrators (in-app and email). */
export function recoveredSummary(tag: string, fromVersion: string, code: FailureCode | null, restored: boolean): string {
  const why = code ? ` ${FAILURE_TEXT[code]}` : '';
  return restored
    ? `The update to ${tag} failed.${why} Kainow was restored from the backup taken just before the update and is back on v${fromVersion}, read-only: review and choose Resume on the Operations page.`
    : `The update to ${tag} failed.${why} Kainow is back on v${fromVersion}; nothing was restored.`;
}

type StepCopy = { id: string; step: string; started_at: Date; finished_at: Date | null; outcome: string; failure_code: string | null };

/**
 * Spec 5.9 step 6, on the restored database, before Kainow starts. The pre-update backup was taken while the update was
 * `installing`, so the restored row is `installing` with its early steps. In one transaction: the row → `recovered` (the
 * failure code, finished_at, and the backup run restored from), the later steps copied from the set-aside database
 * (skipped with a logged note when it cannot be read), any step still running closed, the audit event, and the urgent
 * `update_failed` notice with email outbox rows for every Active Enterprise Administrator. Written after 10a's
 * after-restore, so those emails stay queued and the worker sends them.
 */
export async function fixRestoredRecord(
  restored: Pool,
  failed: Pool | null,
  updateId: string,
  restoreRunId: string,
  failureCode: FailureCode,
  now: Date,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  let steps: StepCopy[] | null = null;
  if (failed) {
    try {
      steps = (
        await failed.query(
          `SELECT id, step, started_at, finished_at, outcome, failure_code FROM update_steps WHERE update_id = $1 ORDER BY started_at, id`,
          [updateId],
        )
      ).rows;
    } catch (err) {
      log(`The later update steps could not be read from the set-aside database; they are kept there only (${maskSecrets(err instanceof Error ? err.message : String(err))}).`);
    }
  } else log('The set-aside database was not available; the later update steps are kept there only.');

  await inTransaction(restored, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
    const row = (
      await c.query(
        `UPDATE updates SET state = 'recovered', failure_code = $2, finished_at = $3, recovery_backup_run_id = $4,
                pre_update_backup_run_id = COALESCE(pre_update_backup_run_id, $4)
          WHERE id = $1 AND state IN ('installing', 'failed_after_migration')
          RETURNING tag, from_version`,
        [updateId, failureCode, now, restoreRunId],
      )
    ).rows[0];
    if (!row) throw new Error('the restored database does not hold this update as installing');

    let copied = 0;
    for (const s of steps ?? []) {
      const have = (await c.query(`SELECT outcome FROM update_steps WHERE id = $1`, [s.id])).rows[0];
      if (!have) {
        await c.query(
          `INSERT INTO update_steps (id, update_id, step, started_at, finished_at, outcome, failure_code) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [s.id, updateId, s.step, s.started_at, s.finished_at, s.outcome, s.failure_code],
        );
        copied++;
      } else if (have.outcome === 'running' && s.outcome !== 'running') {
        // The step the backup was taken in (still running in the dump), finished as the set-aside database recorded it.
        await c.query(`UPDATE update_steps SET outcome = $2, finished_at = $3, failure_code = $4 WHERE id = $1 AND outcome = 'running'`, [
          s.id,
          s.outcome,
          s.finished_at,
          s.failure_code,
        ]);
        copied++;
      }
    }
    // Nothing of the old installation is still running here.
    await c.query(`UPDATE update_steps SET outcome = 'failed', finished_at = $2 WHERE update_id = $1 AND outcome = 'running'`, [updateId, now]);

    await stateChange(c, updateId, now, { from: 'installing', to: 'recovered', failureCode, restoredFrom: restoreRunId, stepsCopied: steps ? copied : null });
    await auditUpdateRecovered(c, {
      at: now,
      actorUserId: null,
      subjectType: 'update',
      subjectId: updateId,
      detail: { tag: row.tag, failureCode, restored: true, backupRunId: restoreRunId },
    });
    await notifyAdmins(c, { kind: 'update_failed', summary: recoveredSummary(row.tag, row.from_version, failureCode, true), link: LINK, now, urgent: true });
  });
}

/**
 * failed_needs_attention (no migration ran), once the previous version is healthy: update maintenance off (recorded as
 * install's own clearing is), the update recovered, audit and the Administrators' notice; one transaction.
 */
export async function finishWithoutRestore(pool: Pool, updateId: string, now: Date): Promise<boolean> {
  return inTransaction(pool, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
    const row = (
      await c.query(
        `UPDATE updates SET state = 'recovered', finished_at = $2 WHERE id = $1 AND state = 'failed_needs_attention' RETURNING tag, from_version, failure_code`,
        [updateId, now],
      )
    ).rows[0];
    if (!row) return false;
    await c.query(`UPDATE update_steps SET outcome = 'failed', finished_at = $2 WHERE update_id = $1 AND outcome = 'running'`, [updateId, now]);
    // Only the updater sets the reason `update`, so whatever update it names, it ends here (never left read-only).
    const cleared = await c.query(
      `UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL, changed_by = NULL
        WHERE id AND protective AND reason = 'update'`,
    );
    if (cleared.rowCount === 1) {
      await c.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'resumed', NULL, NULL, $3)`, [
        uuidv7(now.getTime()),
        now,
        JSON.stringify({ previousReason: 'update', updateId, outcome: 'recovered' }),
      ]);
    }
    const code = row.failure_code as FailureCode | null;
    await stateChange(c, updateId, now, { from: 'failed_needs_attention', to: 'recovered', failureCode: code });
    await auditUpdateRecovered(c, { at: now, actorUserId: null, subjectType: 'update', subjectId: updateId, detail: { tag: row.tag, failureCode: code, restored: false } });
    await notifyAdmins(c, { kind: 'update_failed', summary: recoveredSummary(row.tag, row.from_version, code, false), link: LINK, now, urgent: true });
    return true;
  });
}

/** What the Kainow database holds now, for decideSituation. */
export async function inspectKainow(pool: Pool): Promise<NonNullable<Found['kainow']>> {
  const t = (
    await pool.query(
      `SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') = 0
              AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS empty,
              to_regclass('public.updates') IS NOT NULL AS has_updates,
              to_regclass('public.operations_state') IS NOT NULL AS has_state`,
    )
  ).rows[0];
  // Read whatever the schema holds: reason restored_from_backup is what proves a copy is the restore target.
  let reason: string | null = null;
  if (t.has_state) {
    try {
      reason = (await pool.query(`SELECT reason FROM operations_state WHERE id`)).rows[0]?.reason ?? null;
    } catch {
      reason = null; // half-migrated: not provably a restored copy
    }
  }
  if (!t.has_updates) return { empty: t.empty === true, hasUpdates: false, latest: null, reason };
  const latest = await readLatestUpdate(pool);
  return { empty: false, hasUpdates: true, latest, reason };
}

/**
 * The store over the database server. `openPool(name)` opens a pool on the named database of the Kainow server (the Kainow
 * database when no name is given); every pool it opens is ended by close.
 */
export function pgRecoverStore(openPool: (database?: string) => Pool, log: (line: string) => void): RecoverStore {
  let kainow: Pool | null = null;
  let lock: PoolClient | null = null;
  const main = () => (kainow ??= openPool());
  const withPool = async <T>(database: string, fn: (p: Pool) => Promise<T>): Promise<T> => {
    const p = openPool(database);
    try {
      return await fn(p);
    } finally {
      await p.end().catch(() => undefined);
    }
  };
  const releaseKainow = async () => {
    if (lock) {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('kainow.updater'))`).catch(() => undefined);
      lock.release(true);
      lock = null;
    }
    if (kainow) await kainow.end().catch(() => undefined);
    kainow = null;
  };
  return {
    async situation() {
      const names = await withPool('postgres', async (p) =>
        (
          await p.query(`SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2 ORDER BY datname DESC`, [
            KAINOW_DB,
            `${KAINOW_DB}\\_failed\\_%`,
          ])
        ).rows.map((r: { datname: string }) => r.datname),
      );
      const found: Found = { kainow: null, setAside: null };
      if (names.includes(KAINOW_DB)) found.kainow = await inspectKainow(main());
      const newest = names.find((n) => n !== KAINOW_DB);
      if (newest && !found.kainow?.latest) {
        let latest: RecoverUpdate | null = null;
        try {
          latest = await withPool(newest, (p) => readLatestUpdate(p));
        } catch {
          latest = null; // not readable: decideSituation refuses
        }
        found.setAside = { name: newest, latest };
      }
      return decideSituation(found);
    },
    async lockUpdater(wait) {
      if (lock) return true;
      const c = await main().connect();
      try {
        if (wait) await c.query(`SELECT pg_advisory_lock(hashtext('kainow.updater'))`);
        else if (!(await c.query(`SELECT pg_try_advisory_lock(hashtext('kainow.updater')) AS ok`)).rows[0].ok) {
          c.release();
          return false;
        }
      } catch (err) {
        c.release(true);
        throw err;
      }
      lock = c;
      return true;
    },
    releaseKainow,
    async fixRecord(u, failedDb, now) {
      const failed = openPool(failedDb);
      try {
        await fixRestoredRecord(main(), failed, u.id, u.preUpdateRunId!, u.failureCode ?? 'migration_failed', now, log);
      } finally {
        await failed.end().catch(() => undefined);
      }
    },
    finishInPlace: (u, now) => finishWithoutRestore(main(), u.id, now),
    close: releaseKainow,
  };
}
