import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { ACCESS_KEY } from '../auth/access';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthService } from '../auth/auth.service';
import { loadDatabaseConfig } from '../config';
import { seedDashboards } from '../dashboards/bench-cli';
import { runMigrations } from '../db/migrate';
import type { OrganisationState } from '../organisation/state';
import { runBackup } from './backup';
import type { OpsConfig } from './config';
import { runRestoreDrill } from './drill';
import { PgTools } from './pg-tools';
import { OperationsState } from './state';
import { defaultStatfs, runStorageCheck } from './storage-check';

/**
 * Measured aims of sub-project 10a (operations spec section 13).
 *
 *   npm run build && KAINOW_TEST_PG_DOCKER=kainow-testdb npm run bench-ops
 *
 * Creates (and finally drops) the database kainow_bench_sp10 on the server BENCH_ADMIN_URL points at (default: the local
 * test server), migrates it, seeds the 30,000-task data set of the dashboards bench, makes a throwaway backup key in a
 * temporary folder (deleted at the end; key bytes are never printed), then times:
 *   runBackup (aim < 10 min), runRestoreDrill of that backup (aim < 30 min), runStorageCheck (aim < 5 s) and the guard
 *   overhead (aim < 1 ms at p95, state cached).
 *
 * Guard overhead: the real AuthGuard is called 1,000 times (after 200 warm-up calls) for a public POST, the only kind of
 * request that asks the protective state, with the real OperationsState over the bench database, cached, against the same
 * guard whose state answers false without a lookup. The figure is the difference of the two p95s. A GET never asks the
 * state, so its guard cost is the same either way; 1,000 GETs are timed too and the larger difference is reported.
 *
 * When the PostgreSQL tools run through docker (KAINOW_TEST_PG_DOCKER, a Windows dev PC) the backup and drill figures
 * include docker exec overhead and are not production figures.
 */

const BENCH_DB = 'kainow_bench_sp10';
const REQUESTS = 1000;
const WARM_UP = 200;
const AIMS = { backupMs: 10 * 60_000, drillMs: 30 * 60_000, checkMs: 5_000, guardMs: 1 } as const;

const percentile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1];
const min = (n: number): string => `${(n / 60_000).toFixed(2)} min`;
const sec = (n: number): string => `${(n / 1000).toFixed(2)} s`;
const us = (n: number): string => `${(n * 1000).toFixed(1)} us`;

function urlFor(admin: string, name: string): string {
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface Figure {
  label: string;
  value: string;
  aim: string;
  met: boolean;
}

async function guardP95(operations: { isProtective(): Promise<boolean> }, method: string): Promise<number> {
  const handler = (): void => undefined;
  Reflect.defineMetadata(ACCESS_KEY, { kind: 'public' }, handler);
  const request = { method, headers: {} };
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new AuthGuard(new Reflector(), {} as AuthService, { isRegistered: async () => true } as unknown as OrganisationState, operations as OperationsState);
  for (let i = 0; i < WARM_UP; i++) await guard.canActivate(context);
  const xs: number[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    const t0 = performance.now();
    await guard.canActivate(context);
    xs.push(performance.now() - t0);
  }
  return percentile(xs, 0.95);
}

export async function runOpsBench(adminUrl: string, log: (m: string) => void = console.log): Promise<Figure[]> {
  if (!process.env.KAINOW_TEST_PG_DOCKER) throw new Error('Set KAINOW_TEST_PG_DOCKER to the container that has pg_dump and pg_restore.');
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const databaseUrl = urlFor(adminUrl, BENCH_DB);
  const root = mkdtempSync(join(tmpdir(), 'kainow-bench-ops-'));
  let pool: Pool | undefined;
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${BENCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${BENCH_DB}"`);
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    await runMigrations(pool, loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir);
    await seedDashboards(pool, log);
    const tasks = (await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n;
    log(`data: ${tasks} tasks`);
    log('pg tools run through docker on a Windows dev PC: backup and drill figures include docker exec overhead and are not production figures');

    const keyFile = join(root, 'bench.key');
    writeFileSync(keyFile, randomBytes(32));
    const dataDir = join(root, 'data');
    const folder = join(root, 'backups');
    mkdirSync(dataDir);
    mkdirSync(folder);
    const config: OpsConfig = { databaseUrl, backupDir: folder, backupKeyFile: keyFile, dbDataDir: dataDir, protectedKeyFile: null, folderLabel: '/bench/backups' };
    const tools = new PgTools(databaseUrl);
    const common = { pool, config, tools, now: () => new Date(), err: (l: string) => log(`  err: ${l}`) };

    const figures: Figure[] = [];
    const record = (label: string, ms: number, aimMs: number, aimText: string, fmt: (n: number) => string): void => {
      const f = { label, value: fmt(ms), aim: aimText, met: ms < aimMs };
      figures.push(f);
      log(`${label}: ${f.value} (aim ${aimText}): ${f.met ? 'met' : 'MISSED'}`);
    };

    let t0 = performance.now();
    const backupCode = await runBackup(['--kind', 'manual'], { ...common, out: (l) => log(`  backup: ${l}`) });
    const backupMs = performance.now() - t0;
    if (backupCode !== 0) throw new Error(`The backup exited ${backupCode}.`);
    record('backup', backupMs, AIMS.backupMs, '< 10 min', min);

    t0 = performance.now();
    const drillCode = await runRestoreDrill(['--set', 'latest'], {
      ...common,
      statfs: () => ({ total: 10 * 1024 ** 4, free: 5 * 1024 ** 4 }), // the drill's space check; this PC's disks are not the target
      protectedKey: null,
      out: (l) => log(`  drill: ${l}`),
    });
    const drillMs = performance.now() - t0;
    if (drillCode !== 0) throw new Error(`The drill exited ${drillCode}.`);
    record('restore drill', drillMs, AIMS.drillMs, '< 30 min', min);

    t0 = performance.now();
    const checkCode = await runStorageCheck([], { pool, config, statfs: defaultStatfs, now: () => new Date(), out: (l) => log(`  check: ${l}`), err: (l) => log(`  err: ${l}`) });
    const checkMs = performance.now() - t0;
    log(`  storage-check exit ${checkCode}`);
    record('storage-check', checkMs, AIMS.checkMs, '< 5 s', sec);

    const state = new OperationsState(pool);
    await state.isProtective(); // fill the cache; every timed call is inside its 5 s window or refreshes it, as in service
    const without = { isProtective: async () => false };
    const postWith = await guardP95(state, 'POST');
    const postWithout = await guardP95(without, 'POST');
    const getWith = await guardP95(state, 'GET');
    const getWithout = await guardP95(without, 'GET');
    log(`  guard POST p95: with cached check ${us(postWith)}, without ${us(postWithout)}`);
    log(`  guard GET p95: with ${us(getWith)}, without ${us(getWithout)}`);
    record('guard overhead p95', Math.max(postWith - postWithout, getWith - getWithout), AIMS.guardMs, '< 1 ms', (n) => `${n.toFixed(3)} ms`);
    return figures;
  } finally {
    await pool?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${BENCH_DB}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const url = process.env.BENCH_ADMIN_URL ?? 'postgres://postgres:test@127.0.0.1:15432/postgres';
  runOpsBench(url).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : 'The bench stopped unexpectedly.');
      process.exit(1);
    },
  );
}
