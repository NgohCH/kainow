import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Controller, Post, RequestMethod, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { ALLOWED_WHEN_PROTECTIVE_KEY, Public } from '../auth/access';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { uuidv7 } from '../common/uuid7';
import { OrganisationState } from '../organisation/state';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';
import { PROTECTIVE_MESSAGE, UPDATE_BANNER, UPDATE_CODE, UPDATE_MESSAGE } from './protective';
import { OperationsState } from './state';

interface Route {
  method: string;
  path: string;
  allowed: boolean;
  handler: string;
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};
const join = (...parts: string[]) => '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

/** Every route of every controller the application registered, through Nest's own module container. */
function routesOf(t: TestApp): Route[] {
  const scanner = new MetadataScanner();
  const routes: Route[] = [];
  for (const module of t.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!type) continue;
      const bases = [Reflect.getMetadata(PATH_METADATA, type) ?? ''].flat() as string[];
      const classAllowed = Reflect.getMetadata(ALLOWED_WHEN_PROTECTIVE_KEY, type) === true;
      for (const name of scanner.getAllMethodNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue;
        const paths = [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[];
        const allowed = classAllowed || Reflect.getMetadata(ALLOWED_WHEN_PROTECTIVE_KEY, handler) === true;
        for (const base of bases) for (const p of paths) routes.push({ method: METHOD_NAMES[method], path: join(base, p), allowed, handler: `${type.name}.${name}` });
      }
    }
  }
  return routes;
}

describe('protective read-only mode in the API', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let project: string;

  const protective = async (on: boolean) => {
    await t.pool.query(`UPDATE operations_state SET protective = $1, reason = $2, since = $3`, [on, on ? 'low_space' : null, on ? t.clock.now() : null]);
    t.app.get(OperationsState).invalidate();
  };
  const refused = (r: { status: number; body: any }, what: string) => {
    assert.equal(r.status, 503, `${what}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { code: 'protective_read_only', message: PROTECTIVE_MESSAGE }, what);
  };

  beforeEach(async () => {
    t = await startTestApp();
    await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    const pmId = await seedUser(t.pool, 'pm@example.org');
    project = await seedProject(t.pool, { status: 'active', name: 'Harbour Survey', members: [{ userId: pmId, role: 'pm' }, { userId: pmId, role: 'owner' }] });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
  });
  afterEach(async () => {
    await t?.close();
  });

  test('a write is refused with 503 and the D114 text; nothing is written', async () => {
    await protective(true);
    const before = (await t.pool.query(`SELECT count(*)::int AS n FROM projects`)).rows[0].n;
    refused(await pm.request('POST', '/projects', { name: 'New works' }), 'create a project');
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM projects`)).rows[0].n, before);
    await protective(false);
    assert.notEqual((await pm.request('POST', '/projects', { name: 'New works' })).status, 503, 'off again: not refused');
  });

  const updating = async (on: boolean) => {
    await t.pool.query(`UPDATE operations_state SET protective = $1, reason = $2, since = $3, detail = $4`, [on, on ? 'update' : null, on ? t.clock.now() : null, on ? '{"version":"1.0.1"}' : null]);
    t.app.get(OperationsState).invalidate();
  };

  test('a POST during update maintenance is 503 update_in_progress with the update message', async () => {
    await updating(true);
    const r = await pm.request('POST', '/projects', { name: 'New works' });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { code: 'update_in_progress', message: UPDATE_MESSAGE });
    assert.equal(UPDATE_CODE, 'update_in_progress');
    assert.equal(UPDATE_MESSAGE, 'Kainow is being updated. Nothing you have saved is affected; try again in a few minutes.');
  });

  test('GET still works during update maintenance', async () => {
    await updating(true);
    assert.equal((await pm.request('GET', '/projects')).status, 200);
    assert.equal((await pm.request('GET', '/auth/me')).status, 200);
  });

  test('banner endpoint returns the update banner text when the reason is update', async () => {
    await updating(true);
    const m = await pm.request('GET', '/operations/banner');
    assert.equal(m.status, 200);
    assert.equal(m.body.protective, true);
    assert.equal(m.body.reason, 'update');
    assert.equal(m.body.text, UPDATE_BANNER);
    assert.equal(UPDATE_BANNER, 'Kainow is being updated. You can read; changes are paused until the update finishes.');
    const a = await admin.request('GET', '/operations/banner');
    assert.equal(a.body.text, UPDATE_BANNER);
    const pub = await t.anonymous('GET', '/operations/public-state');
    assert.deepEqual(pub.body, { protective: true, reason: 'update', text: UPDATE_BANNER });
  });

  test('reads still answer', async () => {
    await protective(true);
    const list = await pm.request('GET', '/projects');
    assert.equal(list.status, 200);
    assert.equal((await pm.request('GET', `/projects/${project}`)).status, 200);
    assert.equal((await pm.request('GET', '/auth/me')).status, 200);
  });

  test('signing in and out still works', async () => {
    await protective(true);
    await seedUser(t.pool, 'ada@example.org');
    const ada = await t.signIn('ada@example.org'); // request-code, then verify
    assert.equal((await ada.request('GET', '/auth/me')).body.user.id, ada.userId);
    assert.equal((await ada.request('POST', '/auth/logout')).status, 204);
    assert.equal((await ada.request('GET', '/auth/me')).status, 401);
    const again = await t.signIn('ada@example.org');
    assert.equal((await again.request('POST', '/auth/logout-all')).status, 204);
    assert.equal((await again.request('GET', '/auth/me')).status, 401);
  });

  test('the state is cached: a change by another process shows within the cache, and invalidate shows it at once', async () => {
    const state = t.app.get(OperationsState);
    assert.equal(await state.isProtective(), false);
    await t.pool.query(`UPDATE operations_state SET protective = true, reason = 'low_space', since = now()`);
    assert.equal(await state.isProtective(), false, 'cached for up to 5 s');
    state.invalidate();
    assert.equal(await state.isProtective(), true);
    assert.equal((await state.current()).reason, 'low_space');
  });

  test('a public route that is not GET is refused too: the check comes before the public early return', async () => {
    @Controller('sample')
    class Sample {
      @Post('open')
      @Public()
      open(): void {}
    }
    await protective(true);
    const guard = new AuthGuard(t.app.get(Reflector), t.app.get(AuthService), t.app.get(OrganisationState), t.app.get(OperationsState));
    const ctx = (method: string) =>
      ({
        getHandler: () => Sample.prototype.open,
        getClass: () => Sample,
        switchToHttp: () => ({ getRequest: () => ({ method, headers: {} }) }),
      }) as unknown as ExecutionContext;
    await assert.rejects(guard.canActivate(ctx('POST')), ServiceUnavailableException);
    assert.equal(await guard.canActivate(ctx('GET')), true);
    await protective(false);
    assert.equal(await guard.canActivate(ctx('POST')), true);
  });

  test('every route is covered: each non-GET route is refused over HTTP unless it carries AllowedWhenProtective', async () => {
    const routes = routesOf(t);
    assert.ok(routes.length > 150, `found ${routes.length} routes`);
    const unsafe = routes.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
    assert.ok(!unsafe.some((r) => r.method === 'ALL'), 'no @All route');
    // The allow-list is exactly sign-in, sign-out, Resume and the release check.
    assert.deepEqual(unsafe.filter((r) => r.allowed).map((r) => `${r.method} ${r.path}`).sort(), [
      'POST /admin/operations/resume',
      // The release check only reads and records its own row; it runs in protective mode too (10b spec 6.2).
      'POST /admin/updates/check',
      'POST /auth/logout',
      'POST /auth/logout-all',
      'POST /auth/request-code',
      'POST /auth/verify',
    ]);
    await protective(true);
    const id = uuidv7();
    for (const r of unsafe.filter((x) => !x.allowed)) {
      const path = r.path.replace(/:[A-Za-z]+/g, id);
      // Signed in as an administrator and anonymously: refused either way, before anything else is looked at.
      refused(await admin.request(r.method, path, {}), `${r.method} ${r.path} (${r.handler})`);
      refused(await t.anonymous(r.method, path, {}), `${r.method} ${r.path} anonymously`);
    }
    for (const r of unsafe.filter((x) => x.allowed)) {
      assert.notEqual((await t.anonymous(r.method, r.path, {})).status, 503, `${r.method} ${r.path} is allowed`);
    }
  });

  test('GET handlers that write (the audit) answer in protective mode without a 500', async () => {
    // Deleted content for a holder of Inspect Deleted Content, made before the mode starts.
    const holderId = await seedUser(t.pool, 'holder@example.org');
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at, inspect_deleted)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $4, now(), true)`,
      [uuidv7(), project, holderId, pm.userId],
    );
    const holder = await t.signIn('holder@example.org');
    const note = await pm.request('POST', `/projects/${project}/notes`, { title: 'Kestrel plan', text: 'The pump service is booked for Thursday.' });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    const noteId = note.body.source.id as string;
    assert.equal((await pm.request('POST', `/sources/${noteId}/delete`, { reason: 'Imported into the wrong project' })).status, 200);
    const thread = await pm.request('POST', `/projects/${project}/threads`, { kind: 'discussion', title: 'Valves' });
    assert.equal(thread.status, 201, JSON.stringify(thread.body));
    const message = await pm.request('POST', `/threads/${thread.body.id}/messages`, { body: 'The valves are late again.' });
    assert.equal(message.status, 201, JSON.stringify(message.body));
    assert.equal((await pm.request('POST', `/messages/${message.body.id}/delete`, { reason: 'Off topic' })).status, 200);
    await seedDepartment(t.pool, 'Alpha Unit');
    const audits = async (action: string) => (await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = $1`, [action])).rows[0].n as number;
    const goLiveEvents = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM golive_events`)).rows[0].n as number;

    await protective(true);

    // Kept: the audit record of an export or an opening (marked AllowedWhenProtective).
    const exported = await admin.raw('GET', '/admin/analytics/export?panel=progress');
    assert.equal(exported.status, 200, exported.text);
    assert.equal(await audits('analytics.exported'), 1);
    const report = await pm.raw('GET', `/projects/${project}/resources/report?format=csv`);
    assert.equal(report.status, 200, report.text);
    assert.equal(await audits('resources.report_exported'), 1);
    assert.equal((await holder.request('GET', `/projects/${project}/deleted-items/note/${noteId}`)).status, 200);
    assert.equal(await audits('deleted.inspected'), 1);
    assert.equal((await holder.request('GET', `/threads/${thread.body.id}`)).status, 200);
    assert.equal(await audits('deleted.inspected'), 2);

    // No lasting write: the restore preview's change is rolled back inside its own transaction.
    assert.equal((await pm.request('GET', `/sources/${noteId}/restore-preview`)).status, 200);

    // Skipped while protective: the go-live page's automatic ticks.
    const ticksBefore = await goLiveEvents();
    assert.equal((await admin.request('GET', '/go-live')).status, 200);
    assert.equal((await admin.request('GET', '/go-live/summary')).status, 200);
    assert.equal(await goLiveEvents(), ticksBefore, 'no automatic tick in protective mode');
    await protective(false);
    assert.equal((await admin.request('GET', '/go-live')).status, 200);
    assert.ok((await goLiveEvents()) > ticksBefore, 'ticks again once the mode is off');
  });
});
