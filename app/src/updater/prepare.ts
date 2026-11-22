/**
 * Preparing an approved update before its window (10b spec 5.3, 5.4, 5.8). Started by a tick for an `approved`
 * update, and again for a `preparing` one when the tick that was preparing it died (re-entry: any half-made staging
 * checkout is removed and preparation starts over).
 *
 *   space → working_tree → verify → staging → compatibility → build → ready
 *
 * Nothing on the running installation changes: the new code is checked out in `.kainow-staging/vX.Y.Z` and its images
 * are built beside the running ones. Any failure removes the staging checkout and ends the update as `refused` (the
 * release or the folder is not fit to install) or `failed_before_install` (the build failed), with a fixed failure code,
 * an audit event and an urgent notice to every Enterprise Administrator. A cancel during preparation wins: the
 * preparation stops, removes its staging checkout and records nothing more.
 *
 * Command output goes only to the log, masked; never the output of `docker compose config`, which interpolates the
 * .env file's secrets.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { loadOpsSettings } from '../ops/settings';
import { notifyAdmins } from '../ops/notify';
import type { StatFs } from '../ops/storage-check';
import { auditUpdateFailed, auditUpdateRefused } from './audit';
import { fetchCandidate, verifyCandidate, workingTreeState } from './git';
import { CODE_TIMEOUT } from './process';
import { maskSecrets, type RunResult, type Runner } from './runner';
import { FAILURE_TEXT, type FailureCode } from './states';
import type { TickUpdate } from './tick';
import { compareVersions, parseTag } from './version';

const GB = 1024 ** 3;
/**
 * Free space needed above the safe floor to prepare (spec 5.4 step 1): max(4 GB, a measured build × 1.5).
 * Measured on 22 November 2026 (`docker system df` before and after building the runtime, ops and updater targets of
 * this tree, the runtime one without cache): images +0.64 GB, build cache +1.16 GB, about 1.8 GB; counting the ops and
 * updater layers in full (+0.33 GB), about 2.1 GB. × 1.5 ≈ 3.2 GB, below 4 GB, so 4 GB stands.
 */
export const SPACE_MARGIN_GB = 4;
/** The whole preparation's limit (spec 5.4): beyond it the update is `build_timeout`. */
export const PREPARE_LIMIT_MS = 60 * 60_000;
/** `docker compose config` and the image version check: short, and never beyond the preparation's limit. */
const SHORT_DOCKER_MS = 5 * 60_000;
const LINK = '#/admin/operations';
/** The trusted release signers file in the Kainow folder (spec 4.3); the candidate's own file is never trusted here. */
const TRUSTED_SIGNERS = 'release-signers';
const REQUIREMENTS = 'release/requirements.json';
const LOG_TAIL = 8000;

export type PrepareStep = 'space' | 'working_tree' | 'verify' | 'staging' | 'compatibility' | 'build';
export type PrepareOutcome = 'ready' | 'refused' | 'failed_before_install' | 'cancelled';

/** The git steps of git.ts; tests replace them. */
export interface PrepareGit {
  fetchCandidate: typeof fetchCandidate;
  verifyCandidate: typeof verifyCandidate;
  workingTreeState: typeof workingTreeState;
}

export interface PrepareDeps {
  pool: Pool;
  runner: Runner;
  /** The Kainow folder: the installation's checkout, .env and compose.override.yaml. */
  installDir: string;
  /** The installation's Compose project name (projectNameFor). */
  projectName: string;
  now: () => Date;
  log: (line: string) => void;
  statfs: StatFs;
  git?: PrepareGit;
}

/** What preparation records; the database store is pgPrepareStore, tests use one in memory. */
export interface PrepareStore {
  /** Under the updates lock: approved|preparing → preparing; false when the update is no longer to be prepared. */
  begin(id: string, now: Date): Promise<boolean>;
  /** Still preparing (not cancelled meanwhile). */
  stillPreparing(id: string): Promise<boolean>;
  startStep(id: string, step: PrepareStep, now: Date): Promise<string>;
  endStep(stepId: string, outcome: 'passed' | 'failed', code: FailureCode | null, now: Date): Promise<void>;
  /** The verified tag object and release notes; false when no longer preparing. */
  saveVerified(id: string, tagObject: string, notes: string): Promise<boolean>;
  /** Under the updates lock, only while still preparing; false when it was cancelled meanwhile (nothing written). */
  finish(id: string, end: PrepareEnd, now: Date): Promise<boolean>;
  safeFloorGb(): Promise<number>;
}

export type PrepareEnd =
  | { state: 'ready' }
  | { state: 'refused' | 'failed_before_install'; code: FailureCode; tag: string; summary: string };

/** Compose's project name: COMPOSE_PROJECT_NAME, else the folder's base name, lower-cased, other characters dropped. */
export function projectNameFor(env: NodeJS.ProcessEnv, installDir: string): string {
  const given = env.COMPOSE_PROJECT_NAME?.trim();
  if (given) return given;
  return basename(installDir.replace(/[\\/]+$/, ''))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z0-9]+/, '');
}

/**
 * The running installation's project name, so `stop`, `up` and `ps` act on its containers: COMPOSE_PROJECT_NAME from the
 * updater's environment, else the `name` Compose itself resolves for the Kainow folder (which reads COMPOSE_PROJECT_NAME
 * from the folder's .env and the top-level `name`), else projectNameFor. The resolved configuration interpolates .env
 * secrets: it is parsed in memory and never logged, nor is Compose's error output.
 */
export async function resolveProjectName(runner: Runner, installDir: string, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<string> {
  const given = env.COMPOSE_PROJECT_NAME?.trim();
  if (given) return given;
  const files = ['-f', join(installDir, 'compose.yaml')];
  const override = join(installDir, 'compose.override.yaml');
  if (existsSync(override)) files.push('-f', override);
  const r = await runner.run(
    'docker',
    ['compose', '--project-directory', installDir, '--env-file', join(installDir, '.env'), ...files, 'config', '--format', 'json'],
    { cwd: installDir, timeoutMs: SHORT_DOCKER_MS },
  );
  if (r.code === 0) {
    try {
      const name = (JSON.parse(r.stdout) as { name?: unknown }).name;
      if (typeof name === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(name)) return name;
    } catch {
      // fall through
    }
  }
  const fallback = projectNameFor(env, installDir);
  log(`Compose did not give the project name (${r.code}); using ${fallback}.`);
  return fallback;
}

export const stagingDir = (installDir: string, tag: string): string => join(installDir, '.kainow-staging', tag);

/** `docker compose` flags for a project directory with the installation's project name, .env and override file. */
export function composeFlags(installDir: string, projectName: string, projectDir: string): string[] {
  const flags = [
    'compose',
    '--project-directory', projectDir,
    '--project-name', projectName,
    '--env-file', join(installDir, '.env'),
    '-f', join(projectDir, 'compose.yaml'),
  ];
  const override = join(installDir, 'compose.override.yaml');
  if (existsSync(override)) flags.push('-f', override);
  // Built and validated with every profile, so the ops and updater images of the release are built too.
  flags.push('--profile', 'updater', '--profile', 'ops');
  return flags;
}

/** The variable a failed `docker compose config` names (never its value), or null. */
export function missingVariable(stderr: string): string | null {
  const m = /required variable ([A-Za-z_][A-Za-z0-9_]*) is missing a value/.exec(stderr);
  return m ? m[1] : null;
}

type Requirements = { manual?: unknown; note?: unknown; minimumFrom?: unknown };

type DbService = { image: unknown; volumes: string; environment: string[] };

/** The `db` service's image, volumes and environment names (never values), with the staging path read as the folder's. */
function dbServiceOf(json: string, projectDir: string, installDir: string): DbService | null {
  try {
    const db = (JSON.parse(json) as { services?: Record<string, any> }).services?.db;
    if (!db || typeof db !== 'object') return null;
    const env = db.environment && typeof db.environment === 'object' ? Object.keys(db.environment).sort() : [];
    const volumes = JSON.stringify(db.volumes ?? []).split(JSON.stringify(projectDir).slice(1, -1)).join(JSON.stringify(installDir).slice(1, -1));
    return { image: db.image ?? null, volumes, environment: env };
  } catch {
    return null;
  }
}

function apiImageOf(json: string): string | null {
  try {
    const image = (JSON.parse(json) as { services?: Record<string, any> }).services?.api?.image;
    return typeof image === 'string' && image ? image : null;
  } catch {
    return null;
  }
}

const tail = (r: RunResult): string => maskSecrets(`${r.stdout}\n${r.stderr}`.trim().slice(-LOG_TAIL));

class Stop {
  constructor(
    readonly state: 'refused' | 'failed_before_install',
    readonly code: FailureCode,
    readonly extra = '',
  ) {}
}
class Cancelled {}

const BUILD_CODES: readonly FailureCode[] = ['build_failed', 'build_timeout'];

function summaryFor(tag: string, s: Stop): string {
  const head =
    s.state === 'refused'
      ? `The update to ${tag} was refused: ${FAILURE_TEXT[s.code]}`
      : `The update to ${tag} failed before installing; nothing changed. ${FAILURE_TEXT[s.code]}`;
  return s.extra ? `${head} ${s.extra}` : head;
}

function filesLine(files: string[]): string {
  const shown = files.slice(0, 10).join(', ');
  return files.length > 10 ? `Changed files: ${shown} and ${files.length - 10} more.` : `Changed files: ${shown}.`;
}

/** Prepares one update; the tick calls this. */
export function prepareUpdate(deps: PrepareDeps, update: TickUpdate): Promise<PrepareOutcome> {
  return prepareWithStore(deps, pgPrepareStore(deps.pool), update);
}

export async function prepareWithStore(deps: Omit<PrepareDeps, 'pool'>, store: PrepareStore, u: TickUpdate): Promise<PrepareOutcome> {
  const g = deps.git ?? { fetchCandidate, verifyCandidate, workingTreeState };
  const { runner, installDir, log } = deps;
  const staging = stagingDir(installDir, u.tag);
  // 60 minutes from the start of preparation, and never beyond 60 minutes past the update's start time: a row a dying
  // tick left `preparing` (or one the updater first saw long after its start) is not retried for ever.
  const deadline = Math.min(deps.now().getTime(), u.startsAt.getTime()) + PREPARE_LIMIT_MS;
  const remaining = () => deadline - deps.now().getTime();

  const removeStaging = async () => {
    await runner.run('git', ['worktree', 'remove', '--force', staging], { cwd: installDir });
    await runner.run('git', ['worktree', 'prune'], { cwd: installDir });
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  };

  // Re-entry: a tick that died mid-preparation may have left a staging checkout.
  await removeStaging();
  if (!(await store.begin(u.id, deps.now()))) {
    log(`The update to ${u.tag} is no longer approved; nothing to prepare.`);
    return 'cancelled';
  }
  log(`Preparing the update to ${u.tag}.`);

  const step = async (name: PrepareStep, body: () => Promise<void>) => {
    if (!(await store.stillPreparing(u.id))) throw new Cancelled();
    const id = await store.startStep(u.id, name, deps.now());
    try {
      await body();
    } catch (err) {
      await store.endStep(id, 'failed', err instanceof Stop ? err.code : null, deps.now());
      throw err;
    }
    await store.endStep(id, 'passed', null, deps.now());
  };

  const docker = async (args: string[], timeoutMs: number): Promise<RunResult> => {
    if (timeoutMs <= 0) throw new Stop('failed_before_install', 'build_timeout');
    return runner.run('docker', args, { cwd: installDir, timeoutMs });
  };

  try {
    if (remaining() <= 0) {
      log(`The update to ${u.tag} is more than ${PREPARE_LIMIT_MS / 60_000} minutes past its start time and still not prepared.`);
      throw new Stop('failed_before_install', 'build_timeout');
    }
    await step('space', async () => {
      const floor = (await store.safeFloorGb()) * GB;
      let s: ReturnType<StatFs> = null;
      try {
        s = deps.statfs(installDir);
      } catch {
        s = null;
      }
      if (!s || !Number.isFinite(s.free) || s.free < floor + SPACE_MARGIN_GB * GB) {
        log(`Free space ${s ? (s.free / GB).toFixed(1) : 'unknown'} GB; ${(floor / GB + SPACE_MARGIN_GB).toFixed(1)} GB is needed.`);
        throw new Stop('refused', 'no_space_to_build');
      }
    });

    await step('working_tree', async () => {
      const w = await g.workingTreeState(installDir);
      if (!w.clean) {
        log(`The Kainow folder has changes to tracked files: ${w.changed.join(', ')}`);
        throw new Stop('refused', 'local_changes', filesLine(w.changed));
      }
      if (w.headTag !== `v${u.fromVersion}`) {
        log(`The Kainow folder is at ${w.headTag ?? 'no release tag'}, not v${u.fromVersion}.`);
        throw new Stop('refused', 'not_on_release');
      }
    });

    await step('verify', async () => {
      const f = await g.fetchCandidate(installDir, u.tag);
      if (!f.ok) throw new Stop('refused', f.code);
      // A tag object recorded by an earlier attempt must not have changed (a moved or re-pushed tag).
      if (u.tagObject && u.tagObject !== f.tagObject) throw new Stop('refused', 'tag_changed');
      const v = await g.verifyCandidate(installDir, u.tag, f.tagObject, join(installDir, TRUSTED_SIGNERS), {
        commit: u.commit,
        runningVersion: u.fromVersion,
      });
      if (!v.ok) throw new Stop('refused', v.code);
      if (!(await store.saveVerified(u.id, f.tagObject, v.notes))) throw new Cancelled();
      log(`The release ${u.tag} is signed by the release key and points at the approved commit.`);
    });

    await step('staging', async () => {
      const r = await runner.run('git', ['-c', 'advice.detachedHead=false', 'worktree', 'add', '--detach', staging, u.commit], { cwd: installDir });
      if (r.code !== 0) {
        log(`Making the staging checkout failed (${r.code}): ${tail(r)}`);
        throw new Stop('failed_before_install', 'build_failed');
      }
    });

    let apiImage: string | null = null;
    await step('compatibility', async () => {
      const stagingFlags = composeFlags(installDir, deps.projectName, staging);
      const q = await docker([...stagingFlags, 'config', '-q'], Math.min(SHORT_DOCKER_MS, remaining()));
      if (q.code === CODE_TIMEOUT) throw new Stop('failed_before_install', 'build_timeout');
      if (q.code !== 0) {
        // Never the output itself: it can quote the .env file.
        const name = missingVariable(q.stderr);
        log(`The new release's settings do not resolve (${q.code})${name ? `: ${name} is not set in .env` : ''}.`);
        throw new Stop('refused', 'settings_missing', name ? `Setting: ${name}.` : '');
      }
      const next = await docker([...stagingFlags, 'config', '--format', 'json'], Math.min(SHORT_DOCKER_MS, remaining()));
      const running = await docker(
        [...composeFlags(installDir, deps.projectName, installDir), 'config', '--format', 'json'],
        Math.min(SHORT_DOCKER_MS, remaining()),
      );
      if (next.code === CODE_TIMEOUT || running.code === CODE_TIMEOUT) throw new Stop('failed_before_install', 'build_timeout');
      if (next.code !== 0 || running.code !== 0) {
        log(`Reading the resolved Compose configuration failed (${next.code}, ${running.code}).`);
        throw new Stop('refused', 'settings_missing');
      }
      const a = dbServiceOf(running.stdout, installDir, installDir);
      const b = dbServiceOf(next.stdout, staging, installDir);
      if (!a || !b || JSON.stringify(a) !== JSON.stringify(b)) {
        log(`The new release's db service differs from the running one (image, volumes or environment names).`);
        throw new Stop('refused', 'db_service_changed');
      }
      apiImage = apiImageOf(next.stdout);

      const has = await runner.run('git', ['cat-file', '-e', `${u.commit}:${REQUIREMENTS}`], { cwd: installDir });
      if (has.code === 0) {
        const show = await runner.run('git', ['show', `${u.commit}:${REQUIREMENTS}`], { cwd: installDir });
        let req: Requirements | null = null;
        try {
          req = show.code === 0 ? (JSON.parse(show.stdout) as Requirements | null) : null;
        } catch {
          req = null;
        }
        if (!req || typeof req !== 'object') {
          log(`The release's ${REQUIREMENTS} could not be read; it is installed by hand.`);
          throw new Stop('refused', 'manual_install');
        }
        if (req.manual === true) {
          const note = typeof req.note === 'string' ? req.note.trim().slice(0, 1000) : '';
          log(`The release must be installed by hand${note ? `: ${note}` : '.'}`);
          throw new Stop('refused', 'manual_install', note ? `Release note: ${note}` : '');
        }
        if (req.minimumFrom !== undefined) {
          const min = typeof req.minimumFrom === 'string' ? parseTag(`v${req.minimumFrom.replace(/^v/, '')}`) : null;
          const run = parseTag(`v${u.fromVersion}`);
          if (!min || !run) throw new Stop('refused', 'upgrade_path');
          if (compareVersions(run, min) < 0) {
            const first = `v${(req.minimumFrom as string).replace(/^v/, '')}`;
            log(`The release needs ${first} or later to be installed first.`);
            throw new Stop('refused', 'upgrade_path', `Install ${first} first.`);
          }
        }
      }
    });

    await step('build', async () => {
      const b = await docker([...composeFlags(installDir, deps.projectName, staging), 'build'], remaining());
      if (b.code === CODE_TIMEOUT) {
        log(`Building ${u.tag} took longer than the preparation's limit.`);
        throw new Stop('failed_before_install', 'build_timeout');
      }
      if (b.code !== 0) {
        log(`Building ${u.tag} failed (${b.code}): ${tail(b)}`);
        throw new Stop('failed_before_install', 'build_failed');
      }
      // The built image carries the release's version (spec 5.4 step 6).
      if (!apiImage) throw new Stop('failed_before_install', 'build_failed');
      const v = await docker(
        ['run', '--rm', '--network', 'none', '--entrypoint', 'node', apiImage, '-p', "require('/app/package.json').version"],
        Math.min(SHORT_DOCKER_MS, remaining()),
      );
      if (v.code === CODE_TIMEOUT) throw new Stop('failed_before_install', 'build_timeout');
      if (v.code !== 0 || v.stdout.trim() !== u.toVersion) {
        log(`The built image ${apiImage} does not carry version ${u.toVersion} (${v.code}): ${tail(v)}`);
        throw new Stop('failed_before_install', 'build_failed');
      }
    });

    // A cancel during the build wins: finish only moves a row that is still preparing.
    if (!(await store.finish(u.id, { state: 'ready' }, deps.now()))) throw new Cancelled();
    log(`The update to ${u.tag} is ready for its window.`);
    return 'ready';
  } catch (err) {
    if (err instanceof Cancelled) {
      await removeStaging();
      log(`The update to ${u.tag} was cancelled during preparation; the staging checkout is removed.`);
      return 'cancelled';
    }
    if (!(err instanceof Stop)) {
      // Unexpected (the database or git could not be reached): tidy, and leave the row for the next tick.
      await removeStaging().catch(() => undefined);
      throw err;
    }
    await removeStaging();
    await runner.run('git', ['update-ref', '-d', `refs/kainow/candidate/${u.tag}`], { cwd: installDir });
    const state = BUILD_CODES.includes(err.code) ? 'failed_before_install' : err.state;
    const written = await store.finish(u.id, { state, code: err.code, tag: u.tag, summary: summaryFor(u.tag, err) }, deps.now());
    if (!written) {
      log(`The update to ${u.tag} was cancelled during preparation; the staging checkout is removed.`);
      return 'cancelled';
    }
    log(`The update to ${u.tag} ended ${state}: ${err.code}.`);
    return state;
  }
}

/** The store over the database: every state change under the updates service's lock, so a cancel and the tick agree. */
export function pgPrepareStore(pool: Pool): PrepareStore {
  const inLock = async <T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    let broken = false;
    try {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('kainow.updates'))`);
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
  };
  const change = (c: import('pg').PoolClient, id: string, now: Date, detail: Record<string, unknown>) =>
    c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'state_changed', NULL, NULL, $4)`, [
      uuidv7(now.getTime()),
      id,
      now,
      JSON.stringify(detail),
    ]);

  return {
    begin: (id, now) =>
      inLock(async (c) => {
        const r = await c.query(
          `UPDATE updates u SET state = 'preparing'
             FROM (SELECT id, state AS old FROM updates WHERE id = $1 FOR UPDATE) o
            WHERE u.id = o.id AND o.old IN ('approved', 'preparing')
          RETURNING o.old`,
          [id],
        );
        if (r.rowCount !== 1) return false;
        if (r.rows[0].old === 'approved') await change(c, id, now, { from: 'approved', to: 'preparing' });
        // Steps a dead tick left running are closed as failed; this attempt records its own.
        await c.query(`UPDATE update_steps SET outcome = 'failed', finished_at = $2 WHERE update_id = $1 AND outcome = 'running'`, [id, now]);
        return true;
      }),
    async stillPreparing(id) {
      const r = await pool.query(`SELECT state FROM updates WHERE id = $1`, [id]);
      return r.rows[0]?.state === 'preparing';
    },
    async startStep(id, step, now) {
      const stepId = uuidv7(now.getTime());
      await pool.query(`INSERT INTO update_steps (id, update_id, step, started_at, outcome) VALUES ($1, $2, $3, $4, 'running')`, [stepId, id, step, now]);
      return stepId;
    },
    async endStep(stepId, outcome, code, now) {
      await pool.query(`UPDATE update_steps SET outcome = $2, failure_code = $3, finished_at = $4 WHERE id = $1 AND outcome = 'running'`, [
        stepId,
        outcome,
        code,
        now,
      ]);
    },
    async saveVerified(id, tagObject, notes) {
      const r = await pool.query(`UPDATE updates SET tag_object = $2, release_notes = $3 WHERE id = $1 AND state = 'preparing'`, [
        id,
        tagObject,
        notes || null,
      ]);
      return r.rowCount === 1;
    },
    finish: (id, end, now) =>
      inLock(async (c) => {
        if (end.state === 'ready') {
          const r = await c.query(`UPDATE updates SET state = 'ready' WHERE id = $1 AND state = 'preparing'`, [id]);
          if (r.rowCount !== 1) return false;
          await change(c, id, now, { from: 'preparing', to: 'ready' });
          return true;
        }
        const r = await c.query(
          `UPDATE updates SET state = $2, failure_code = $3, finished_at = $4 WHERE id = $1 AND state = 'preparing'`,
          [id, end.state, end.code, now],
        );
        if (r.rowCount !== 1) return false;
        await change(c, id, now, { from: 'preparing', to: end.state, failureCode: end.code });
        const audit = { at: now, actorUserId: null, subjectType: 'update', subjectId: id, detail: { tag: end.tag, failureCode: end.code } };
        if (end.state === 'refused') await auditUpdateRefused(c, audit);
        else await auditUpdateFailed(c, audit);
        await notifyAdmins(c, {
          kind: end.state === 'refused' ? 'update_refused' : 'update_failed',
          summary: end.summary,
          link: LINK,
          now,
          urgent: true,
        });
        return true;
      }),
    async safeFloorGb() {
      return (await loadOpsSettings(pool)).safeFloorGb;
    },
  };
}
