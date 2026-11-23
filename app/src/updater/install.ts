/**
 * Installing a ready update at its window (10b spec 5.5), going back before the migration (5.6) and the failed-migration
 * path (5.7), with re-entry after the updater died at any step (7.1).
 *
 *   recheck → maintenance_on → backup → stop → switch_code → migrate → start → health → maintenance_off → tidy
 *                                 │         └──────┬──────┘      └─────────┬─────────┘
 *        (nothing stopped yet) ───┘          go_back (5.6)          notice_page (5.7)
 *
 * - `recheck` runs while the row is still `ready` and ends with the conditional move to `installing` under the updates
 *   service's lock (a cancel or a new time wins until that moment). A tag object that changed since preparation is
 *   refused (`tag_changed`) before anything is touched (Review Focus 1).
 * - `maintenance_on` sets update maintenance and waits 15 s (the 5 s state cache plus 10 s) before the pre-update backup
 *   starts, so every process refuses saves from then on (Review Focus 3).
 * - `migrate` is the point of no return: its step row is written before the command starts, so a crash from that moment
 *   is always handled as failed after migration.
 * - Re-entry (an `installing` row found with the updater's lock free) never continues forward except after `health`
 *   passed: before the migration it goes back, after it it follows 5.7 (resumePoint). Every action on the way back is
 *   idempotent, so a crash while going back is handled by going back again (Review Focus 2). Maintenance is turned off
 *   only with the previous code running and healthy, or the new code healthy; never half-switched.
 *
 * Only api, worker and migrate are stopped, recreated or run (`--no-deps`); the db container is never restarted, so the
 * updater's own database connection (which holds the tick's session lock) stays up throughout.
 *
 * After the migration started nothing is written to the email outbox or notices (the database is set aside by
 * `recover`, PO decision (a)); the operator learns of it through the cron log line (spec 5.7 step 4).
 */
import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { notifyAdmins } from '../ops/notify';
import { loadOpsSettings } from '../ops/settings';
import { enterProtective } from '../ops/storage-check';
import { auditUpdateFailed, auditUpdateRefused, auditUpdateSucceeded } from './audit';
import { mailUpdateEnded } from './people-mail';
import { fetchCandidate, workingTreeState } from './git';
import { composeFlags, stagingDir } from './prepare';
import { maskSecrets, type RunResult, type Runner } from './runner';
import { FAILURE_TEXT, WINDOW_GRACE_MS, windowMissed, type FailureCode, type UpdateState } from './states';
import { TRUSTED_SIGNERS, recoveryLine, type TickUpdate } from './tick';
import { parseTag } from './version';

/** The update as the tick read it. */
export type UpdateRow = TickUpdate;

/** Spec 5.5 step 2: the state cache's 5 seconds plus 10. */
export const MAINTENANCE_WAIT_MS = 15_000;
/** Spec 5.5 step 3: while the backup lock is held, retry every minute for up to 30 minutes. */
export const BACKUP_RETRY_MS = 60_000;
export const BACKUP_BUSY_LIMIT_MS = 30 * 60_000;
/** The pre-update backup's own limit (a full backup of a large database; 10a's backup has its own inner limits). */
export const BACKUP_TIMEOUT_MS = 4 * 60 * 60_000;
/** The migration's limit: beyond it the update has failed after the migration. */
export const MIGRATE_TIMEOUT_MS = 60 * 60_000;
/** Spec 5.5 step 8: all health checks within 10 minutes; the worker up 60 seconds without restarting. */
export const HEALTH_LIMIT_MS = 10 * 60_000;
export const WORKER_UP_MS = 60_000;
export const HEALTH_POLL_MS = 5_000;
const SHORT_MS = 2 * 60_000;
const LINK = '#/admin/operations';
const LOG_TAIL = 8000;
/** The trusted signers file as it was before switch_code copied the release's own (restored when going back). */
export const PREVIOUS_SIGNERS = `${TRUSTED_SIGNERS}.previous`;
const RELEASE_SIGNERS = join('release', 'release-signers');
/** Kainow's images (spec 5.4 step 6); tidy removes those of any version but the running and the previous one. */
const KAINOW_IMAGES = ['kainow-app', 'kainow-ops', 'kainow-updater'];

export const INSTALL_STEPS = [
  'recheck', 'maintenance_on', 'backup', 'stop', 'switch_code', 'migrate', 'start', 'health', 'maintenance_off', 'tidy',
  'go_back', 'notice_page',
] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

export interface StepRow {
  step: string;
  outcome: 'running' | 'passed' | 'failed' | 'skipped';
  failureCode: FailureCode | null;
}

export type ResumePoint = { kind: 'continue_from'; step: InstallStep } | { kind: 'go_back' } | { kind: 'failed_after_migration' };

/**
 * Where an `installing` row found by a later tick resumes (spec 7.1): any started `migrate` step means failed after the
 * migration, unless `health` passed (then only maintenance off and tidy are left); otherwise go back.
 */
export function resumePoint(steps: StepRow[]): ResumePoint {
  if (!steps.some((s) => s.step === 'migrate')) return { kind: 'go_back' };
  if (steps.some((s) => s.step === 'health' && s.outcome === 'passed')) return { kind: 'continue_from', step: 'maintenance_off' };
  return { kind: 'failed_after_migration' };
}

/** Refusals: the release or the folder is not as approved; nothing was touched. */
const REFUSED_CODES: readonly FailureCode[] = ['tag_changed', 'fetch_failed', 'local_changes', 'not_on_release'];
const endStateFor = (code: FailureCode): 'refused' | 'failed_before_install' =>
  REFUSED_CODES.includes(code) ? 'refused' : 'failed_before_install';

const ORDER = (s: string): number => {
  const i = (INSTALL_STEPS as readonly string[]).indexOf(s);
  return i === -1 ? Infinity : i;
};

/** The failure code a re-entry records: the first recorded code, else what the interrupted step stands for. */
function reentryCode(steps: StepRow[], phase: 'before' | 'after'): FailureCode {
  const coded = steps.filter((s) => s.failureCode).sort((a, b) => ORDER(a.step) - ORDER(b.step));
  if (coded.length) return coded[0].failureCode!;
  const names = new Set(steps.map((s) => s.step));
  if (phase === 'after') {
    if (names.has('health')) return 'health_failed';
    if (names.has('start')) return 'start_failed';
    return 'migration_failed';
  }
  if (names.has('backup') && !names.has('stop') && !names.has('switch_code')) return 'backup_failed';
  // Interrupted before the backup (recheck, maintenance on) or while stopping or switching: not put in place.
  return 'checkout_failed';
}

/** The run id on the backup command's last line (`run <id> succeeded`). */
export function lastRunId(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = /\brun ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(lines.at(-1) ?? '');
  return m ? m[1].toLowerCase() : null;
}

type PsRow = { ID?: string; Service?: string; State?: string; Health?: string };

/** `docker compose ps --format json`: a JSON array (older Compose) or one object per line (newer). */
export function parsePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    if (text.startsWith('[')) return JSON.parse(text) as PsRow[];
    return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as PsRow);
  } catch {
    return [];
  }
}

/** The git steps of git.ts the re-check needs; tests replace them. */
export interface InstallGit {
  fetchCandidate: typeof fetchCandidate;
  workingTreeState: typeof workingTreeState;
}

export interface InstallDeps {
  pool: Pool;
  runner: Runner;
  /** The Kainow folder: the installation's checkout, .env and compose.override.yaml. */
  installDir: string;
  /** The running installation's Compose project name (resolveProjectName). */
  projectName: string;
  now: () => Date;
  log: (line: string) => void;
  /** Waits; tests advance a clock instead. */
  sleep?: (ms: number) => Promise<void>;
  git?: InstallGit;
}

export type BeforeEnd = { state: 'refused' | 'failed_before_install'; code: FailureCode; tag: string; summary: string };

/** What installing records; the database store is pgInstallStore, tests use one in memory. */
export interface InstallStore {
  /** Steps a dead attempt left running are closed as failed. */
  closeRunning(id: string, now: Date): Promise<void>;
  /**
   * Under the updates lock: ready, due and not more than 60 minutes past its start (D125) → installing; false when
   * cancelled, rescheduled, no longer ready or too late.
   */
  begin(id: string, now: Date): Promise<boolean>;
  /** Re-entry, under the updates lock: the recorded steps when the row is still installing (running ones then closed). */
  reenter(id: string, now: Date): Promise<StepRow[] | null>;
  /** The row's state now. */
  stateOf(id: string): Promise<UpdateState | null>;
  startStep(id: string, step: InstallStep, now: Date): Promise<string>;
  endStep(stepId: string, outcome: 'passed' | 'failed' | 'skipped', code: FailureCode | null, now: Date): Promise<void>;
  /** Protective mode now, and the update it is for when its reason is `update`. */
  protective(): Promise<{ protective: boolean; reason: string | null; updateId: string | null }>;
  /** Update maintenance for this update: true when it is on for it now; false when protective mode is on for another reason. */
  maintenanceOn(id: string, version: string, now: Date): Promise<boolean>;
  savePreUpdateRun(id: string, runId: string): Promise<void>;
  /**
   * Under the updates lock, only from `from`: the end before installing (refused or failed_before_install), with update
   * maintenance for this update cleared, the audit event and the Administrators' notice. False when the row had moved on.
   */
  endBefore(id: string, from: 'ready' | 'installing', end: BeforeEnd, now: Date): Promise<boolean>;
  /** Under the updates lock: maintenance off, succeeded, the step ended, audit and notice; one transaction. */
  succeed(id: string, stepId: string, tag: string, now: Date): Promise<void>;
  /** failed_after_migration | failed_needs_attention, without notices or emails (callers treat a failure as logged only). */
  failAfter(id: string, state: 'failed_after_migration' | 'failed_needs_attention', code: FailureCode, tag: string, now: Date): Promise<void>;
}

class Fail {
  constructor(readonly code: FailureCode) {}
}

const tail = (r: RunResult): string => maskSecrets(`${r.stdout}\n${r.stderr}`.trim().slice(-LOG_TAIL));

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

function beforeSummary(tag: string, state: 'refused' | 'failed_before_install', code: FailureCode): string {
  return state === 'refused'
    ? `The update to ${tag} was refused: ${FAILURE_TEXT[code]}`
    : `The update to ${tag} failed before installing; Kainow is running the previous version. ${FAILURE_TEXT[code]}`;
}

/** What waitHealthy needs: `compose` runs `docker compose` with the installation's flags. */
export interface HealthDeps {
  runner: Runner;
  installDir: string;
  compose: (args: string[], timeoutMs?: number) => Promise<RunResult>;
  /** The clock, in milliseconds. */
  now: () => number;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Spec 5.5 step 8, all within 10 minutes: the api container healthy, the worker running 60 seconds without a restart,
 * then the post-update check (migration level and version) for `version`. Also used by `recover` (spec 5.9 step 7).
 */
export async function waitHealthy(h: HealthDeps, version: string): Promise<boolean> {
  const { runner, installDir, compose, log } = h;
  const ms = h.now;
  const deadline = ms() + HEALTH_LIMIT_MS;
  let worker: { key: string; since: number } | null = null;
  for (;;) {
    const ps = await compose(['ps', '--all', '--format', 'json']);
    const rows = ps.code === 0 ? parsePs(ps.stdout) : [];
    const api = rows.find((r) => r.Service === 'api');
    const w = rows.find((r) => r.Service === 'worker');
    const apiOk = api?.State === 'running' && api?.Health === 'healthy';
    let workerOk = false;
    if (w?.State === 'running' && w.ID) {
      const ins = await runner.run('docker', ['inspect', '--format', '{{.RestartCount}} {{.State.StartedAt}}', w.ID], {
        cwd: installDir,
        timeoutMs: SHORT_MS,
      });
      if (ins.code === 0) {
        // Running without a restart: the same container, restart count and start time, observed for 60 seconds.
        const key = `${w.ID} ${ins.stdout.trim()}`;
        if (!worker || worker.key !== key) worker = { key, since: ms() };
        workerOk = ms() - worker.since >= WORKER_UP_MS;
      } else worker = null;
    } else worker = null;
    if (apiOk && workerOk) {
      const pc = await compose(['run', '--rm', '--no-deps', 'api', 'node', 'dist/updater/post-check-cli.js', '--expect', version]);
      if (pc.code === 0) return true;
      log(`The post-update check failed for ${version} (${pc.code}): ${tail(pc)}`);
      return false;
    }
    if (ms() >= deadline) {
      log(`Kainow ${version} did not pass its health checks within ${HEALTH_LIMIT_MS / 60_000} minutes (api ${api?.State ?? 'missing'}/${api?.Health ?? '-'}, worker ${w?.State ?? 'missing'}).`);
      return false;
    }
    await h.sleep(HEALTH_POLL_MS);
  }
}

/** Installs one update; the tick calls this for a due `ready` row and for an `installing` row (re-entry). */
export function installUpdate(deps: InstallDeps, update: UpdateRow): Promise<UpdateState> {
  return installWithStore(deps, pgInstallStore(deps.pool), update);
}

export async function installWithStore(deps: Omit<InstallDeps, 'pool'>, store: InstallStore, u: UpdateRow): Promise<UpdateState> {
  const g = deps.git ?? { fetchCandidate, workingTreeState };
  const { runner, installDir, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ms = () => deps.now().getTime();
  const flags = composeFlags(installDir, deps.projectName, installDir);
  const compose = (args: string[], timeoutMs = SHORT_MS) => runner.run('docker', [...flags, ...args], { cwd: installDir, timeoutMs });
  const previousTag = `v${u.fromVersion}`;
  const trusted = join(installDir, TRUSTED_SIGNERS);
  const previous = join(installDir, PREVIOUS_SIGNERS);

  /** Runs one step: recorded running before the body starts, then passed, or failed with the body's code. */
  const step = async (name: InstallStep, body: () => Promise<void>): Promise<void> => {
    const id = await store.startStep(u.id, name, deps.now());
    try {
      await body();
    } catch (err) {
      if (err instanceof Fail) await store.endStep(id, 'failed', err.code, deps.now());
      throw err;
    }
    await store.endStep(id, 'passed', null, deps.now());
  };

  // ---- the trusted signers file (spec 4.3) ----
  /** Keeps the trusted file as it is now, so going back can restore it (a write then a rename: never half a file). */
  const keepSigners = async () => {
    if (!(await exists(trusted))) return;
    await copyFile(trusted, `${previous}.tmp`);
    await rename(`${previous}.tmp`, previous);
  };
  /** The release's own file becomes the trusted one (it verified against the trusted file as it was). */
  const takeReleaseSigners = async () => {
    const source = join(installDir, RELEASE_SIGNERS);
    if (!(await exists(source))) {
      log(`The release ${u.tag} has no ${RELEASE_SIGNERS}; the trusted signers file is kept.`);
      return;
    }
    await copyFile(source, `${trusted}.tmp`);
    await rename(`${trusted}.tmp`, trusted);
  };
  /** Idempotent: puts the kept file back when there is one. Only after switch_code started (it wrote the kept file). */
  const restoreSigners = async (): Promise<boolean> => {
    try {
      await rm(`${trusted}.tmp`, { force: true });
      await rm(`${previous}.tmp`, { force: true });
      if (await exists(previous)) await rename(previous, trusted);
      return true;
    } catch (err) {
      log(`Restoring the trusted signers file failed: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
      return false;
    }
  };

  const healthy = (version: string) => waitHealthy({ runner, installDir, compose, now: ms, log, sleep }, version);

  /**
   * Final review M3: after an end before installing, the staging checkout and the candidate ref are of no further use
   * (a new approval prepares again). Best effort; the release's built images go at the next successful update's tidy.
   */
  const dropStaging = async () => {
    try {
      const staging = stagingDir(installDir, u.tag);
      await runner.run('git', ['worktree', 'remove', '--force', staging], { cwd: installDir });
      await runner.run('git', ['worktree', 'prune'], { cwd: installDir });
      await rm(staging, { recursive: true, force: true });
      await runner.run('git', ['update-ref', '-d', `refs/kainow/candidate/${u.tag}`], { cwd: installDir });
    } catch (err) {
      log(`Removing the staging checkout failed: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  };

  /**
   * The object `refs/tags/<tag>` names in the Kainow folder: null when there is no such tag, undefined when git could
   * not say. switch_code creates it, so the next update finds the folder on a release tag (and going back, the failed
   * path and `recover` find the previous version by its tag name).
   */
  const localTag = async (): Promise<string | null | undefined> => {
    const r = await runner.run('git', ['for-each-ref', '--format=%(objectname)', `refs/tags/${u.tag}`], { cwd: installDir });
    if (r.code !== 0) return undefined;
    const id = r.stdout.trim().toLowerCase();
    return id ? id : null;
  };

  // ---- endings ----
  /** Spec 5.7, or 5.6's last paragraph (no migration): stop, previous code, notice page, best-effort record, log line. */
  const failedAfter = async (state: 'failed_after_migration' | 'failed_needs_attention', code: FailureCode): Promise<UpdateState> => {
    const bestEffort = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (err) {
        log(`${what} could not be recorded: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
        return undefined;
      }
    };
    const stepId = await bestEffort('The notice page step', () => store.startStep(u.id, 'notice_page', deps.now()));
    const stop = await compose(['stop', 'api', 'worker']);
    if (stop.code !== 0) log(`Stopping api and worker failed (${stop.code}): ${tail(stop)}`);
    // Back to the previous code at once, so the notice page and `recover` run on the previous version's images.
    const back = await runner.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', previousTag], { cwd: installDir });
    if (back.code !== 0) log(`Checking out ${previousTag} failed (${back.code}): ${tail(back)}`);
    await restoreSigners();
    const notice = await compose(['up', '-d', '--no-deps', 'notice']);
    if (notice.code !== 0) log(`Starting the notice page failed (${notice.code}): ${tail(notice)}`);
    if (stepId) await bestEffort('The notice page step', () => store.endStep(stepId, notice.code === 0 ? 'passed' : 'failed', notice.code === 0 ? null : code, deps.now()));
    await bestEffort('The update state', () => store.failAfter(u.id, state, code, u.tag, deps.now()));
    log(`The update to ${u.tag} ended ${state}: ${code}.`);
    log(recoveryLine(state, u.tag));
    return state;
  };

  /** Spec 5.6: previous code and images, health, then maintenance off and the end recorded. Idempotent. */
  const goBack = async (code: FailureCode, stopped: boolean, switched: boolean, noticeStarted = false): Promise<UpdateState> => {
    const end = endStateFor(code);
    if (stopped || switched) {
      const stepId = await store.startStep(u.id, 'go_back', deps.now());
      let ok = true;
      if (switched) {
        const r = await runner.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', previousTag], { cwd: installDir });
        if (r.code !== 0) {
          log(`Going back: checking out ${previousTag} failed (${r.code}): ${tail(r)}`);
          ok = false;
        }
      }
      if (switched && !(await restoreSigners())) ok = false;
      if (ok) {
        // A re-entry after a failed going back may find the notice page on Kainow's port (final review #30).
        if (noticeStarted) await compose(['stop', 'notice']);
        const up = await compose(['up', '-d', '--no-deps', 'api', 'worker'], 10 * 60_000);
        if (up.code !== 0) {
          log(`Going back: starting api and worker on ${previousTag} failed (${up.code}): ${tail(up)}`);
          ok = false;
        } else ok = await healthy(u.fromVersion);
      }
      if (!ok) {
        await store.endStep(stepId, 'failed', 'rollback_failed', deps.now());
        return failedAfter('failed_needs_attention', 'rollback_failed');
      }
      await store.endStep(stepId, 'passed', null, deps.now());
    }
    await store.endBefore(u.id, 'installing', { state: end, code, tag: u.tag, summary: beforeSummary(u.tag, end, code) }, deps.now());
    log(`The update to ${u.tag} ended ${end}: ${code}. Kainow is on ${previousTag}.`);
    await dropStaging();
    return end;
  };

  const maintenanceOffAndTidy = async (): Promise<UpdateState> => {
    const stepId = await store.startStep(u.id, 'maintenance_off', deps.now());
    await store.succeed(u.id, stepId, u.tag, deps.now());
    log(`The update to ${u.tag} succeeded.`);
    await tidy();
    return 'succeeded';
  };

  /** Spec 5.5 step 10, only after succeeded: failures are logged only; the next successful update tidies again. */
  const tidy = async () => {
    try {
      await step('tidy', async () => {
        const staging = stagingDir(installDir, u.tag);
        await runner.run('git', ['worktree', 'remove', '--force', staging], { cwd: installDir });
        await runner.run('git', ['worktree', 'prune'], { cwd: installDir });
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await runner.run('git', ['update-ref', '-d', `refs/kainow/candidate/${u.tag}`], { cwd: installDir });
        await rm(previous, { force: true });
        const from = parseTag(previousTag);
        const ls = await runner.run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { cwd: installDir, timeoutMs: SHORT_MS });
        if (ls.code !== 0 || !from) return;
        for (const ref of ls.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const i = ref.lastIndexOf(':');
          const [repo, tag] = [ref.slice(0, i), ref.slice(i + 1)];
          const v = parseTag(`v${tag}`);
          // Older than the previous version, or left by a failed newer release (final review M3).
          if (!KAINOW_IMAGES.includes(repo) || !v || tag === u.fromVersion || tag === u.toVersion) continue;
          const rmi = await runner.run('docker', ['image', 'rm', ref], { cwd: installDir, timeoutMs: SHORT_MS });
          if (rmi.code !== 0) log(`Removing the old image ${ref} failed (${rmi.code}); it is kept.`);
        }
      });
    } catch (err) {
      log(`Tidying after the update failed: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  };

  // ---- re-entry ----
  if (u.state === 'installing') {
    const steps = await store.reenter(u.id, deps.now());
    if (!steps) {
      log(`The update to ${u.tag} is no longer installing; nothing to do.`);
      return (await store.stateOf(u.id)) ?? u.state;
    }
    const ours = steps.filter((s) => ORDER(s.step) !== Infinity);
    const at = resumePoint(ours);
    log(`The updater stopped during the update to ${u.tag}; resuming (${at.kind === 'continue_from' ? `from ${at.step}` : at.kind}).`);
    if (at.kind === 'continue_from') return maintenanceOffAndTidy();
    if (at.kind === 'failed_after_migration') return failedAfter('failed_after_migration', reentryCode(ours, 'after'));
    const names = new Set(ours.map((s) => s.step));
    return goBack(reentryCode(ours, 'before'), names.has('stop'), names.has('switch_code'), names.has('notice_page'));
  }
  if (u.state !== 'ready') {
    log(`The update to ${u.tag} is ${u.state}; nothing to install.`);
    return u.state;
  }

  // ---- 1. re-check, then ready → installing ----
  await store.closeRunning(u.id, deps.now());
  const recheckId = await store.startStep(u.id, 'recheck', deps.now());
  let problem: FailureCode | null = null;
  try {
    // D125: more than 60 minutes past its start (the updater did not run in time) it is not installed; re-approve.
    if (windowMissed(u.startsAt, deps.now())) {
      log(`The update to ${u.tag} is more than ${WINDOW_GRACE_MS / 60_000} minutes past its start time; it is not installed.`);
      problem = 'window_missed';
    }
    const p = problem ? null : await store.protective();
    if (p?.protective && !(p.reason === 'update' && p.updateId === u.id)) problem = 'protective_on';
    if (!problem) {
      const w = await g.workingTreeState(installDir);
      if (!w.clean) {
        log(`The Kainow folder has changes to tracked files: ${w.changed.join(', ')}`);
        problem = 'local_changes';
      } else if (w.headTag !== previousTag) {
        log(`The Kainow folder is at ${w.headTag ?? 'no release tag'}, not ${previousTag}.`);
        problem = 'not_on_release';
      }
    }
    if (!problem) {
      // Review Focus 1: the tag object verified at preparation, and through it the approved commit.
      const f = await g.fetchCandidate(installDir, u.tag);
      if (!f.ok) problem = 'fetch_failed';
      else if (!u.tagObject || f.tagObject !== u.tagObject) problem = 'tag_changed';
      else {
        const c = await runner.run('git', ['rev-parse', '--verify', '--quiet', `${f.tagObject}^{commit}`], { cwd: installDir });
        if (c.code !== 0 || c.stdout.trim().toLowerCase() !== u.commit.trim().toLowerCase()) problem = 'tag_changed';
      }
    }
    if (!problem) {
      // switch_code records the release as a local tag; one already there must be the verified object.
      const local = await localTag();
      if (local === undefined || (local !== null && local !== u.tagObject?.toLowerCase())) {
        log(`The local tag ${u.tag} is not the verified release tag.`);
        problem = 'tag_changed';
      }
    }
  } catch (err) {
    await store.endStep(recheckId, 'failed', null, deps.now());
    throw err;
  }
  if (problem) {
    await store.endStep(recheckId, 'failed', problem, deps.now());
    const end = endStateFor(problem);
    const written = await store.endBefore(u.id, 'ready', { state: end, code: problem, tag: u.tag, summary: beforeSummary(u.tag, end, problem) }, deps.now());
    if (!written) return (await store.stateOf(u.id)) ?? u.state;
    log(`The update to ${u.tag} ended ${end}: ${problem}. Nothing was changed.`);
    await dropStaging();
    return end;
  }
  if (!(await store.begin(u.id, deps.now()))) {
    await store.endStep(recheckId, 'skipped', null, deps.now());
    const state = await store.stateOf(u.id);
    // Still ready: the 60 minutes ran out during the re-check; the next tick (or the ops sweep) ends it window_missed.
    log(
      state === 'ready'
        ? `The update to ${u.tag} did not start within ${WINDOW_GRACE_MS / 60_000} minutes of its start time; nothing was changed.`
        : `The update to ${u.tag} was cancelled or moved before it started; nothing was changed.`,
    );
    return state ?? u.state;
  }
  await store.endStep(recheckId, 'passed', null, deps.now());
  log(`Installing the update to ${u.tag}.`);
  // A kept signers file left by an earlier update (its tidy did not run) must never be restored by this one.
  await rm(previous, { force: true });

  try {
    // ---- 2. maintenance on, then the wait every process needs to see it ----
    await step('maintenance_on', async () => {
      if (!(await store.maintenanceOn(u.id, u.toVersion, deps.now()))) throw new Fail('protective_on');
      await sleep(MAINTENANCE_WAIT_MS);
    });

    // ---- 3. the pre-update backup, on the running version's ops image ----
    await step('backup', async () => {
      const first = ms();
      for (;;) {
        const r = await compose(['run', '--rm', 'ops', 'node', 'dist/ops/backup-cli.js', '--kind', 'pre_update'], BACKUP_TIMEOUT_MS);
        if (r.code === 0) {
          const runId = lastRunId(r.stdout);
          if (!runId) {
            log('The pre-update backup did not report its run id.');
            throw new Fail('backup_failed');
          }
          await store.savePreUpdateRun(u.id, runId);
          log(`The pre-update backup succeeded (run ${runId}).`);
          return;
        }
        if (r.code === 3) {
          if (ms() - first >= BACKUP_BUSY_LIMIT_MS) {
            log('Another backup, drill or restore still holds the backup lock after 30 minutes.');
            throw new Fail('backup_busy');
          }
          log('Another backup, drill or restore holds the backup lock; trying again in a minute.');
          await sleep(BACKUP_RETRY_MS);
          continue;
        }
        log(`The pre-update backup failed (${r.code}): ${tail(r)}`);
        throw new Fail('backup_failed');
      }
    });
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    // Nothing was stopped: maintenance off and the end recorded (spec 5.6, step 3).
    return goBack(err.code, false, false);
  }

  let switched = false;
  try {
    // ---- 4. stop ----
    await step('stop', async () => {
      const r = await compose(['stop', 'api', 'worker'], 5 * 60_000);
      if (r.code !== 0) {
        log(`Stopping api and worker failed (${r.code}): ${tail(r)}`);
        throw new Fail('checkout_failed');
      }
    });
    // ---- 5. switch the code ----
    switched = true;
    await step('switch_code', async () => {
      // The release becomes a local tag pointing at the verified tag object ('' = only if there is none yet), so the
      // folder is on a release tag after the switch. A tag already there must be that same object.
      const local = await localTag();
      if (local === undefined) {
        log(`Reading the local tag ${u.tag} failed.`);
        throw new Fail('checkout_failed');
      }
      if (local === null) {
        const t = await runner.run('git', ['update-ref', `refs/tags/${u.tag}`, u.tagObject!, ''], { cwd: installDir });
        if (t.code !== 0) {
          log(`Recording the local tag ${u.tag} failed (${t.code}): ${tail(t)}`);
          throw new Fail('checkout_failed');
        }
      } else if (local !== u.tagObject?.toLowerCase()) {
        log(`The local tag ${u.tag} is not the verified release tag.`);
        throw new Fail('tag_changed');
      }
      try {
        await keepSigners();
      } catch {
        log('Keeping a copy of the trusted signers file failed.');
        throw new Fail('checkout_failed');
      }
      const r = await runner.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', u.commit], { cwd: installDir });
      if (r.code !== 0) {
        log(`Checking out ${u.tag} failed (${r.code}): ${tail(r)}`);
        throw new Fail('checkout_failed');
      }
      try {
        await takeReleaseSigners();
      } catch {
        log('Copying the release signers file failed.');
        throw new Fail('checkout_failed');
      }
    });
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    return goBack(err.code, true, switched);
  }

  try {
    // ---- 6. migrate: the point of no return (its step row is written before the command starts) ----
    await step('migrate', async () => {
      const r = await compose(['run', '--rm', '--no-deps', 'migrate'], MIGRATE_TIMEOUT_MS);
      if (r.code !== 0) {
        log(`The database migration failed (${r.code}): ${tail(r)}`);
        throw new Fail('migration_failed');
      }
    });
    // ---- 7. start ----
    await step('start', async () => {
      const r = await compose(['up', '-d', '--no-deps', 'api', 'worker'], 10 * 60_000);
      if (r.code !== 0) {
        log(`Starting api and worker on ${u.tag} failed (${r.code}): ${tail(r)}`);
        throw new Fail('start_failed');
      }
    });
    // ---- 8. health ----
    await step('health', async () => {
      if (!(await healthy(u.toVersion))) throw new Fail('health_failed');
    });
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    return failedAfter('failed_after_migration', err.code);
  }

  // ---- 9. maintenance off, succeeded; 10. tidy ----
  return maintenanceOffAndTidy();
}

/** `post-check-cli.js --expect X.Y.Z` (spec 5.5 step 8): 0 only when the database and the code agree and the version is X.Y.Z. */
export async function runPostCheck(
  argv: string[],
  deps: { migrationLevel: () => Promise<string>; codeLevel: () => string; version: () => string; log: (line: string) => void },
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--expect' || !parseTag(`v${argv[1]}`)) {
    deps.log('Usage: node dist/updater/post-check-cli.js --expect X.Y.Z');
    return 2;
  }
  const expect = argv[1];
  const [db, code, version] = [await deps.migrationLevel(), deps.codeLevel(), deps.version()];
  if (db !== code) {
    deps.log(`The database's migration level ${db || '(none)'} is not the code's ${code || '(none)'}.`);
    return 1;
  }
  if (version !== expect) {
    deps.log(`The running code is version ${version}, not ${expect}.`);
    return 1;
  }
  deps.log(`Kainow ${version} and its database agree (${code}).`);
  return 0;
}

/** The store over the database. State changes under the updates service's lock, so a cancel and the updater agree. */
export function pgInstallStore(pool: Pool): InstallStore {
  const inLock = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
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
  const change = (c: PoolClient, id: string, now: Date, detail: Record<string, unknown>) =>
    c.query(`INSERT INTO update_changes (id, update_id, at, action, actor_id, reason, detail) VALUES ($1, $2, $3, 'state_changed', NULL, NULL, $4)`, [
      uuidv7(now.getTime()),
      id,
      now,
      JSON.stringify(detail),
    ]);
  /** Ends update maintenance only when it is this update's (Resume cannot; nothing else sets the reason). */
  const clearMaintenance = async (c: PoolClient, id: string, now: Date, outcome: string) => {
    const r = await c.query(
      `UPDATE operations_state SET protective = false, reason = NULL, since = NULL, detail = NULL, changed_by = NULL
        WHERE id AND protective AND reason = 'update' AND detail->>'updateId' = $1`,
      [id],
    );
    if (r.rowCount !== 1) return;
    await c.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'resumed', NULL, NULL, $3)`, [
      uuidv7(now.getTime()),
      now,
      JSON.stringify({ previousReason: 'update', updateId: id, outcome }),
    ]);
    // Final review M4: a low-space reading taken while update maintenance was on could not enter protective mode then
    // (it was already on); the latest database-disk reading decides now, as the storage check would.
    const last = (
      await c.query(
        `SELECT free_bytes, total_bytes FROM storage_readings WHERE location = 'database_disk' AND NOT unavailable ORDER BY at DESC, id DESC LIMIT 1`,
      )
    ).rows[0] as { free_bytes: string | null; total_bytes: string | null } | undefined;
    if (last?.free_bytes != null) {
      const free = Number(last.free_bytes);
      const floor = (await loadOpsSettings(c)).safeFloorGb * 1024 ** 3;
      if (Number.isFinite(free) && free >= 0 && free < floor) {
        const total = last.total_bytes == null ? null : Number(last.total_bytes);
        // A millisecond after the 'resumed' row, so the history lists the two in the order they happened.
        const at = new Date(now.getTime() + 1);
        await enterProtective(c, 'low_space', { location: 'database_disk', freeBytes: free, totalBytes: total, floorBytes: floor }, at);
      }
    }
  };

  let lastStepMs = 0;
  return {
    async closeRunning(id, now) {
      await pool.query(`UPDATE update_steps SET outcome = 'failed', finished_at = $2 WHERE update_id = $1 AND outcome = 'running'`, [id, now]);
    },
    begin: (id, now) =>
      inLock(async (c) => {
        const r = await c.query(
          `UPDATE updates SET state = 'installing'
            WHERE id = $1 AND state = 'ready' AND starts_at <= $2 AND starts_at >= $2 - make_interval(secs => $3::double precision) RETURNING id`,
          [id, now, WINDOW_GRACE_MS / 1000],
        );
        if (r.rowCount !== 1) return false;
        await change(c, id, now, { from: 'ready', to: 'installing' });
        return true;
      }),
    reenter: (id, now) =>
      inLock(async (c) => {
        const s = await c.query(`SELECT state FROM updates WHERE id = $1 FOR UPDATE`, [id]);
        if (s.rows[0]?.state !== 'installing') return null;
        const steps = (
          await c.query(`SELECT step, outcome, failure_code FROM update_steps WHERE update_id = $1 ORDER BY started_at, id`, [id])
        ).rows.map((r) => ({ step: r.step, outcome: r.outcome, failureCode: r.failure_code }) as StepRow);
        await c.query(`UPDATE update_steps SET outcome = 'failed', finished_at = $2 WHERE update_id = $1 AND outcome = 'running'`, [id, now]);
        return steps;
      }),
    async stateOf(id) {
      return ((await pool.query(`SELECT state FROM updates WHERE id = $1`, [id])).rows[0]?.state as UpdateState | undefined) ?? null;
    },
    async startStep(id, step, now) {
      // Steps started within the same millisecond still list in the order they ran (ORDER BY started_at, id).
      lastStepMs = Math.max(now.getTime(), lastStepMs + 1);
      const stepId = uuidv7(lastStepMs);
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
    async protective() {
      const r = (await pool.query(`SELECT protective, reason, detail->>'updateId' AS update_id FROM operations_state WHERE id`)).rows[0];
      return { protective: r?.protective === true, reason: r?.reason ?? null, updateId: r?.update_id ?? null };
    },
    async maintenanceOn(id, version, now) {
      const c = await pool.connect();
      let broken = false;
      try {
        await c.query('BEGIN');
        try {
          const cur = (await c.query(`SELECT protective, reason, detail->>'updateId' AS update_id FROM operations_state WHERE id FOR UPDATE`)).rows[0];
          let on: boolean;
          if (cur?.protective) on = cur.reason === 'update' && cur.update_id === id;
          else {
            const detail = { updateId: id, version };
            await c.query(`UPDATE operations_state SET protective = true, reason = 'update', since = $1, detail = $2, changed_by = NULL WHERE id`, [
              now,
              JSON.stringify(detail),
            ]);
            await c.query(`INSERT INTO operations_state_changes (id, at, action, actor_id, reason, detail) VALUES ($1, $2, 'entered', NULL, 'update', $3)`, [
              uuidv7(now.getTime()),
              now,
              JSON.stringify(detail),
            ]);
            on = true;
          }
          await c.query('COMMIT');
          return on;
        } catch (err) {
          await c.query('ROLLBACK').catch(() => (broken = true));
          throw err;
        }
      } finally {
        c.release(broken);
      }
    },
    async savePreUpdateRun(id, runId) {
      await pool.query(`UPDATE updates SET pre_update_backup_run_id = $2 WHERE id = $1 AND state = 'installing'`, [id, runId]);
    },
    endBefore: (id, from, end, now) =>
      inLock(async (c) => {
        const r = await c.query(`UPDATE updates SET state = $2, failure_code = $3, finished_at = $4 WHERE id = $1 AND state = $5`, [
          id,
          end.state,
          end.code,
          now,
          from,
        ]);
        await clearMaintenance(c, id, now, end.state);
        if (r.rowCount !== 1) return false;
        await change(c, id, now, { from, to: end.state, failureCode: end.code });
        const audit = { at: now, actorUserId: null, subjectType: 'update', subjectId: id, detail: { tag: end.tag, failureCode: end.code } };
        if (end.state === 'refused') await auditUpdateRefused(c, audit);
        else await auditUpdateFailed(c, audit);
        await notifyAdmins(c, { kind: end.state === 'refused' ? 'update_refused' : 'update_failed', summary: end.summary, link: LINK, now, urgent: true });
        // M1: ended before Kainow was stopped (at the re-check, or going back from e.g. backup_failed): everyone was told
        // of an outage that will not come, so they get the "update cancelled" email. Once api and worker were stopped the
        // outage happened, so no cancellation is sent (PO, 23 November 2026).
        const stopped =
          from === 'installing' && ((await c.query(`SELECT 1 FROM update_steps WHERE update_id = $1 AND step = 'stop'`, [id])).rowCount ?? 0) > 0;
        if (!stopped) await mailUpdateEnded(c, id, now);
        return true;
      }),
    succeed: (id, stepId, tag, now) =>
      inLock(async (c) => {
        await c.query(`UPDATE update_steps SET outcome = 'passed', finished_at = $2 WHERE id = $1 AND outcome = 'running'`, [stepId, now]);
        await clearMaintenance(c, id, now, 'succeeded');
        const r = await c.query(`UPDATE updates SET state = 'succeeded', failure_code = NULL, finished_at = $2 WHERE id = $1 AND state = 'installing'`, [id, now]);
        if (r.rowCount !== 1) return;
        await change(c, id, now, { from: 'installing', to: 'succeeded' });
        await auditUpdateSucceeded(c, { at: now, actorUserId: null, subjectType: 'update', subjectId: id, detail: { tag } });
        await notifyAdmins(c, { kind: 'update_succeeded', summary: `Kainow was updated to ${tag}.`, link: LINK, now, urgent: true });
      }),
    async failAfter(id, state, code, tag, now) {
      // The schema may be half-migrated: the state first, on its own; then the change and audit rows, each best effort.
      // No notices and no email: this database is set aside by `recover`.
      await pool.query(`UPDATE updates SET state = $2, failure_code = $3, finished_at = $4 WHERE id = $1 AND state = 'installing'`, [id, state, code, now]);
      await inLock((c) => change(c, id, now, { from: 'installing', to: state, failureCode: code })).catch(() => undefined);
      await auditUpdateFailed(pool, { at: now, actorUserId: null, subjectType: 'update', subjectId: id, detail: { tag, failureCode: code } }).catch(() => undefined);
    },
  };
}
