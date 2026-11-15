import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { sha256Hex } from '../notes/text';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { backfillPassages, indexVersion } from './passage-index';

describe('passage index', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let project: string;
  let pm: Client;
  let ada: Client;

  const passages = async (kind: string) =>
    (await t.pool.query(`SELECT owner_id, ordinal, location, body, start_offset, end_offset FROM passages WHERE owner_kind = $1 ORDER BY owner_id, ordinal`, [kind])).rows;
  const thread = async (c: Client, body: Record<string, unknown> = { kind: 'discussion', title: 'Site access' }) => {
    const r = await c.request('POST', `/projects/${project}/threads`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };

  beforeEach(async () => {
    t = await startTestApp();
    ids.pm = await seedUser(t.pool, 'pm@example.org');
    ids.ada = await seedUser(t.pool, 'ada@example.org');
    await t.pool.query(`UPDATE users SET display_name = 'Ada Lim' WHERE id = $1`, [ids.ada]);
    project = await seedProject(t.pool, {
      name: 'Alpha Project',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.pm, role: 'owner' },
        { userId: ids.ada, role: 'member' },
      ],
    });
    [pm, ada] = [await t.signIn('pm@example.org'), await t.signIn('ada@example.org')];
  });
  afterEach(async () => {
    await t.close();
  });

  test('posting a message writes one passage', async () => {
    const id = await thread(ada);
    const r = await ada.request('POST', `/threads/${id}/messages`, { body: 'The pump arrives on Monday.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await passages('message_version');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'The pump arrives on Monday.');
    assert.match(rows[0].location, /^Message #1 by Ada Lim, 9 Nov 10:\d\d$/);
    assert.equal(rows[0].start_offset, 0);
    assert.equal(rows[0].end_offset, 'The pump arrives on Monday.'.length);
  });

  test('editing writes passages for the new version only', async () => {
    const id = await thread(ada);
    await ada.request('POST', `/threads/${id}/messages`, { body: 'First wording.' });
    const first = await passages('message_version');
    const messageId = (await t.pool.query(`SELECT id FROM discussion_messages WHERE thread_id = $1`, [id])).rows[0].id;
    const e = await ada.request('PUT', `/messages/${messageId}`, { body: 'Second wording.', basedOnVersion: 1 });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    const rows = await passages('message_version');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.filter((r) => r.body === 'First wording.').map((r) => r.owner_id), [first[0].owner_id], 'the old version keeps its passage');
    assert.equal(rows.filter((r) => r.body === 'Second wording.').length, 1);
  });

  test('importing notes writes passages', async () => {
    const r = await pm.request('POST', `/projects/${project}/notes`, { title: 'Site notes', text: `# Visit\n\n${'We looked at the pump and the pipes. '.repeat(8)}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await passages('source_version');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].location, '§Visit, paragraph 1');
    const v = await pm.request('POST', `/notes/${r.body.source.id}/versions`, { text: 'A second version of the notes.' });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal((await passages('source_version')).length, 2);
  });

  test('publishing minutes writes passages', async () => {
    const meeting = await thread(ada, { kind: 'meeting', title: 'Weekly check-in' });
    const m = await ada.request('POST', `/threads/${meeting}/minutes`, { body: '## Decisions\nAgreed to ship on Friday.', basedOnVersion: 0 });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal((await passages('source_version')).length, 0, 'a draft is not a source version');
    const p = await pm.request('POST', `/threads/${meeting}/minutes/1/publish`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const rows = await passages('source_version');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].location, '§Decisions, paragraph 1');
  });

  test('a discussion transcript writes none', async () => {
    const sourceId = uuidv7();
    const threadId = await thread(ada);
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id)
       SELECT $1, 'Discussion: Site access', $2, now(), project_id, 'discussion', audience_id, id FROM discussion_threads WHERE id = $3`,
      [sourceId, ids.ada, threadId],
    );
    const versionId = uuidv7();
    const text = '[#1 Ada Lim] The pump arrives on Monday.';
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, 'discussion', $3, $4, $5, $6, now())`,
      [versionId, sourceId, text, sha256Hex(text), text.length, ids.ada],
    );
    assert.equal(await indexVersion(t.pool, 'source_version', versionId, project, text), 0);
    const r = await backfillPassages(t.pool, () => undefined);
    assert.equal(r.versions, 0);
    assert.equal((await passages('source_version')).length, 0);
  });

  test('backfill indexes old versions once and a second run adds nothing', async () => {
    const id = await thread(ada);
    await ada.request('POST', `/threads/${id}/messages`, { body: 'Old message.' });
    const note = await pm.request('POST', `/projects/${project}/notes`, { title: 'Old notes', text: 'Old note text.' });
    assert.equal(note.status, 201);
    // Pretend both were stored before the index existed: passages are immutable, so truncate through the session role.
    await t.pool.query(`ALTER TABLE passages DISABLE TRIGGER USER`);
    await t.pool.query(`DELETE FROM passages`);
    await t.pool.query(`ALTER TABLE passages ENABLE TRIGGER USER`);
    const lines: string[] = [];
    const first = await backfillPassages(t.pool, (m) => lines.push(m));
    assert.equal(first.versions, 2);
    assert.equal(first.passages, 2);
    assert.ok(first.ms >= 0);
    assert.ok(lines.length > 0);
    const count = async () => Number((await t.pool.query(`SELECT count(*) AS n FROM passages`)).rows[0].n);
    assert.equal(await count(), 2);
    const second = await backfillPassages(t.pool, () => undefined);
    assert.deepEqual({ v: second.versions, p: second.passages }, { v: 0, p: 0 });
    assert.equal(await count(), 2);
    const msg = (await passages('message_version'))[0];
    assert.match(msg.location, /^Message #1 by Ada Lim, 9 Nov 10:\d\d$/);
  });

  test('backfill ends and counts nothing for a version with blank text', async () => {
    const note = await pm.request('POST', `/projects/${project}/notes`, { title: 'Real', text: 'Real text.' });
    assert.equal(note.status, 201);
    const sourceId = note.body.source.id;
    const blank = uuidv7();
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 2, 'paste', '   ', $3, 3, $4, now())`,
      [blank, sourceId, sha256Hex('   '), ids.pm],
    );
    await t.pool.query(`ALTER TABLE passages DISABLE TRIGGER USER`);
    await t.pool.query(`DELETE FROM passages`);
    await t.pool.query(`ALTER TABLE passages ENABLE TRIGGER USER`);
    const first = await backfillPassages(t.pool, () => undefined);
    assert.deepEqual({ v: first.versions, p: first.passages }, { v: 1, p: 1 });
    const second = await backfillPassages(t.pool, () => undefined);
    assert.deepEqual({ v: second.versions, p: second.passages }, { v: 0, p: 0 });
  });
});
