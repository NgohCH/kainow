import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { makeDocx, makePdf } from '../testing/files';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

const reason = 'Agreed at the board';
const PDF_REFUSAL = 'This project does not accept PDF files. A PM, Owner or Sponsor can change this in Project settings › Outputs.';

function multipart(filename: string, bytes: Buffer): { body: Buffer; type: string } {
  const b = 'testboundary123';
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { body: Buffer.concat([head, bytes, Buffer.from(`\r\n--${b}--\r\n`)]), type: `multipart/form-data; boundary=${b}` };
}

describe('project output settings over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  let admin: Client;
  let pm: Client;
  let deputy: Client;
  let owner: Client;
  let sponsor: Client;
  let ann: Client;
  let outsider: Client;
  let projectId: string;
  const url = (id = projectId) => `/projects/${id}/output-settings`;
  const setOrg = (sql: string) => t.pool.query(`UPDATE storage_settings SET ${sql}`);
  const destination = async (purpose = 'outputs', status = 'approved') => {
    const id = uuidv7();
    const by = (await t.pool.query(`SELECT id FROM users WHERE email = 'admin@example.org'`)).rows[0].id;
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, status, created_by, created_at) VALUES ($1, 'local', 'local', $2, $3, $4, $5, now())`,
      [id, purpose, `Dest ${id.slice(-5)}`, status, by],
    );
    return id;
  };

  beforeEach(async () => {
    t = await startTestApp();
    const ids: Record<string, string> = {};
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['owner', 'pm', 'deputy', 'sponsor', 'ann', 'outsider']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    projectId = await seedProject(t.pool, {
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ann, role: 'member' },
      ],
    });
    admin = await t.signIn('admin@example.org');
    pm = await t.signIn('pm@example.org');
    deputy = await t.signIn('deputy@example.org');
    owner = await t.signIn('owner@example.org');
    sponsor = await t.signIn('sponsor@example.org');
    ann = await t.signIn('ann@example.org');
    outsider = await t.signIn('outsider@example.org');
  });
  afterEach(async () => t.close());

  test('shows the effective values with their sources; non-participants get 404', async () => {
    const r = await ann.request('GET', url());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.formats.input.map((f: { format: string }) => f.format), ['txt', 'md', 'docx', 'pdf']);
    assert.deepEqual(r.body.exportRoles, ['pm', 'deputy', 'owner', 'sponsor']);
    assert.equal(r.body.sources.formats.input, 'organisation');
    assert.equal(r.body.sources.destination, 'none');
    assert.deepEqual(r.body.editable, { destination: false, formats: false, exportRoles: false });
    assert.equal((await outsider.request('GET', url())).status, 404);
    assert.equal((await outsider.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 404);
  });

  test('PM, Owner or Sponsor edit when delegated; Deputy and Member cannot', async () => {
    const dest = await destination();
    for (const [who, c] of [['pm', pm], ['owner', owner], ['sponsor', sponsor]] as const) {
      const res = await c.request('PUT', url(), { reason, destinationId: dest, inputFormats: ['md', 'txt'], outputFormats: ['md'], exportRoles: ['pm', 'audit'] });
      assert.equal(res.status, 200, who);
      assert.deepEqual(res.body.editable, { destination: true, formats: true, exportRoles: true });
      assert.equal((await c.request('PUT', url(), { reason, inputFormats: null, outputFormats: null, exportRoles: ['pm', 'deputy', 'owner', 'sponsor'], destinationId: null })).status, 200);
    }
    for (const c of [deputy, ann]) {
      assert.equal((await c.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 403);
      assert.equal((await c.request('GET', url())).body.editable.formats, false);
    }
  });

  test('Administrator always may; delegation switches off make it Administrator-only', async () => {
    await setOrg(`projects_may_change_formats = false, projects_may_choose_destination = false, projects_may_set_export_roles = false`);
    const dest = await destination();
    assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 403);
    assert.equal((await pm.request('PUT', url(), { reason, destinationId: dest })).status, 403);
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: ['pm'] })).status, 403);
    assert.deepEqual((await pm.request('GET', url())).body.editable, { destination: false, formats: false, exportRoles: false });
    const a = await admin.request('PUT', url(), { reason, inputFormats: ['md'], destinationId: dest, exportRoles: ['pm'] });
    assert.equal(a.status, 200, 'the Administrator is not a project member');
    assert.deepEqual(a.body.editable, { destination: true, formats: true, exportRoles: true });
    // Two switches back on, one still off: only that part is refused.
    await setOrg(`projects_may_change_formats = true, projects_may_choose_destination = true`);
    assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['md', 'txt'] })).status, 200);
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: ['pm', 'owner'] })).status, 403);
    assert.deepEqual((await pm.request('GET', url())).body.editable, { destination: true, formats: true, exportRoles: false });
    // Saving the unchanged value of a switched-off part is not a change to it.
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: ['pm'], outputFormats: ['md'] })).status, 200);
  });

  test('read-only while Deferred or Closed', async () => {
    for (const status of ['deferred', 'closed']) {
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = CASE WHEN $2 = 'closed' THEN 'abandoned' ELSE NULL END WHERE id = $1`, [projectId, status]);
      assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 403, status);
      assert.equal((await admin.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 403, status);
      const got = await pm.request('GET', url());
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.editable, { destination: false, formats: false, exportRoles: false });
      assert.equal((await admin.request('GET', url())).body.editable.formats, false);
    }
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_output_settings`)).rows[0].n, 0);
  });

  test('destination must be an approved outputs destination', async () => {
    const source = await destination('source_area');
    const proposed = await destination('outputs', 'proposed');
    const withdrawn = await destination('outputs', 'withdrawn');
    for (const id of [source, proposed, withdrawn, uuidv7()]) assert.equal((await pm.request('PUT', url(), { reason, destinationId: id })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason, destinationId: 'nope' })).status, 400);
    const good = await destination();
    const ok = await pm.request('PUT', url(), { reason, destinationId: good });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.destination.id, good);
    assert.equal(ok.body.sources.destination, 'project');
    assert.ok(ok.body.availableDestinations.some((d: { id: string }) => d.id === good));
    assert.ok(!ok.body.availableDestinations.some((d: { id: string }) => d.id === source));
    // Withdrawn later: the project is told to choose a new location, and may keep saving other things.
    await t.pool.query(`UPDATE storage_destinations SET status = 'withdrawn' WHERE id = $1`, [good]);
    const after = await pm.request('PUT', url(), { reason, exportRoles: ['pm'] });
    assert.equal(after.status, 200);
    assert.equal(after.body.destination.needsNewLocation, true);
  });

  test('export roles limited to pm, deputy, owner, sponsor, member, audit, oversight', async () => {
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: ['pm', 'deputy_pm'] })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: ['administrator'] })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: [] })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason, exportRoles: 'pm' })).status, 400);
    const all = ['pm', 'deputy', 'owner', 'sponsor', 'member', 'audit', 'oversight'];
    const ok = await pm.request('PUT', url(), { reason, exportRoles: [...all].reverse() });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.exportRoles, all);
    assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['rtf'] })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason, inputFormats: [] })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason, outputFormats: ['txt'] })).status, 400);
  });

  test('changes need a reason and are versioned', async () => {
    assert.equal((await pm.request('PUT', url(), { inputFormats: ['md'] })).status, 400);
    assert.equal((await pm.request('PUT', url(), { reason: '   ', inputFormats: ['md'] })).status, 400);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM project_output_settings_changes`)).rows[0].n, 0);
    assert.equal((await pm.request('PUT', url(), { reason: 'Only Markdown here', inputFormats: ['md'] })).status, 200);
    t.clock.advanceSeconds(1);
    assert.equal((await owner.request('PUT', url(), { reason: 'And PDF too', inputFormats: ['md', 'pdf'] })).status, 200);
    assert.equal((await owner.request('PUT', url(), { reason: 'No change', inputFormats: ['md', 'pdf'] })).status, 200);
    const rows = (await t.pool.query(`SELECT reason, previous, next, actor_id FROM project_output_settings_changes ORDER BY at, id`)).rows;
    assert.equal(rows.length, 2, 'an unchanged save is not a version');
    assert.equal(rows[0].previous.inputFormats, null);
    assert.deepEqual(rows[0].next.inputFormats, ['md']);
    assert.deepEqual(rows[1].previous.inputFormats, ['md']);
    assert.deepEqual(rows[1].next.inputFormats, ['md', 'pdf']);
    assert.equal(rows[1].reason, 'And PDF too');
    assert.equal(rows[1].actor_id, owner.userId);
    const audit = (await t.pool.query(`SELECT detail FROM audit_events WHERE action = 'project.output_settings_changed'`)).rows;
    assert.equal(audit.length, 2);
    await assert.rejects(t.pool.query(`UPDATE project_output_settings_changes SET reason = 'x'`));
  });

  describe('input formats on note imports', () => {
    const importFile = (c: Client, name: string, bytes: Buffer) => {
      const m = multipart(name, bytes);
      return c.upload('POST', `/projects/${projectId}/notes/upload`, m.body, m.type);
    };
    const pdf = () => makePdf(['Ali will email Sam.']);

    test('importing a PDF is refused with the exact text when the project removed pdf', async () => {
      assert.equal((await importFile(pm, 'before.pdf', pdf())).status, 201, 'allowed by default');
      assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['txt', 'md', 'docx'] })).status, 200);
      const refused = await importFile(pm, 'after.pdf', pdf());
      assert.equal(refused.status, 400);
      assert.equal(refused.body.message, PDF_REFUSAL);
      assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM sources WHERE project_id = $1`, [projectId])).rows[0].n, 1);
      assert.equal((await importFile(pm, 'ok.docx', makeDocx(['We agreed.']))).status, 201, 'other formats still work');
      // A new version by upload is checked the same way.
      const id = (await t.pool.query(`SELECT id FROM sources WHERE project_id = $1 ORDER BY created_at, id LIMIT 1`, [projectId])).rows[0].id;
      const m = multipart('again.pdf', makePdf(['Different text.']));
      const v = await pm.upload('POST', `/notes/${id}/versions/upload`, m.body, m.type);
      assert.equal(v.status, 400);
      assert.equal(v.body.message, PDF_REFUSAL);
    });

    test('the Administrator removing a format organisation-wide applies to projects with no list of their own', async () => {
      await setOrg(`approved_input_formats = '{txt,md,docx}'`);
      assert.equal((await importFile(pm, 'a.pdf', pdf())).body.message, PDF_REFUSAL);
    });

    test('pasted text is always allowed', async () => {
      await setOrg(`approved_input_formats = '{md}'`);
      assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 200);
      const pasted = await pm.request('POST', `/projects/${projectId}/notes`, { title: 'Pasted', text: 'Some notes' });
      assert.equal(pasted.status, 201);
      const id = pasted.body.source.id;
      assert.equal((await pm.request('POST', `/notes/${id}/versions`, { text: 'More notes' })).status, 201);
    });

    test('removing a format leaves earlier sources readable', async () => {
      const first = await importFile(pm, 'earlier.pdf', pdf());
      assert.equal(first.status, 201);
      const id = first.body.source.id;
      assert.equal((await pm.request('PUT', url(), { reason, inputFormats: ['md'] })).status, 200);
      const v = await pm.request('GET', `/notes/${id}/versions/1`);
      assert.equal(v.status, 200);
      assert.match(v.body.version.text, /Ali will email Sam/);
      assert.equal((await pm.raw('GET', `/notes/${id}/versions/1/original`)).status, 200);
    });
  });
});
