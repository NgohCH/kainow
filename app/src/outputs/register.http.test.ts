import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ReportKind } from '../assist/reports';
import type { AuthUser } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';
import type { StorageConnector } from '../storage/connector';
import type { StorageConnectorFactory } from '../storage/connector-factory';
import { type ItemState, StorageError } from '../storage/types';
import { SKIP_NO_DB } from '../testing/db';
import { type SeededDraft, materialFor, seedDraft } from '../testing/drafts';
import { makeDocx, makePdf } from '../testing/files';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedDepartment, seedProject, seedUser } from '../testing/projects';

const LINK_REFUSED = 'Kainow can only register documents in approved storage locations.';
const KEPT = 'Kept at its existing location';
const SHARING_OUTSIDE = 'Sharing for this document is managed outside Kainow';

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer }): { body: Buffer; type: string } {
  const b = 'outputboundary42';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

/** Links the stub storage resolves: url → the drive it lies in and the item. Anything else is not found. */
const links = new Map<string, { driveId: string; item: ItemState }>();
const stubConnectors: StorageConnectorFactory = {
  forDestination: async () => {
    throw new StorageError('invalid');
  },
  forNew: async () =>
    ({
      kind: 'graph',
      resolveLink: async (url: string) => {
        const l = links.get(url);
        if (!l) throw new StorageError('not_found');
        return { dest: { id: '', connector: 'graph', driveId: l.driveId, rootItemId: 'root' }, item: l.item };
      },
    }) as unknown as StorageConnector,
};
const item = (name: string, itemId = `item-${uuidv7().slice(-8)}`): ItemState => ({
  itemId, parentId: 'folder-1', name, path: `/Shared Documents/Plans/${name}`, size: 2048, providerHash: 'qxh==', etag: 'e1', ctag: 'c1', webUrl: `https://files.example.org/sites/plans/${name}`,
});

describe('output register over HTTP', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  const c: Record<string, Client> = {};
  let project: string;
  const url = (p = '', id = project) => `/projects/${id}/outputs${p}`;
  const person = (k: string): AuthUser => ({ id: ids[k], email: `${k}@example.org`, displayName: k, role: 'member' });
  const typeId = async (name: string) => (await t.pool.query(`SELECT id FROM report_types WHERE name = $1`, [name])).rows[0].id as string;

  const meeting = async (title: string, message: string, named?: string[]) => {
    const r = await c.pm.request('POST', `/projects/${project}/threads`, { kind: 'meeting', title, ...(named ? { audience: { mode: 'restricted', namedUserIds: named } } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = await c.pm.request('POST', `/threads/${r.body.id}/messages`, { body: message });
    assert.equal(m.status, 201, JSON.stringify(m.body));
  };
  /** A shared draft by `by` built from what they find for `question`. */
  const draft = async (by: string, question: string, opts: { shared?: boolean; kind?: ReportKind; projectId?: string } = {}): Promise<SeededDraft> =>
    seedDraft(t.pool, {
      projectId: opts.projectId ?? project,
      requesterId: ids[by],
      shared: opts.shared,
      kind: opts.kind,
      items: await materialFor(t.pool, t.app.get(ProjectAccess), opts.projectId ?? project, person(by), question),
    });
  const submitDraft = (who: Client, draftVersionId: string, format = 'md', title = 'Weekly status') =>
    who.request('POST', url(), { kind: 'draft', draftVersionId, format, title });
  const upload = (who: Client, name: string, bytes: Buffer, fields: Record<string, string> = { title: 'Uploaded plan' }, path = url()) => {
    const m = multipart(fields, { name, bytes });
    return who.upload('POST', path, m.body, m.type);
  };
  const created = async (p: Promise<{ status: number; body: any }>) => {
    const r = await p;
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const register = (who: Client, id: string, body: Record<string, unknown> = {}) => who.request('POST', url(`/${id}/register`), body);
  const listIds = async (who: Client) => {
    const r = await who.request('GET', url());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.outputs.map((o: { id: string }) => o.id) as string[];
  };
  const destination = async (driveId: string, status = 'approved', purpose = 'outputs') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO storage_destinations (id, connector, kind, purpose, label, drive_id, root_item_id, status, created_by, created_at)
       VALUES ($1, 'graph', 'sharepoint_library', $2, $3, $4, 'root', $5, $6, now())`,
      [id, purpose, `Library ${driveId}`, driveId, status, ids.admin],
    );
    return id;
  };

  beforeEach(async () => {
    links.clear();
    t = await startTestApp(undefined, { storageConnectors: stubConnectors });
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const k of ['pm', 'deputy', 'owner', 'sponsor', 'ada', 'bob', 'auditor', 'outsider']) ids[k] = await seedUser(t.pool, `${k}@example.org`);
    project = await seedProject(t.pool, {
      status: 'active',
      name: 'Pump station renewal',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.deputy, role: 'deputy_pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.ada, role: 'member' },
        { userId: ids.bob, role: 'member' },
      ],
    });
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-30', $4, now(), 'approved', $5, now())`,
      [uuidv7(), project, ids.auditor, ids.pm, ids.admin],
    );
    for (const k of Object.keys(ids)) c[k] = await t.signIn(`${k}@example.org`);
    await meeting('Plant meeting', 'The valve audit is planned for Friday.');
  });
  afterEach(async () => t.close());

  test('each participant role may submit from a readable draft; Deferred and Closed refuse', async () => {
    const d = await draft('ada', 'valve audit');
    const formats = { pm: 'md', deputy: 'docx', owner: 'pdf', sponsor: 'md', ada: 'docx' } as const;
    for (const [who, format] of Object.entries(formats)) {
      const out = await created(submitDraft(c[who], d.aiVersionId, format, `Status from ${who}`));
      assert.equal(out.status, 'submitted', who);
      assert.equal(out.title, `Status from ${who}`);
      assert.equal(out.author.id, ids[who]);
      assert.equal(out.versions.length, 1);
      assert.deepEqual([out.versions[0].no, out.versions[0].origin, out.versions[0].format, out.versions[0].status], [1, 'draft_report', format, 'draft']);
      assert.equal(out.versions[0].filing.state, 'not_filed');
      const stored = (await t.pool.query(`SELECT v.sha256, v.size_bytes, b.bytes, b.kept_until FROM output_versions v JOIN output_version_bytes b ON b.output_version_id = v.id WHERE v.output_id = $1`, [out.id])).rows[0];
      assert.equal(createHash('sha256').update(stored.bytes).digest('hex'), stored.sha256);
      assert.equal(Number(stored.size_bytes), stored.bytes.length);
      assert.equal(new Date(stored.kept_until).getTime() - t.clock.now().getTime(), 90 * 86_400_000, 'kept 90 days until filed');
      if (format === 'pdf') assert.equal(stored.bytes.subarray(0, 5).toString(), '%PDF-');
      if (format === 'docx') assert.equal(stored.bytes.subarray(0, 2).toString(), 'PK');
      if (format === 'md') assert.ok(stored.bytes.toString().includes('The pump service is booked') || stored.bytes.toString().includes('Summary'));
    }
    assert.equal((await submitDraft(c.auditor, d.aiVersionId)).status, 403, 'grant holders only read');
    assert.equal((await submitDraft(c.outsider, d.aiVersionId)).status, 404);
    for (const status of ['deferred', 'closed']) {
      await t.pool.query(`UPDATE projects SET status = $2, closure_outcome = CASE WHEN $2 = 'closed' THEN 'abandoned' ELSE NULL END WHERE id = $1`, [project, status]);
      const r = await submitDraft(c.pm, d.aiVersionId);
      assert.equal(r.status, 403, status);
      assert.equal(r.body.message, 'Only people in the project can submit an output, and not while the project is Deferred or Closed.');
    }
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 5);
  });

  test('submitting a draft the person cannot read is 404', async () => {
    const unshared = await draft('ada', 'valve audit', { shared: false });
    assert.equal((await submitDraft(c.bob, unshared.aiVersionId)).status, 404, 'another person’s unshared draft');
    assert.equal((await submitDraft(c.ada, unshared.aiVersionId)).status, 201, 'the requester may');
    await meeting('Board meeting', 'The pump service is booked for Thursday morning.', [ids.ada]);
    const restricted = await draft('ada', 'pump service');
    assert.equal((await submitDraft(c.bob, restricted.aiVersionId)).status, 404, 'built from material bob cannot read');
    const other = await seedProject(t.pool, { status: 'active', members: [{ userId: ids.bob, role: 'pm' }] });
    const elsewhere = await seedDraft(t.pool, { projectId: other, requesterId: ids.bob, items: [] });
    assert.equal((await submitDraft(c.bob, elsewhere.aiVersionId)).status, 404, 'a draft of another project');
    assert.equal((await submitDraft(c.bob, uuidv7())).status, 404);
    assert.equal((await c.bob.request('POST', url(), { kind: 'draft', draftVersionId: unshared.aiVersionId, format: 'csv', title: 'x' })).status, 400);
  });

  test('upload accepts md, docx, pdf, csv in project formats and refuses txt', async () => {
    const files: Array<[string, Buffer, string]> = [
      ['plan.md', Buffer.from('# Plan\n\nThe valve audit is on Friday.\n'), 'md'],
      ['plan.docx', makeDocx(['The valve audit is on Friday.']), 'docx'],
      ['plan.pdf', makePdf(['The valve audit is on Friday.']), 'pdf'],
      ['plan.csv', Buffer.from('task,due\nValve audit,2026-11-13\n'), 'csv'],
    ];
    for (const [name, bytes, format] of files) {
      const out = await created(upload(c.ada, name, bytes, { title: `Plan ${format}` }));
      assert.deepEqual([out.versions[0].origin, out.versions[0].format, out.aiAssisted], ['upload', format, false], name);
      const row = (await t.pool.query(`SELECT b.bytes FROM output_versions v JOIN output_version_bytes b ON b.output_version_id = v.id WHERE v.output_id = $1`, [out.id])).rows[0];
      assert.ok(row.bytes.equals(bytes), 'the file is kept exactly as uploaded');
    }
    const txt = await upload(c.ada, 'plan.txt', Buffer.from('Valve audit Friday.'));
    assert.equal(txt.status, 400);
    assert.match(txt.body.message, /Markdown, DOCX, PDF or CSV/);
    assert.equal((await upload(c.ada, 'plan.xlsx', Buffer.from('PK'))).status, 400);
    assert.equal((await upload(c.ada, 'fake.pdf', Buffer.from('not a pdf at all'))).status, 400, 'the content must match the name');
    assert.equal((await upload(c.ada, 'plan.md', Buffer.from('x'), {})).status, 400, 'a title is required');
    // The project stops using CSV for outputs.
    assert.equal((await c.pm.request('PUT', `/projects/${project}/output-settings`, { reason: 'No spreadsheets', outputFormats: ['md', 'docx', 'pdf'] })).status, 200);
    const csv = await upload(c.ada, 'plan.csv', Buffer.from('a,b\n1,2\n'));
    assert.equal(csv.status, 400);
    assert.match(csv.body.message, /CSV/);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 4);
  });

  test('upload with a suspected secret is refused naming only the kind', async () => {
    const secret = 'password: Hunter2!horse-battery';
    for (const [name, bytes] of [
      ['notes.md', Buffer.from(`# Notes\n\n${secret}\n`)],
      ['notes.docx', makeDocx([`Login ${secret}`])],
      ['notes.csv', Buffer.from(`k,v\nlogin,${secret}\n`)],
    ] as Array<[string, Buffer]>) {
      const r = await upload(c.ada, name, bytes);
      assert.equal(r.status, 400, name);
      assert.match(r.body.message, /password or key assignment/);
      assert.ok(!JSON.stringify(r.body).includes('Hunter2'), 'never the match');
    }
    const titled = await upload(c.ada, 'ok.md', Buffer.from('Fine.'), { title: 'Token sk-abcdefghijklmnopqrstuvwxyz123456' });
    assert.equal(titled.status, 400);
    assert.match(titled.body.message, /API secret key/);
    // A rendered draft is checked too.
    const d = await seedDraft(t.pool, { projectId: project, requesterId: ids.ada, items: [], body: `Access: ${secret}` });
    const r = await submitDraft(c.ada, d.aiVersionId);
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).includes('Hunter2'));
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM outputs`)).rows[0].n, 0);
  });

  test('a link outside approved destinations is refused with the exact text', async () => {
    await destination('drive-proposed', 'proposed');
    await destination('drive-source', 'approved', 'source_area');
    links.set('https://files.example.org/x/elsewhere.docx', { driveId: 'drive-elsewhere', item: item('elsewhere.docx') });
    links.set('https://files.example.org/x/proposed.docx', { driveId: 'drive-proposed', item: item('proposed.docx') });
    links.set('https://files.example.org/x/source.docx', { driveId: 'drive-source', item: item('source.docx') });
    for (const link of ['https://files.example.org/x/elsewhere.docx', 'https://files.example.org/x/proposed.docx', 'https://files.example.org/x/source.docx', 'https://files.example.org/x/unknown.docx']) {
      const r = await c.ada.request('POST', url(), { kind: 'link', url: link, title: 'Linked plan' });
      assert.equal(r.status, 400, link);
      assert.equal(r.body.message, LINK_REFUSED);
    }
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM stored_files`)).rows[0].n, 0);
  });

  test('a link inside one is registered as Kept at its existing location with sharing managed outside Kainow', async () => {
    // Any approved output destination counts, not only the project's own.
    const dest = await destination('drive-plans');
    const it = item('Plan of works.docx', 'item-42');
    links.set('https://files.example.org/sites/plans/Plan%20of%20works.docx', { driveId: 'drive-plans', item: it });
    const out = await created(c.ada.request('POST', url(), { kind: 'link', url: 'https://files.example.org/sites/plans/Plan%20of%20works.docx', title: 'Plan of works' }));
    const v = out.versions[0];
    assert.deepEqual([v.origin, v.format, v.status], ['link', 'docx', 'draft']);
    assert.equal(v.filing.state, 'linked');
    assert.equal(v.filing.label, KEPT);
    assert.equal(v.filing.sharing, SHARING_OUTSIDE);
    const f = (await t.pool.query(`SELECT f.* FROM stored_files f JOIN output_versions v ON v.stored_file_id = f.id WHERE v.output_id = $1`, [out.id])).rows[0];
    assert.equal(f.purpose, 'output');
    assert.equal(f.state, 'linked');
    assert.equal(f.destination_id, dest);
    assert.equal(f.drive_id, 'drive-plans');
    assert.equal(f.item_id, 'item-42');
    assert.equal(f.path, it.path);
    assert.equal(f.web_url, it.webUrl);
    assert.equal(Number(f.size_bytes), 2048);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM output_version_bytes`)).rows[0].n, 0, 'nothing kept in the database for a link');
    // The path is shown to PM, Deputy, Owner and Sponsor only.
    assert.equal(v.filing.path, undefined, 'not for the submitting Member');
    const seen = await c.pm.request('GET', url(`/${out.id}`));
    assert.equal(seen.body.versions[0].filing.path, it.path);
  });

  test('submitted outputs are visible to submitter, PM and Deputies only', async () => {
    const out = await created(upload(c.ada, 'plan.md', Buffer.from('# Plan')));
    for (const who of ['ada', 'pm', 'deputy']) {
      assert.equal((await c[who].request('GET', url(`/${out.id}`))).status, 200, who);
      assert.deepEqual(await listIds(c[who]), [out.id], who);
    }
    for (const who of ['owner', 'sponsor', 'bob', 'auditor']) {
      assert.equal((await c[who].request('GET', url(`/${out.id}`))).status, 404, who);
      assert.deepEqual(await listIds(c[who]), [], who);
    }
    assert.equal((await c.outsider.request('GET', url())).status, 404);
    assert.equal((await c.outsider.request('GET', url(`/${out.id}`))).status, 404);
    assert.equal((await c.pm.request('GET', url(`/${out.id}`, await seedProject(t.pool, { status: 'active', members: [{ userId: ids.pm, role: 'pm' }] })))).status, 404, 'only under its own project');
  });

  test('PM or Deputy registers with type, categories, issue date, contributors and audience; a Member cannot', async () => {
    const dept = await seedDepartment(t.pool, 'Engineering');
    const dept2 = await seedDepartment(t.pool, 'Finance');
    const out = await created(upload(c.ada, 'plan.md', Buffer.from('# Plan'), { title: 'Plan of works' }));
    const minutes = await typeId('Minutes');
    const risks = await typeId('Risk summaries');
    const body = {
      title: 'Plan of works (final)',
      reportTypeId: minutes,
      categoryIds: [risks],
      issueDate: '2026-10-30',
      contributors: { people: [{ userId: ids.bob, departmentId: dept }, { userId: ids.ada }], departmentIds: [dept2] },
      audience: { mode: 'restricted', namedUserIds: [ids.pm, ids.ada, ids.owner] },
    };
    assert.equal((await register(c.ada, out.id, body)).status, 403, 'the submitting Member');
    assert.equal((await register(c.owner, out.id, body)).status, 404, 'a submission is not visible to the Owner');
    assert.equal((await register(c.deputy, out.id, { ...body, reportTypeId: undefined })).status, 400, 'a type is required');
    assert.equal((await register(c.deputy, out.id, { ...body, contributors: { people: [{ userId: ids.outsider }], departmentIds: [] } })).status, 400, 'contributors take part in the project');
    assert.equal((await register(c.deputy, out.id, { ...body, audience: { mode: 'restricted', namedUserIds: [ids.outsider] } })).status, 400);
    // A Deputy who leaves themselves out of the audience is told only that it was registered.
    const r = await register(c.deputy, out.id, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { id: out.id, status: 'registered', readable: false });
    const seen = await c.pm.request('GET', url(`/${out.id}`));
    assert.equal(seen.status, 200);
    const o = seen.body;
    assert.equal(o.status, 'registered');
    assert.equal(o.title, 'Plan of works (final)');
    assert.deepEqual(o.reportType, { id: minutes, name: 'Minutes' });
    assert.deepEqual(o.categories, [{ id: risks, name: 'Risk summaries' }]);
    assert.equal(o.issueDate, '2026-10-30');
    assert.equal(o.author.id, ids.ada, 'the submitter is the author');
    assert.equal(o.registeredBy.id, ids.deputy);
    assert.deepEqual(o.contributors.people.map((p: { id: string; departmentId: string | null }) => [p.id, p.departmentId]).sort(), [[ids.ada, null], [ids.bob, dept]].sort());
    assert.deepEqual(o.contributors.departments, [{ id: dept2, name: 'Finance' }]);
    assert.equal(o.audience.mode, 'restricted');
    assert.deepEqual(o.audience.people.map((p: { id: string }) => p.id).sort(), [ids.ada, ids.owner, ids.pm].sort());
    // Readers now follow the audience.
    for (const who of ['pm', 'ada', 'owner']) assert.equal((await c[who].request('GET', url(`/${out.id}`))).status, 200, who);
    for (const who of ['deputy', 'sponsor', 'bob', 'auditor']) assert.equal((await c[who].request('GET', url(`/${out.id}`))).status, 404, who);
    assert.equal((await register(c.pm, out.id, { reportTypeId: minutes })).status, 409, 'already registered');

    // Registered with defaults: today's date (UTC+8) and Project-wide; a retired type cannot be chosen.
    const second = await created(upload(c.bob, 'b.md', Buffer.from('# B'), { title: 'another plan' }));
    await t.pool.query(`UPDATE report_types SET status = 'retired' WHERE name = 'Other'`);
    assert.equal((await register(c.pm, second.id, { reportTypeId: await typeId('Other') })).status, 400);
    const ok = await register(c.pm, second.id, { reportTypeId: minutes });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.issueDate, '2026-11-09');
    assert.equal(ok.body.audience.mode, 'project');
    for (const who of ['owner', 'sponsor', 'bob', 'auditor', 'deputy']) assert.equal((await c[who].request('GET', url(`/${second.id}`))).status, 200, who);

    // The register lists by issue date (latest first, undated last), then title.
    const third = await created(upload(c.pm, 'c.md', Buffer.from('# C'), { title: 'A plan' }));
    const fourth = await created(upload(c.pm, 'd.md', Buffer.from('# D'), { title: 'b plan' }));
    assert.equal((await register(c.pm, fourth.id, { reportTypeId: minutes, issueDate: '2026-11-09' })).status, 200);
    assert.deepEqual(await listIds(c.pm), [second.id, fourth.id, out.id, third.id]);
  });

  test('contributor departments are recorded as at registration and not rewritten when the person moves department', async () => {
    const eng = await seedDepartment(t.pool, 'Engineering');
    const fin = await seedDepartment(t.pool, 'Finance');
    const out = await created(upload(c.ada, 'plan.md', Buffer.from('# Plan')));
    const minutes = await typeId('Minutes');
    assert.equal((await register(c.pm, out.id, { reportTypeId: minutes, contributors: { people: [{ userId: ids.bob, departmentId: eng }], departmentIds: [] } })).status, 200);
    const before = (await t.pool.query(`SELECT user_id, department_id, added_at FROM output_contributors WHERE output_id = $1`, [out.id])).rows;
    // Bob now works for Finance, the department is renamed, and contributors are edited: his recorded department stays.
    await t.pool.query(`UPDATE departments SET name = 'Engineering Services' WHERE id = $1`, [eng]);
    t.clock.advanceSeconds(60);
    const r = await c.pm.request('PUT', url(`/${out.id}`), {
      contributors: { people: [{ userId: ids.bob, departmentId: fin }, { userId: ids.ada, departmentId: fin }], departmentIds: [fin] },
      reason: 'Ada helped too',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const people = Object.fromEntries(r.body.contributors.people.map((p: { id: string; departmentId: string; departmentName: string }) => [p.id, [p.departmentId, p.departmentName]]));
    assert.deepEqual(people[ids.bob], [eng, 'Engineering Services'], 'not rewritten');
    assert.deepEqual(people[ids.ada], [fin, 'Finance'], 'a new contributor is recorded as now');
    const bob = (await t.pool.query(`SELECT department_id, added_at FROM output_contributors WHERE output_id = $1 AND user_id = $2`, [out.id, ids.bob])).rows[0];
    assert.equal(bob.department_id, eng);
    assert.equal(bob.added_at.getTime(), before[0].added_at.getTime());
    // A Member cannot change the register.
    assert.equal((await c.ada.request('PUT', url(`/${out.id}`), { title: 'Mine' })).status, 403);
  });

  test('AI-assisted is set from an AI draft version', async () => {
    const d = await draft('ada', 'valve audit');
    const ai = await created(submitDraft(c.pm, d.aiVersionId));
    const edited = await created(submitDraft(c.pm, d.editedVersionId));
    const human = await created(submitDraft(c.pm, d.humanVersionId));
    assert.deepEqual([ai.aiAssisted, edited.aiAssisted, human.aiAssisted], [true, true, false]);
    const md = (await t.pool.query(`SELECT b.bytes FROM output_versions v JOIN output_version_bytes b ON b.output_version_id = v.id WHERE v.output_id = $1`, [ai.id])).rows[0].bytes.toString();
    assert.match(md, /Prepared with AI assistance/);
    // A human version gains the label when an AI version is added.
    assert.equal((await register(c.pm, human.id, { reportTypeId: await typeId('Status reports') })).status, 200);
    const v2 = await created(c.pm.request('POST', url(`/${human.id}/versions`), { kind: 'draft', draftVersionId: d.aiVersionId, format: 'pdf' }));
    assert.equal(v2.aiAssisted, true);
    assert.deepEqual(v2.versions.map((v: { no: number }) => v.no), [1, 2]);
  });

  test('decline needs a reason and leaves the output visible to the submitter', async () => {
    const out = await created(upload(c.ada, 'plan.md', Buffer.from('# Plan')));
    assert.equal((await c.pm.request('POST', url(`/${out.id}/decline`), {})).status, 400);
    assert.equal((await c.pm.request('POST', url(`/${out.id}/decline`), { reason: '  ' })).status, 400);
    assert.equal((await c.ada.request('POST', url(`/${out.id}/decline`), { reason: 'No' })).status, 403);
    const r = await c.deputy.request('POST', url(`/${out.id}/decline`), { reason: 'Duplicate of the weekly status' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'declined');
    const seen = await c.ada.request('GET', url(`/${out.id}`));
    assert.equal(seen.status, 200);
    assert.equal(seen.body.status, 'declined');
    const declined = seen.body.history.find((h: { kind: string }) => h.kind === 'declined');
    assert.equal(declined.reason, 'Duplicate of the weekly status');
    assert.equal(declined.actor.id, ids.deputy);
    assert.deepEqual(await listIds(c.ada), [out.id]);
    for (const who of ['owner', 'bob']) assert.equal((await c[who].request('GET', url(`/${out.id}`))).status, 404, who);
    assert.equal((await register(c.pm, out.id, { reportTypeId: await typeId('Minutes') })).status, 409, 'nothing more happens to a declined output');
    assert.equal((await c.pm.request('POST', url(`/${out.id}/decline`), { reason: 'Again' })).status, 409);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM output_versions WHERE output_id = $1`, [out.id])).rows[0].n, 1, 'nothing is deleted');
  });

  test('restricted material forces a Restricted audience within material readers, default PM, Deputies, Owner and Sponsors among them', async () => {
    await meeting('Board meeting', 'The pump service is booked for Thursday morning.', [ids.ada]);
    const d = await draft('ada', 'pump service');
    const out = await created(submitDraft(c.pm, d.aiVersionId));
    assert.equal(out.audience.mode, 'restricted');
    assert.deepEqual(out.audience.people.map((p: { id: string }) => p.id).sort(), [ids.pm, ids.deputy, ids.owner, ids.sponsor].sort());
    // A Member who submits it is in its audience too, so they still see their own submission.
    const own = await created(submitDraft(c.ada, d.aiVersionId));
    assert.deepEqual(own.audience.people.map((p: { id: string }) => p.id).sort(), [ids.pm, ids.deputy, ids.owner, ids.sponsor, ids.ada].sort());
    assert.equal((await c.ada.request('GET', url(`/${own.id}`))).status, 200);

    const minutes = await typeId('Minutes');
    const asProject = await register(c.pm, out.id, { reportTypeId: minutes, audience: { mode: 'project', namedUserIds: [] } });
    assert.equal(asProject.status, 400, 'cannot be Project-wide');
    const wider = await register(c.pm, out.id, { reportTypeId: minutes, audience: { mode: 'restricted', namedUserIds: [ids.pm, ids.bob] } });
    assert.equal(wider.status, 400, 'bob cannot read the material');
    const ok = await register(c.pm, out.id, { reportTypeId: minutes, audience: { mode: 'restricted', namedUserIds: [ids.pm, ids.ada] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.audience.people.map((p: { id: string }) => p.id).sort(), [ids.pm, ids.ada].sort());
    assert.equal((await c.ada.request('GET', url(`/${out.id}`))).status, 200);
    assert.equal((await c.deputy.request('GET', url(`/${out.id}`))).status, 404, 'no longer in the audience');
    // Kept as a sub-project 4a audience row with its named people.
    const a = (await t.pool.query(`SELECT a.mode, a.project_id FROM outputs o JOIN audiences a ON a.id = o.audience_id WHERE o.id = $1`, [out.id])).rows[0];
    assert.deepEqual(a, { mode: 'restricted', project_id: project });
    // Open material keeps an output Project-wide.
    const wide = await created(submitDraft(c.pm, (await draft('ada', 'valve audit')).aiVersionId));
    assert.equal(wide.audience.mode, 'project');
  });

  test('adding a version whose material is narrower than the audience is refused until narrowed', async () => {
    await meeting('Board meeting', 'The pump service is booked for Thursday morning.', [ids.ada]);
    const restricted = await draft('ada', 'pump service');
    const minutes = await typeId('Minutes');
    const wide = await created(upload(c.ada, 'plan.md', Buffer.from('# Plan')));
    assert.equal((await register(c.pm, wide.id, { reportTypeId: minutes })).status, 200);
    const refused = await c.pm.request('POST', url(`/${wide.id}/versions`), { kind: 'draft', draftVersionId: restricted.aiVersionId, format: 'md' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Narrow/);
    // Narrowed to people who can read it: the version is accepted.
    const narrow = await created(upload(c.ada, 'plan2.md', Buffer.from('# Plan 2')));
    assert.equal((await register(c.pm, narrow.id, { reportTypeId: minutes, audience: { mode: 'restricted', namedUserIds: [ids.pm, ids.ada] } })).status, 200);
    const v2 = await created(c.pm.request('POST', url(`/${narrow.id}/versions`), { kind: 'draft', draftVersionId: restricted.aiVersionId, format: 'md' }));
    assert.deepEqual(v2.versions.map((v: { no: number; origin: string }) => [v.no, v.origin]), [[1, 'upload'], [2, 'draft_report']]);
    const notReader = await created(upload(c.ada, 'plan3.md', Buffer.from('# Plan 3')));
    assert.equal((await register(c.pm, notReader.id, { reportTypeId: minutes, audience: { mode: 'restricted', namedUserIds: [ids.pm, ids.bob] } })).status, 200);
    assert.equal((await c.pm.request('POST', url(`/${notReader.id}/versions`), { kind: 'draft', draftVersionId: restricted.aiVersionId, format: 'md' })).status, 409);
    // Versions are added by the PM or a Deputy, to registered outputs only.
    assert.equal((await upload(c.ada, 'p.md', Buffer.from('# P'), {}, url(`/${narrow.id}/versions`))).status, 403);
    const submitted = await created(upload(c.ada, 'p.md', Buffer.from('# P')));
    assert.equal((await upload(c.pm, 'p.md', Buffer.from('# P'), {}, url(`/${submitted.id}/versions`))).status, 409);
    const v3 = await created(upload(c.deputy, 'p3.md', Buffer.from('# P3'), {}, url(`/${wide.id}/versions`)));
    assert.equal(v3.versions.at(-1).no, 2);
  });

  test('draft report kinds map to default report types', async () => {
    const expected: Record<ReportKind, string> = {
      status: 'Status reports',
      decisions_actions: 'Decisions and actions',
      risks: 'Risk summaries',
      specification: 'Specifications',
      free_form: 'Other',
    };
    for (const [kind, name] of Object.entries(expected) as Array<[ReportKind, string]>) {
      const d = await draft('ada', 'valve audit', { kind });
      const out = await created(submitDraft(c.ada, d.humanVersionId));
      assert.equal(out.reportType?.name, name, kind);
    }
    // A suggested type wins over the default.
    const d = await draft('ada', 'valve audit', { kind: 'status' });
    const minutes = await typeId('Minutes');
    const out = await created(c.ada.request('POST', url(), { kind: 'draft', draftVersionId: d.humanVersionId, format: 'md', title: 'Notes', reportTypeId: minutes }));
    assert.equal(out.reportType.name, 'Minutes');
    const upl = await created(upload(c.ada, 'p.md', Buffer.from('# P')));
    assert.equal(upl.reportType, null, 'no default for an upload');
  });

  test('output_events written for submitted, registered, declined, version_added', async () => {
    const minutes = await typeId('Minutes');
    const tick = () => t.clock.advanceSeconds(1);
    const a = await created(upload(c.ada, 'a.md', Buffer.from('# A')));
    tick();
    assert.equal((await register(c.pm, a.id, { reportTypeId: minutes })).status, 200);
    tick();
    await created(upload(c.deputy, 'a2.md', Buffer.from('# A2'), {}, url(`/${a.id}/versions`)));
    tick();
    assert.equal((await c.pm.request('PUT', url(`/${a.id}`), { title: 'A renamed', reason: 'Clearer' })).status, 200);
    tick();
    const b = await created(upload(c.bob, 'b.md', Buffer.from('# B')));
    tick();
    assert.equal((await c.pm.request('POST', url(`/${b.id}/decline`), { reason: 'Not needed' })).status, 200);
    const ev = (await t.pool.query(`SELECT output_id, kind, actor_id, reason, version_id IS NOT NULL AS has_version FROM output_events ORDER BY at, id`)).rows;
    assert.deepEqual(ev, [
      { output_id: a.id, kind: 'submitted', actor_id: ids.ada, reason: null, has_version: true },
      { output_id: a.id, kind: 'registered', actor_id: ids.pm, reason: null, has_version: false },
      { output_id: a.id, kind: 'version_added', actor_id: ids.deputy, reason: null, has_version: true },
      { output_id: a.id, kind: 'updated', actor_id: ids.pm, reason: 'Clearer', has_version: false },
      { output_id: b.id, kind: 'submitted', actor_id: ids.bob, reason: null, has_version: true },
      { output_id: b.id, kind: 'declined', actor_id: ids.pm, reason: 'Not needed', has_version: false },
    ]);
    const audit = (await t.pool.query(`SELECT action FROM audit_events WHERE action LIKE 'output.%' ORDER BY occurred_at, id`)).rows.map((r) => r.action);
    assert.deepEqual(audit, ['output.submitted', 'output.registered', 'output.version_added', 'output.updated', 'output.submitted', 'output.declined']);
    const history = (await c.pm.request('GET', url(`/${a.id}`))).body.history.map((h: { kind: string }) => h.kind);
    assert.deepEqual(history, ['submitted', 'registered', 'version_added', 'updated']);
    await assert.rejects(t.pool.query(`UPDATE output_events SET reason = 'x'`));
  });
});
