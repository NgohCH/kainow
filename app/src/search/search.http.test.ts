import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';
import { SEARCH_KINDS, type SearchKind, parsePhrase } from './query';
import { SearchService, applySearchSettings, buildSearchStatement } from './search.service';

/** The kinds seeded by `seedAllKinds` and so checked by every access test below. */
const ACCESS_COVERED: SearchKind[] = ['project', 'person', 'note', 'ai_proposal', 'human_proposal', 'task', 'decision', 'question', 'risk', 'message'];
/** Outputs have their own access tests (outputs/search.http.test.ts), against search_output_documents. */
const OWN_ACCESS_TESTS: SearchKind[] = ['output'];

const NEEDS_WORD = 'Type at least one word of 3 or more letters.';
const TOO_LONG = 'Search took too long. Try more specific words.';

interface Result {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string | null;
  matchNote: string | null;
  status: string | null;
  href: string;
}
interface Project {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  myAccess: { roles: string[]; grant: string | null };
  total: number;
  results: Result[];
}

describe('cross-project search', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const ids: Record<string, string> = {};
  let pm: Client;
  let member: Client;
  let bpm: Client;
  let harbour: string;
  let bridge: string;
  let grantId: string;
  /** Item ids of the "kestrel" seed in Harbour Works, by kind. */
  let seeded: Record<string, string>;
  let harbourRun: string;

  const search = (c: Client, query: string) => c.request('GET', `/search?${query}`);
  const q = (phrase: string, extra = '') => `q=${encodeURIComponent(phrase)}${extra}`;
  const projectsOf = async (c: Client, query: string): Promise<Project[]> => {
    const r = await search(c, query);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.projects;
  };

  const addMember = async (projectId: string, userId: string, role: string, o: { startsOn?: string; expiresOn?: string; revoked?: boolean } = {}) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO memberships (id, project_id, user_id, role, starts_on, expires_on, revoked_at, revoked_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, projectId, userId, role, o.startsOn ?? '2026-11-01', o.expiresOn ?? null, o.revoked ? new Date() : null, o.revoked ? ids.admin : null],
    );
    return id;
  };
  const proposal = async (projectId: string, kind: string, text: string, approved = true, at = '2026-11-02T00:00:00Z') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO human_proposals (id, project_id, kind, text, proposed_by, proposed_at, review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, projectId, kind, text, ids.pm, at, approved ? 'approved' : 'pending', approved ? ids.owner : null, approved ? at : null],
    );
    return id;
  };
  const task = async (projectId: string, title: string, at = '2026-11-03T00:00:00Z') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, authorised_by, authorised_at) VALUES ($1, $2, 0, $3, $4, '2026-11-30', $5, $6)`,
      [id, projectId, title, ids.pm, ids.owner, at],
    );
    return id;
  };
  const decision = async (projectId: string, statement: string, rationale: string | null = null, originProposal?: string) => {
    const id = uuidv7();
    const origin = originProposal ?? (await proposal(projectId, 'decision', statement));
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, rationale, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, '2026-11-04T00:00:00Z')`,
      [id, projectId, statement, rationale, origin, ids.owner],
    );
    return id;
  };
  const question = async (projectId: string, text: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO questions (id, project_id, text, requester_id, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, $4, $5, $6, '2026-11-04T00:00:00Z')`,
      [id, projectId, text, ids.pm, await proposal(projectId, 'question', text), ids.owner],
    );
    return id;
  };
  const risk = async (projectId: string, description: string) => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO risks (id, project_id, description, severity, origin_proposal_id, authorised_by, authorised_at) VALUES ($1, $2, $3, 'high', $4, $5, '2026-11-04T00:00:00Z')`,
      [id, projectId, description, await proposal(projectId, 'risk', description), ids.owner],
    );
    return id;
  };
  /** A note through the API, as its Project Manager. */
  const note = async (by: Client, projectId: string, title: string, text: string) => {
    const made = await by.request('POST', `/projects/${projectId}/notes`, { title, text });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { sourceId: made.body.source.id as string, versionId: made.body.version.id as string };
  };
  /** An AI proposal on a note version; the quote is the version's text. */
  const aiProposal = async (versionId: string, text: string, quote: string, approved = false) => {
    const runId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_runs (id, source_version_id, requested_by, status, item_count, unlocated_count, created_at, finished_at)
       VALUES ($1, $2, $3, 'succeeded', 1, 0, now(), now())`,
      [runId, versionId, ids.pm],
    );
    const itemId = uuidv7();
    await t.pool.query(
      `INSERT INTO extraction_items (id, run_id, source_version_id, position, kind, text, quote, quote_start, quote_end, quote_matches, created_at,
                                     review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 0, 'decision', $4, $5, 0, $6, 1, '2026-11-05T00:00:00Z', $7, $8, $9)`,
      [itemId, runId, versionId, text, quote, quote.length, approved ? 'approved' : 'pending', approved ? ids.owner : null, approved ? new Date() : null],
    );
    return { runId, itemId };
  };

  /** An audience of a project: Project-wide (null), or Restricted to the named people (managers see it through their role). */
  const audience = async (projectId: string, named: string[] | null) => {
    const id = uuidv7();
    await t.pool.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, $3, now())`, [id, projectId, named ? 'restricted' : 'project']);
    for (const u of named ?? []) {
      await t.pool.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, now())`, [id, u, ids.pm]);
    }
    return id;
  };
  const thread = async (projectId: string, title: string, audienceId: string, kind: 'discussion' | 'meeting' = 'discussion') => {
    const id = uuidv7();
    await t.pool.query(
      `INSERT INTO discussion_threads (id, project_id, kind, title, audience_id, meeting_date, state, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [id, projectId, kind, title, audienceId, kind === 'meeting' ? '2026-11-10' : null, kind === 'meeting' ? 'open' : null, ids.pm],
    );
    return id;
  };
  /** A message with one version per body, the last being current. */
  const message = async (threadId: string, no: number, bodies: string[], state: 'visible' | 'hidden' | 'deleted' = 'visible') => {
    const id = uuidv7();
    const marked = state !== 'visible';
    await t.pool.query(
      `INSERT INTO discussion_messages (id, thread_id, message_no, author_id, state, state_reason, state_by, state_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [id, threadId, no, ids.member, state, marked ? 'reason' : null, marked ? ids.pm : null, marked ? new Date() : null],
    );
    for (const [i, body] of bodies.entries()) {
      await t.pool.query(`INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at) VALUES ($1, $2, $3, $4, md5($4), now())`, [uuidv7(), id, i + 1, body]);
    }
    return id;
  };
  /** A source of the given kind in a thread, with one version of the given text. */
  const threadSource = async (
    projectId: string,
    threadId: string,
    audienceId: string,
    o: { kind: 'minutes' | 'discussion'; title: string; text: string; publication?: string; submittedBy?: string },
  ) => {
    const sourceId = uuidv7();
    const versionId = uuidv7();
    const publication = o.publication ?? 'published';
    const auto = o.kind === 'discussion';
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id, kind, audience_id, thread_id, publication, submitted_by, intended_mode, returned_reason)
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11)`,
      [sourceId, o.title, auto ? null : ids.pm, projectId, o.kind, audienceId, threadId, publication, o.submittedBy ?? null, o.submittedBy ? 'project' : null, publication === 'returned' ? 'Please revise' : null],
    );
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, md5($4), length($4), $5, now())`,
      [versionId, sourceId, auto ? 'discussion' : 'meeting', o.text, auto ? null : ids.pm],
    );
    return { sourceId, versionId };
  };

  /** One item of every kind whose text contains "kestrel". */
  const seedAllKinds = async (by: Client, projectId: string, personId: string, personName: string) => {
    await t.pool.query(`UPDATE projects SET purpose = 'Kestrel bay works' WHERE id = $1`, [projectId]);
    await t.pool.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [personId, personName]);
    const n = await note(by, projectId, 'Kestrel meeting', 'Kestrel site walk notes.');
    const ai = await aiProposal(n.versionId, 'Kestrel proposal', 'Kestrel site walk notes.');
    const thr = await thread(projectId, 'Kestrel thread', await audience(projectId, null));
    return {
      thread: thr,
      message: await message(thr, 1, ['Kestrel message']),
      project: projectId,
      person: personId,
      note: n.sourceId,
      ai_proposal: ai.itemId,
      run: ai.runId,
      human_proposal: await proposal(projectId, 'action', 'Kestrel human proposal', false),
      task: await task(projectId, 'Kestrel task'),
      decision: await decision(projectId, 'Kestrel decision'),
      question: await question(projectId, 'Kestrel question'),
      risk: await risk(projectId, 'Kestrel risk'),
    };
  };

  beforeEach(async () => {
    t = await startTestApp();
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'member', 'auditor', 'bpm', 'outsider', 'held', 'scheduled', 'expired', 'revoked']) {
      ids[p] = await seedUser(t.pool, `${p}@example.org`);
    }
    harbour = await seedProject(t.pool, {
      name: 'Harbour Works',
      status: 'active',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.owner, role: 'sponsor' },
        { userId: ids.member, role: 'member' },
      ],
    });
    bridge = await seedProject(t.pool, { name: 'Bridge Repair', status: 'active', members: [{ userId: ids.bpm, role: 'pm' }] });
    grantId = uuidv7();
    await t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, 'audit', 'Annual audit', 'Everything', '2026-11-01', '2026-11-10', $4, now(), 'approved', $5, now())`,
      [grantId, harbour, ids.auditor, ids.owner, ids.admin],
    );
    pm = await t.signIn('pm@example.org');
    member = await t.signIn('member@example.org');
    bpm = await t.signIn('bpm@example.org');
    await decision(harbour, 'Choose vendor in Penang');
    await decision(bridge, 'Choose vendor in Penang');
    const h = await seedAllKinds(pm, harbour, ids.member, 'Mei Kestrel');
    harbourRun = h.run;
    seeded = h;
    await seedAllKinds(bpm, bridge, ids.bpm, 'Ravi Kestrel');
  });
  afterEach(async () => {
    await t?.close();
  });

  // --- Access ---

  test('sees only projects it can read', async () => {
    assert.deepEqual((await projectsOf(member, q('vendor penang'))).map((p) => p.id), [harbour]);
    assert.deepEqual((await projectsOf(bpm, q('vendor penang'))).map((p) => p.id), [bridge]);
    const mine = await projectsOf(member, q('kestrel'));
    assert.deepEqual(mine.map((p) => p.id), [harbour]);
    assert.deepEqual([...new Set(mine[0].results.map((r) => r.kind))].sort(), [...ACCESS_COVERED].sort());
    assert.equal((await search(member, q('kestrel'))).body.searched, 1);
  });

  test('nothing for outsiders and administrators without a role', async () => {
    for (const email of ['outsider@example.org', 'admin@example.org']) {
      const c = await t.signIn(email);
      for (const phrase of ['kestrel', 'vendor penang']) {
        const r = await search(c, q(phrase));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { searched: 0, projects: [] }, email);
      }
      assert.deepEqual((await search(c, q('kestrel', `&project=${harbour}`))).body, { searched: 0, projects: [] });
    }
  });

  test('held, scheduled, expired, revoked memberships give nothing', async () => {
    const held = await addMember(harbour, ids.held, 'member');
    await t.pool.query(`UPDATE memberships SET held_at = now(), hold_reason = 'x' WHERE id = $1`, [held]);
    await addMember(harbour, ids.scheduled, 'deputy_pm', { startsOn: '2026-12-01' });
    await addMember(harbour, ids.expired, 'deputy_pm', { expiresOn: '2026-11-05' });
    await addMember(harbour, ids.revoked, 'deputy_pm', { revoked: true });
    for (const who of ['held', 'scheduled', 'expired', 'revoked']) {
      const c = await t.signIn(`${who}@example.org`);
      assert.deepEqual((await search(c, q('kestrel'))).body, { searched: 0, projects: [] }, who);
    }
  });

  test('an Audit grant holder searches read-only, until the grant lapses', async () => {
    const auditor = await t.signIn('auditor@example.org');
    const found = await projectsOf(auditor, q('kestrel'));
    assert.deepEqual(found.map((p) => p.id), [harbour]);
    assert.deepEqual(found[0].myAccess, { roles: [], grant: 'audit' });
    assert.deepEqual([...new Set(found[0].results.map((r) => r.kind))].sort(), [...ACCESS_COVERED].sort());
    assert.deepEqual((await projectsOf(member, q('kestrel')))[0].myAccess, { roles: ['member'], grant: null });
    t.clock.advanceSeconds(2 * 86400);
    const later = await t.signIn('auditor@example.org');
    assert.deepEqual((await search(later, q('kestrel'))).body, { searched: 0, projects: [] });
  });

  test('suspended or revoked grants give nothing', async () => {
    const auditor = await t.signIn('auditor@example.org');
    await t.pool.query(`UPDATE access_grants SET suspended_at = now(), suspended_by = $2, suspend_reason = 'x' WHERE id = $1`, [grantId, ids.owner]);
    assert.deepEqual((await search(auditor, q('kestrel'))).body, { searched: 0, projects: [] });
    await t.pool.query(`UPDATE access_grants SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL WHERE id = $1`, [grantId]);
    assert.equal((await projectsOf(auditor, q('kestrel'))).length, 1, 'restored');
    await t.pool.query(`UPDATE access_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = 'x' WHERE id = $1`, [grantId, ids.owner]);
    assert.deepEqual((await search(auditor, q('kestrel'))).body, { searched: 0, projects: [] });
  });

  test('a grant holder whose own membership is held gets nothing', async () => {
    const held = await addMember(harbour, ids.auditor, 'member');
    await t.pool.query(`UPDATE memberships SET held_at = now(), hold_reason = 'x' WHERE id = $1`, [held]);
    const auditor = await t.signIn('auditor@example.org');
    assert.deepEqual((await search(auditor, q('kestrel'))).body, { searched: 0, projects: [] });
  });

  test('Deferred and Closed projects are searched; archived only on request', async () => {
    await t.pool.query(`UPDATE projects SET status = 'deferred' WHERE id = $1`, [bridge]);
    const deferred = await projectsOf(bpm, q('kestrel'));
    assert.deepEqual(deferred.map((p) => [p.id, p.status, p.archived]), [[bridge, 'deferred', false]]);
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [harbour]);
    await t.pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'active', 'closed', $3, '2026-11-05T00:00:00Z')`, [
      uuidv7(),
      harbour,
      ids.pm,
    ]);
    const closed = await projectsOf(member, q('kestrel'));
    assert.deepEqual(closed.map((p) => [p.id, p.status, p.archived]), [[harbour, 'closed', false]]);
    await t.pool.query(`INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, 'archived', $3, 'Done', '2026-11-06T00:00:00Z')`, [
      uuidv7(),
      harbour,
      ids.owner,
    ]);
    assert.deepEqual((await search(member, q('kestrel'))).body, { searched: 0, projects: [] });
    const r = await search(member, q('kestrel', '&archived=1'));
    assert.equal(r.body.searched, 1);
    assert.deepEqual(r.body.projects.map((p: Project) => [p.id, p.archived]), [[harbour, true]]);
  });

  test('a Closed and archived project reached through project= needs archived=1', async () => {
    await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [harbour]);
    await t.pool.query(`INSERT INTO project_transitions (id, project_id, from_status, to_status, actor_id, at) VALUES ($1, $2, 'active', 'closed', $3, '2026-11-05T00:00:00Z')`, [
      uuidv7(),
      harbour,
      ids.pm,
    ]);
    await t.pool.query(`INSERT INTO project_archive_events (id, project_id, kind, actor_id, reason, at) VALUES ($1, $2, 'archived', $3, 'Done', '2026-11-06T00:00:00Z')`, [
      uuidv7(),
      harbour,
      ids.owner,
    ]);
    const without = await search(member, q('kestrel', `&project=${harbour}`));
    assert.equal(without.status, 200);
    assert.deepEqual(without.body.projects, []);
    const withIt = await search(member, q('kestrel', `&project=${harbour}&archived=1`));
    assert.deepEqual(withIt.body.projects.map((p: Project) => [p.id, p.archived]), [[harbour, true]]);
  });

  test('an unreadable project filter answers like no matches', async () => {
    for (const project of [bridge, 'not-a-uuid', uuidv7()]) {
      const r = await search(member, q('kestrel', `&project=${project}`));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { searched: 1, projects: [] }, project);
    }
    assert.deepEqual((await projectsOf(member, q('kestrel', `&project=${harbour}`))).map((p) => p.id), [harbour]);
  });

  test("a deleted note's text and its AI proposals are hidden", async () => {
    const n = await note(pm, harbour, 'Site walk', 'Mangrove survey done.');
    await aiProposal(n.versionId, 'Mangrove survey proposal', 'Mangrove survey done.');
    const before = await projectsOf(member, q('mangrove'));
    assert.deepEqual(before[0].results.map((r) => r.kind).sort(), ['ai_proposal', 'note']);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [n.sourceId]);
    assert.deepEqual(await projectsOf(member, q('mangrove')), []);
    await t.pool.query(`UPDATE sources SET status = 'deleted' WHERE id = $1`, [seeded.note]);
    const kinds = (await projectsOf(member, q('kestrel')))[0].results.map((r) => r.kind);
    assert.ok(!kinds.includes('note') && !kinds.includes('ai_proposal'), kinds.join());
  });

  // --- Matching ---

  test('all words, any order, part of a word, any case', async () => {
    const found = await projectsOf(member, q('PENANG vend'));
    assert.deepEqual(found[0].results.map((r) => [r.kind, r.title]), [['decision', 'Choose vendor in Penang']]);
    assert.deepEqual(await projectsOf(member, q('penang harbourx')), []);
    await question(harbour, 'Sediakan laporan mesyuarat PKX');
    const malay = await projectsOf(member, q('Mesyuarat pkx'));
    assert.deepEqual(malay[0].results.map((r) => [r.kind, r.title]), [['question', 'Sediakan laporan mesyuarat PKX']]);
  });

  test('words across two fields of one item', async () => {
    await decision(harbour, 'Choose vendor', 'Penang is closest');
    const found = await projectsOf(member, q('vendor closest'));
    assert.deepEqual(found[0].results.map((r) => r.title), ['Choose vendor']);
  });

  test('wildcards are literal', async () => {
    await task(harbour, 'Raise budget 50%');
    await task(harbour, 'Budget 500');
    await task(harbour, 'Budget_x');
    const found = await projectsOf(member, q('50%'));
    assert.deepEqual(found[0].results.map((r) => r.title), ['Raise budget 50%']);
    assert.deepEqual(await projectsOf(member, q('dget_5')), [], 'an underscore is not a one-character wildcard');
    assert.deepEqual((await projectsOf(member, q('get_')))[0].results.map((r) => r.title), ['Budget_x']);
  });

  test('every kind gives its title, href, status and note', async () => {
    const [p] = await projectsOf(member, q('kestrel'));
    const order = p.results.map((r) => r.kind);
    assert.deepEqual(order.slice(0, 6), ['project', 'person', 'task', 'decision', 'question', 'risk']);
    assert.deepEqual(order.slice(6, 8).sort(), ['ai_proposal', 'human_proposal']);
    assert.equal(order[8], 'note');
    assert.equal(order[9], 'message');
    const by = Object.fromEntries(p.results.map((r) => [r.kind, r]));
    const expect: Record<string, Omit<Result, 'kind' | 'snippet'>> = {
      project: { id: harbour, title: 'Harbour Works', matchNote: null, status: 'active', href: `#/projects/${harbour}` },
      person: { id: ids.member, title: 'Mei Kestrel', matchNote: null, status: null, href: `#/projects/${harbour}/people` },
      note: { id: seeded.note, title: 'Kestrel meeting', matchNote: null, status: null, href: `#/notes/${seeded.note}` },
      ai_proposal: { id: seeded.ai_proposal, title: 'Kestrel proposal', matchNote: null, status: 'pending', href: `#/runs/${harbourRun}` },
      human_proposal: {
        id: seeded.human_proposal,
        title: 'Kestrel human proposal',
        matchNote: null,
        status: 'pending',
        href: `#/projects/${harbour}/notes/${seeded.human_proposal}`,
      },
      task: { id: seeded.task, title: 'Kestrel task', matchNote: null, status: 'not_started', href: `#/projects/${harbour}/work/${seeded.task}` },
      decision: { id: seeded.decision, title: 'Kestrel decision', matchNote: null, status: 'active', href: `#/projects/${harbour}/work/${seeded.decision}` },
      question: { id: seeded.question, title: 'Kestrel question', matchNote: null, status: 'open', href: `#/projects/${harbour}/work/${seeded.question}` },
      risk: { id: seeded.risk, title: 'Kestrel risk', matchNote: null, status: 'open', href: `#/projects/${harbour}/work/${seeded.risk}` },
      message: { id: seeded.message, title: 'Kestrel thread', matchNote: null, status: null, href: `#/projects/${harbour}/threads/${seeded.thread}?m=1` },
    };
    for (const [kind, want] of Object.entries(expect)) {
      const { kind: _k, snippet: _s, ...got } = by[kind];
      assert.deepEqual(got, want, kind);
    }
    assert.equal(by.person.snippet, 'Member · Active');
    assert.equal(by.task.snippet, 'Kestrel task');
    assert.equal(by.project.snippet, 'Harbour Works Kestrel bay works', 'line breaks collapse to one space');
    assert.deepEqual(p.myAccess, { roles: ['member'], grant: null });
    assert.equal(p.name, 'Harbour Works');
    assert.equal(p.total, 10);

    const qid = await question(harbour, 'Which crane do we hire?');
    await t.pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'Hire the gantry crane', $3, now())`, [uuidv7(), qid, ids.pm]);
    const [a] = await projectsOf(member, q('gantry'));
    assert.deepEqual(
      a.results.map((r) => [r.kind, r.id, r.title, r.matchNote, r.href]),
      [['question', qid, 'Which crane do we hire?', 'Matched an answer', `#/projects/${harbour}/work/${qid}`]],
    );
  });

  test('snippets are cut around the first word', async () => {
    const text = `${'a'.repeat(300)} turbine ${'b'.repeat(300)}`;
    await note(pm, harbour, 'Long log', text);
    const [p] = await projectsOf(member, q('turbine'));
    const s = p.results[0].snippet as string;
    assert.ok(s.startsWith('…') && s.endsWith('…'), s);
    assert.equal(s.length, 162);
    assert.ok(s.includes('turbine'));
    const short = await note(pm, harbour, 'Short', 'turbine short');
    const [p2] = await projectsOf(member, q('turbine short'));
    assert.deepEqual(p2.results.map((r) => [r.id, r.snippet]), [[short.sourceId, 'turbine short']]);
  });

  test('the snippet is centred on the first word of 3 or more characters', async () => {
    await note(pm, harbour, 'Far apart', `of ${'a'.repeat(400)} vendor ${'b'.repeat(400)}`);
    const [p] = await projectsOf(member, q('of vendor', '&kinds=note'));
    assert.ok((p.results[0].snippet as string).includes('vendor'), p.results[0].snippet as string);
  });

  test('earlier wording', async () => {
    const a = await note(pm, harbour, 'Site log', 'turbine check');
    for (const text of ['pump check', 'valve check']) assert.equal((await pm.request('POST', `/notes/${a.sourceId}/versions`, { text })).status, 201);
    const b = await note(pm, harbour, 'Plant log', 'turbine one');
    for (const text of ['pump two', 'turbine three']) assert.equal((await pm.request('POST', `/notes/${b.sourceId}/versions`, { text })).status, 201);
    const tid = await task(harbour, 'Order pumps');
    await t.pool.query(
      `INSERT INTO task_events (id, task_id, kind, from_status, to_status, actor_id, at, detail) VALUES ($1, $2, 'amended', 'not_started', 'not_started', $3, now(), $4)`,
      [uuidv7(), tid, ids.owner, JSON.stringify({ title: { from: 'Order turbine parts', to: 'Order pumps' } })],
    );
    const c = await note(pm, harbour, 'Walkdown', 'Blades inspected.');
    const ai = await aiProposal(c.versionId, 'Inspect turbine blades', 'Blades inspected.');
    await t.pool.query(`INSERT INTO extraction_item_edits (id, item_id, text, edited_by, edited_at) VALUES ($1, $2, 'Inspect blades', $3, now())`, [uuidv7(), ai.itemId, ids.pm]);

    const [p] = await projectsOf(member, q('turbine'));
    const by = Object.fromEntries(p.results.map((r) => [r.id, r]));
    assert.equal(p.results.length, 4);
    assert.deepEqual([by[a.sourceId].matchNote, by[a.sourceId].href, by[a.sourceId].title], ['Matched version 1 of 3', `#/notes/${a.sourceId}/v/1`, 'Site log']);
    assert.deepEqual([by[b.sourceId].matchNote, by[b.sourceId].href], [null, `#/notes/${b.sourceId}`]);
    assert.deepEqual([by[tid].kind, by[tid].title, by[tid].matchNote], ['task', 'Order pumps', 'Matched wording before an amendment']);
    assert.deepEqual([by[ai.itemId].kind, by[ai.itemId].title, by[ai.itemId].matchNote], ['ai_proposal', 'Inspect blades', 'Matched earlier wording']);
    const [titled] = await projectsOf(member, q('site log'));
    assert.deepEqual(titled.results.map((r) => [r.id, r.matchNote]), [[a.sourceId, "Matched the note's title"]]);
  });

  test('one person result per project, roles listed', async () => {
    await t.pool.query(`UPDATE users SET display_name = 'Aisha Rahman' WHERE id = $1`, [ids.owner]);
    await addMember(bridge, ids.owner, 'member');
    await addMember(harbour, ids.scheduled, 'member', { startsOn: '2026-12-01' });
    await t.pool.query(`UPDATE users SET display_name = 'Farid Rahman' WHERE id = $1`, [ids.scheduled]);
    await addMember(harbour, ids.expired, 'member', { expiresOn: '2026-11-05' });
    await t.pool.query(`UPDATE users SET display_name = 'Gone Rahman' WHERE id = $1`, [ids.expired]);
    const owner = await t.signIn('owner@example.org');
    const found = await projectsOf(owner, q('rahman'));
    assert.deepEqual(found.map((p) => p.name), ['Bridge Repair', 'Harbour Works']);
    const people = (p: Project) => p.results.map((r) => [r.kind, r.title, r.snippet, r.id]);
    assert.deepEqual(people(found[0]), [['person', 'Aisha Rahman', 'Member · Active', ids.owner]]);
    assert.deepEqual(
      people(found[1]).sort(),
      [
        ['person', 'Aisha Rahman', 'Owner, Sponsor · Active', ids.owner],
        ['person', 'Farid Rahman', 'Member · Scheduled', ids.scheduled],
      ].sort(),
    );
    assert.deepEqual(found[1].myAccess, { roles: ['owner', 'sponsor'], grant: null });
  });

  test('authorised proposals are not repeated', async () => {
    const hp = await proposal(harbour, 'decision', 'Adopt solar lighting', false);
    const n = await note(pm, harbour, 'Energy', 'Panels discussed.');
    const ai = await aiProposal(n.versionId, 'Install solar panels', 'Panels discussed.');
    assert.deepEqual((await projectsOf(member, q('solar')))[0].results.map((r) => r.kind).sort(), ['ai_proposal', 'human_proposal']);
    await t.pool.query(`UPDATE human_proposals SET review_status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [hp, ids.owner]);
    await decision(harbour, 'Adopt solar lighting', null, hp);
    await t.pool.query(`UPDATE extraction_items SET review_status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [ai.itemId, ids.owner]);
    await t.pool.query(
      `INSERT INTO decisions (id, project_id, statement, origin_item_id, authorised_by, authorised_at) VALUES ($1, $2, 'Install solar panels', $3, $4, now())`,
      [uuidv7(), harbour, ai.itemId, ids.owner],
    );
    assert.deepEqual((await projectsOf(member, q('solar')))[0].results.map((r) => r.kind), ['decision', 'decision']);
  });

  test('order and limits', async () => {
    const lantern = await seedProject(t.pool, { name: 'Lantern Yard', status: 'active', members: [{ userId: ids.member, role: 'member' }] });
    const tasks: string[] = [];
    for (let i = 0; i < 12; i++) tasks.push(await task(lantern, `Lantern task ${i}`, new Date(Date.UTC(2026, 10, 2, 0, i)).toISOString()));
    const [p] = await projectsOf(member, q('lantern'));
    assert.equal(p.total, 13);
    assert.equal(p.results.length, 10);
    assert.deepEqual(p.results[0], {
      kind: 'project',
      id: lantern,
      title: 'Lantern Yard',
      snippet: 'Lantern Yard Purpose',
      matchNote: null,
      status: 'active',
      href: `#/projects/${lantern}`,
    });
    assert.deepEqual(p.results.slice(1).map((r) => r.id), [...tasks].reverse().slice(0, 9), 'newest first');
    const all = await projectsOf(member, q('lantern', `&project=${lantern}`));
    assert.equal(all[0].total, 13);
    assert.equal(all[0].results.length, 13);
    for (let i = 12; i < 55; i++) tasks.push(await task(lantern, `Lantern task ${i}`, new Date(Date.UTC(2026, 10, 2, 1, i)).toISOString()));
    const page = await projectsOf(member, q('lantern', `&project=${lantern}&offset=50`));
    assert.equal(page[0].total, 56);
    assert.deepEqual(page[0].results.map((r) => r.id), tasks.slice(0, 6).reverse());
    const first = await projectsOf(member, q('lantern', `&project=${lantern}`));
    assert.equal(first[0].results.length, 50);
    const unscoped = await search(member, q('lantern', '&offset=50'));
    assert.equal(unscoped.body.projects[0].results.length, 10, 'offset is used only with a project');
    const kinds = await projectsOf(member, q('lantern', '&kinds=project'));
    assert.deepEqual(kinds[0].results.map((r) => r.kind), ['project']);
    assert.equal(kinds[0].total, 1);
  });

  test('at most 30 projects', async () => {
    const made: Array<[string, string]> = [];
    for (let i = 1; i <= 31; i++) {
      const name = `${i % 2 ? 'osprey' : 'Osprey'} ${String(i).padStart(2, '0')}`;
      made.push([name, await seedProject(t.pool, { name, status: 'active', members: [{ userId: ids.member, role: 'member' }] })]);
    }
    const r = await search(member, q('osprey'));
    assert.equal(r.body.searched, 32);
    assert.deepEqual(r.body.projects.map((p: Project) => p.name), made.slice(0, 30).map(([n]) => n));
  });

  test('bad input gives 400 with the exact copy', async () => {
    const cases: Array<[string, string]> = [
      [q('ab'), NEEDS_WORD],
      ['', NEEDS_WORD],
      [q('x'.repeat(201)), 'Search is limited to 200 characters.'],
      [q('kestrel', '&kinds=bogus'), 'Unknown kind: bogus.'],
      [q('kestrel', `&project=${harbour}&offset=-1`), 'Offset must be a whole number of 0 or more.'],
    ];
    for (const [query, message] of cases) {
      const r = await search(member, query);
      assert.equal(r.status, 400, query);
      assert.equal(r.body.message, message);
    }
    assert.equal((await t.anonymous('GET', `/search?${q('kestrel')}`)).status, 401);
  });

  test('the phrase is not audited', async () => {
    const before = (await t.pool.query(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n;
    await projectsOf(member, q('turbine kestrel'));
    await search(member, q('turbine', '&kinds=bogus'));
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE detail::text ILIKE '%turbine%'`);
    assert.equal(rows[0].n, 0);
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n, before, 'searching writes no audit');
  });

  test('a timeout gives 503', async () => {
    // 200 notes of about 50,000 characters each, all containing the searched words. With sequential scans off the
    // trigram index finds a candidate quickly only when no note has the words; here every note is a candidate, so
    // the recheck must read and ILIKE-match 200 large texts, which takes far longer than the 1 ms limit below.
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id)
       SELECT gen_random_uuid(), 'Slow ' || g, $1, now(), $2 FROM generate_series(1, 200) g`,
      [ids.pm, harbour],
    );
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       SELECT gen_random_uuid(), s.id, 1, 'paste', x.text, md5(x.text), length(x.text), $1, now()
         FROM sources s
         CROSS JOIN LATERAL (SELECT string_agg(md5(s.id::text || g), ' ') || ' dolor sit amet consectetur' AS text FROM generate_series(1, 1500) g) x
        WHERE s.title LIKE 'Slow %'`,
      [ids.pm],
    );
    const phrase = q('dolor amet consectetur');
    const normal = await search(member, phrase);
    assert.equal(normal.status, 200, 'answers within the normal limit');
    assert.ok(normal.body.projects.length > 0);
    t.app.get(SearchService).timeoutMs = 1;
    const r = await search(member, phrase);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.message, TOO_LONG);
    assert.ok(!JSON.stringify(r.body).includes('dolor'));
  });

  test('a question matching both itself and an answer shows as the question', async () => {
    const qid = await question(harbour, 'Which crane do we hire?');
    await t.pool.query(`INSERT INTO question_answers (id, question_id, answer, author_id, at) VALUES ($1, $2, 'Hire the smaller crane', $3, now())`, [uuidv7(), qid, ids.pm]);
    const [p] = await projectsOf(member, q('crane hire'));
    assert.deepEqual(p.results.map((r) => [r.id, r.matchNote, r.snippet]), [[qid, null, 'Which crane do we hire?']]);
    const both = await note(pm, harbour, 'Crane hire', 'Crane hire agreed.');
    const [n] = await projectsOf(member, q('crane hire', '&kinds=note'));
    assert.deepEqual(n.results.map((r) => [r.id, r.matchNote, r.snippet]), [[both.sourceId, null, 'Crane hire agreed.']], 'the version text beats the title');
  });

  test("the service's statement can use the trigram indexes", async () => {
    const extra = await seedProject(t.pool, { name: 'Quay Lights', status: 'active', members: [{ userId: ids.pm, role: 'pm' }] });
    await note(pm, extra, 'Quay note', 'Pump turbine survey.');
    await task(extra, 'Pump turbine order');
    // Enough other notes and tasks that a project-by-project scan costs more than the trigram index. Each note is
    // about 6,600 characters that do not compress well, so its text goes to TOAST and the table's heap stays small:
    // the case where the planner, left to itself, wrongly prefers a sequential scan.
    await t.pool.query(
      `INSERT INTO sources (id, title, created_by, created_at, project_id)
       SELECT gen_random_uuid(), 'Bulk ' || g, $1, now(), $2 FROM generate_series(1, 1000) g`,
      [ids.pm, harbour],
    );
    await t.pool.query(
      `INSERT INTO source_versions (id, source_id, version_no, origin, text_content, text_sha256, char_count, created_by, created_at)
       SELECT gen_random_uuid(), s.id, 1, 'paste', x.text, md5(x.text), length(x.text), $1, now()
         FROM sources s
         CROSS JOIN LATERAL (SELECT string_agg(md5(s.id::text || g), ' ') AS text FROM generate_series(1, 200) g) x
        WHERE s.title LIKE 'Bulk %'`,
      [ids.pm],
    );
    await t.pool.query(
      `INSERT INTO tasks (id, project_id, depth, title, assignee_id, due_on, authorised_by, authorised_at)
       SELECT gen_random_uuid(), $1, 0, 'Bulk task ' || g, $2, '2026-11-30', $2, now() FROM generate_series(1, 5000) g`,
      [harbour, ids.pm],
    );
    await t.pool.query('VACUUM ANALYZE');
    const { words, patterns } = parsePhrase('turbine pump');
    const statement = buildSearchStatement({ ids: [harbour, bridge, extra], kinds: [...SEARCH_KINDS], patterns, today: '2026-11-09', first: words[0], scoped: false, offset: 0, userId: ids.pm });
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      // The service's own transaction settings, nothing added here.
      await applySearchSettings(client, t.app.get(SearchService).timeoutMs);
      const plan = (await client.query(`EXPLAIN ${statement.text}`, statement.values)).rows.map((r) => r['QUERY PLAN']).join('\n');
      await client.query('ROLLBACK');
      assert.match(plan, /search_source_versions_trgm/);
      assert.match(plan, /search_tasks_trgm/);
    } finally {
      client.release();
    }
  });

  // --- Discussion: messages and source audiences ---

  const found = async (c: Client, phrase: string, extra = '') => (await projectsOf(c, q(phrase, extra))).flatMap((p) => p.results);

  test('message found by a participant', async () => {
    const thr = await thread(harbour, 'Berth planning', await audience(harbour, null));
    const id = await message(thr, 7, ['First wording about pontoon anchors', 'Second wording about pontoon moorings']);
    const hits = await found(member, 'pontoon moorings');
    assert.deepEqual(hits.map((r) => [r.kind, r.id, r.title, r.href]), [['message', id, 'Berth planning', `#/projects/${harbour}/threads/${thr}?m=7`]]);
    assert.match(hits[0].snippet as string, /Second wording about pontoon moorings/);
    assert.deepEqual(await found(member, 'pontoon anchors'), [], 'an earlier version is not searched');
    assert.deepEqual(await found(member, 'pontoon moorings', '&kinds=task'), []);
    assert.equal((await found(await t.signIn('auditor@example.org'), 'pontoon moorings')).length, 1, 'an Audit grant holder reads a Project-wide thread');
    assert.deepEqual(await found(await t.signIn('outsider@example.org'), 'pontoon moorings'), []);
  });

  test('hidden and deleted messages not found', async () => {
    const thr = await thread(harbour, 'Berth planning', await audience(harbour, null));
    await message(thr, 1, ['Visible dredging remark']);
    await message(thr, 2, ['Hidden dredging remark'], 'hidden');
    await message(thr, 3, ['Deleted dredging remark'], 'deleted');
    for (const c of [member, pm]) {
      assert.deepEqual((await found(c, 'dredging remark')).map((r) => r.snippet), ['Visible dredging remark']);
    }
  });

  test('restricted meeting message not found by an outsider', async () => {
    await addMember(harbour, ids.held, 'member');
    const named = await t.signIn('held@example.org');
    const thr = await thread(harbour, 'Contract talks', await audience(harbour, [ids.held]), 'meeting');
    const id = await message(thr, 1, ['Secret retainer figure']);
    assert.deepEqual(await found(member, 'retainer figure'), [], 'a project member outside the audience');
    assert.deepEqual((await found(named, 'retainer figure')).map((r) => r.id), [id], 'a named person');
    assert.deepEqual((await found(pm, 'retainer figure')).map((r) => r.id), [id], 'the Project Manager');
    const owner = await t.signIn('owner@example.org');
    assert.deepEqual((await found(owner, 'retainer figure')).map((r) => r.id), [id], 'Owner and Sponsor');
    assert.deepEqual(await found(await t.signIn('auditor@example.org'), 'retainer figure'), [], 'an Audit grant holder outside the audience');
    // The audience is the thread's: widening it shows the message.
    await t.pool.query(`UPDATE audiences SET mode = 'project' WHERE id = (SELECT audience_id FROM discussion_threads WHERE id = $1)`, [thr]);
    assert.equal((await found(member, 'retainer figure')).length, 1);
  });

  test('restricted minutes and their proposals not found by an outsider', async () => {
    await addMember(harbour, ids.held, 'member');
    const named = await t.signIn('held@example.org');
    const aud = await audience(harbour, [ids.held]);
    const thr = await thread(harbour, 'Board session', aud, 'meeting');
    const { sourceId, versionId } = await threadSource(harbour, thr, aud, { kind: 'minutes', title: 'Zeppelin minutes', text: 'Zeppelin budget was cut. Quarry lease agreed.' });
    const run = await aiProposal(versionId, 'Quarry lease proposal', 'Quarry lease agreed.');
    await t.pool.query(`INSERT INTO extraction_item_edits (id, item_id, text, edited_by, edited_at) VALUES ($1, $2, 'Quarry rental proposal', $3, now())`, [uuidv7(), run.itemId, ids.pm]);
    for (const phrase of ['zeppelin', 'budget cut', 'quarry lease', 'quarry rental']) {
      assert.deepEqual(await found(member, phrase), [], `outsider: ${phrase}`);
      assert.ok((await found(named, phrase)).length >= 1, `named: ${phrase}`);
      assert.ok((await found(pm, phrase)).length >= 1, `manager: ${phrase}`);
    }
    assert.deepEqual([...new Set((await found(named, 'quarry')).map((r) => r.kind))].sort(), ['ai_proposal', 'note']);
    assert.deepEqual((await found(named, 'zeppelin')).map((r) => r.id), [sourceId]);
    // Project-wide minutes are found by everyone.
    const open = await audience(harbour, null);
    await threadSource(harbour, await thread(harbour, 'Open session', open), open, { kind: 'minutes', title: 'Open minutes', text: 'Gazebo roof agreed.' });
    assert.equal((await found(member, 'gazebo roof')).length, 1);
  });

  test('submitted notes found only by submitter and managers', async () => {
    await addMember(harbour, ids.held, 'member');
    await addMember(harbour, ids.expired, 'deputy_pm');
    await addMember(harbour, ids.scheduled, 'deputy_pm', { startsOn: '2026-12-01' });
    await addMember(harbour, ids.revoked, 'deputy_pm', { revoked: true });
    const aud = await audience(harbour, null);
    const submitted = await threadSource(harbour, await thread(harbour, 'Review meeting', aud, 'meeting'), aud, {
      kind: 'minutes',
      title: 'Yardarm minutes',
      text: 'Yardarm inspection planned.',
      publication: 'submitted',
      submittedBy: ids.member,
    });
    await threadSource(harbour, await thread(harbour, 'Second meeting', aud, 'meeting'), aud, {
      kind: 'minutes',
      title: 'Yardarm second',
      text: 'Yardarm second review.',
      publication: 'returned',
      submittedBy: ids.member,
    });
    const wants: Array<[string, number]> = [
      ['member@example.org', 2],
      ['pm@example.org', 2],
      ['owner@example.org', 2],
      ['expired@example.org', 2],
      ['held@example.org', 0],
      ['scheduled@example.org', 0],
      ['revoked@example.org', 0],
      ['auditor@example.org', 0],
      ['bpm@example.org', 0],
    ];
    for (const [email, n] of wants) {
      const hits = (await found(await t.signIn(email), 'yardarm')).filter((r) => r.kind === 'note');
      assert.equal(hits.length, n, email);
    }
    await t.pool.query(`UPDATE sources SET publication = 'published' WHERE id = $1`, [submitted.sourceId]);
    assert.equal((await found(await t.signIn('held@example.org'), 'yardarm inspection')).length, 1, 'published: everyone in the audience');
  });

  test('transcript text never matched directly', async () => {
    const aud = await audience(harbour, null);
    const { sourceId, versionId } = await threadSource(harbour, await thread(harbour, 'Open thread', aud), aud, {
      kind: 'discussion',
      title: 'Transcript of Open thread',
      text: '#1 Ada Member 2026-11-10 10:00\nThe ballast timetable is late.',
    });
    // The proposal's own wording is searchable by the audience; its quote, which copies message text, is not.
    const prop = await aiProposal(versionId, 'Reschedule ballast delivery', 'The ballast timetable is late.');
    for (const c of [member, pm]) {
      assert.deepEqual(await found(c, 'ballast timetable'), [], 'transcript text and the quote');
      assert.deepEqual(await found(c, 'Transcript of Open'), [], 'transcript title');
      assert.deepEqual((await found(c, 'reschedule ballast')).map((r) => [r.kind, r.id]), [['ai_proposal', prop.itemId]]);
    }
    // Under a Restricted audience an outsider does not find the proposal either.
    await t.pool.query(`UPDATE sources SET audience_id = $2 WHERE id = $1`, [sourceId, await audience(harbour, [ids.pm])]);
    assert.deepEqual(await found(member, 'reschedule ballast'), []);
    assert.equal((await found(pm, 'reschedule ballast')).length, 1);
  });

  test('message search uses the trigram index, not a scan of every version', async () => {
    const thr = await thread(harbour, 'Bulk thread', await audience(harbour, null));
    await t.pool.query(
      `INSERT INTO discussion_messages (id, thread_id, message_no, author_id, created_at)
       SELECT gen_random_uuid(), $1, g, $2, now() FROM generate_series(1, 3000) g`,
      [thr, ids.member],
    );
    await t.pool.query(
      `INSERT INTO message_versions (id, message_id, version_no, body, body_sha256, created_at)
       SELECT gen_random_uuid(), m.id, v, 'Message ' || m.message_no || ' revision ' || v || ' ' || md5(m.id::text || v), 'x', now()
         FROM discussion_messages m CROSS JOIN generate_series(1, 3) v WHERE m.thread_id = $1`,
      [thr],
    );
    await message(thr, 9000, ['A lone bollard mention']);
    await t.pool.query('VACUUM ANALYZE');
    const { words, patterns } = parsePhrase('bollard mention');
    const statement = buildSearchStatement({ ids: [harbour], kinds: ['message'], patterns, today: '2026-11-09', first: words[0], scoped: false, offset: 0, userId: ids.member });
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await applySearchSettings(client, t.app.get(SearchService).timeoutMs);
      const plan = (await client.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${statement.text}`, statement.values)).rows.map((r) => r['QUERY PLAN']).join('\n');
      await client.query('ROLLBACK');
      if (process.env.KAINOW_PRINT_PLAN) console.log(plan);
      assert.match(plan, /message_versions_trgm/);
      assert.doesNotMatch(plan, /Seq Scan on message_versions/);
    } finally {
      client.release();
    }
    assert.equal((await found(member, 'bollard mention')).length, 1);
  });

  // --- Guard ---

  test('every kind the view returns has access coverage', async () => {
    const { rows } = await t.pool.query(`SELECT DISTINCT kind FROM search_documents ORDER BY kind`);
    const outputs = (await t.pool.query(`SELECT DISTINCT kind FROM search_output_documents`)).rows.map((r) => r.kind);
    assert.deepEqual([...rows.map((r) => r.kind), ...OWN_ACCESS_TESTS].sort(), [...SEARCH_KINDS].sort());
    assert.deepEqual(outputs.length === 0 ? OWN_ACCESS_TESTS : outputs, OWN_ACCESS_TESTS);
    assert.deepEqual([...ACCESS_COVERED, ...OWN_ACCESS_TESTS].sort(), [...SEARCH_KINDS].sort());
  });
});
