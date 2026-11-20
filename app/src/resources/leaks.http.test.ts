import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { uuidv7 } from '../common/uuid7';
import { SKIP_NO_DB } from '../testing/db';
import { type Client, type Reply, type TestApp, startTestApp } from '../testing/http';
import { seedProject, seedUser } from '../testing/projects';

/**
 * Cross-surface leak suite for resources and finance (spec 1 anti-goals, 3.3, 3.6, 3.7, 6, 13). One shared setup,
 * read by every surface:
 *
 * - Harbour works (A) tracks finance in MYR: a budget, three spending entries (one foreign), an approved correction and
 *   a pending refund. Its people: PM, Owner, Sponsor, Member M (no policy), former member of B (R), holder of an
 *   expired grant on C (X), and an Audit grant holder G (no policy). Leadership holder L has organisation scope. The
 *   Administrator is a participant nowhere.
 * - Quillon Yard (B) and Corvid Basin (C) each record the same catalogue item over A's period. The PM can open B (a
 *   Member there); R was a Member of B (revoked); X held a grant on C (expired). No one else in A can open B or C.
 *
 * Every amount, text and hidden detail is distinctive, so its absence from a body means something; the PM's finance
 * view shows each one first.
 */

// 10:00 on 20 November 2026 in UTC+8.
const START = Date.UTC(2026, 10, 20, 2, 0, 0);
const LIMITED = 'Only counts are shown: you are not a participant in this project.';

/** Spending detail: never shown to anyone but a finance reader, and never in a summary surface. */
const DETAIL = {
  entry1: '1234.56',
  entry1Formatted: '1,234.56',
  entry2: '2345.67',
  entry2Formatted: '2,345.67',
  correction: '1999.99',
  correctionFormatted: '1,999.99',
  refund: '111.11',
  foreign: '456.78',
  description1: 'Keelson rope coils',
  description2: 'Davit winch service',
  description3: 'Bollard paint import',
  reference1: 'INV-QUOLL-11',
  reference2: 'INV-QUOLL-22',
  reference3: 'INV-QUOLL-33',
  budgetReason: 'Budget reason halyardine',
  correctionReason: 'Fathomwick invoice recheck',
  refundReason: 'Tidewrack partial return',
} as const;
/** The budget and the spent total: shown to finance readers, the leadership card and Administrator analytics only. */
const TOTALS = { budget: '8765.43', budgetFormatted: '8,765.43', spent: '3234.55', spentFormatted: '3,234.55' } as const;
/** B's and C's names and their lines' quantities and notes: never in A's surfaces for someone who cannot open them. */
const HIDDEN_B = { name: 'Quillon Yard', quantity: '7.25', notes: 'Gunwale secret notes' } as const;
const HIDDEN_C = { name: 'Corvid Basin', quantity: '3.75', notes: 'Corvid hidden notes' } as const;
const OWN_NOTES = 'Harbour own notes';

const json = (x: unknown): string => JSON.stringify(x ?? null);
const assertAbsent = (text: string, markers: Record<string, string>, where: string) => {
  for (const [what, marker] of Object.entries(markers)) assert.ok(!text.includes(marker), `${where} carries ${what} (${marker})`);
};

describe('resources and finance leak suite', { skip: SKIP_NO_DB }, () => {
  let t: TestApp;
  const c: Record<string, Client> = {};
  const ids: Record<string, string> = {};
  let a: string;
  let b: string;
  let cProject: string;
  let item: string;
  let lineA: string;
  let lineB: string;

  const ok = async (r: Promise<Reply>, status = 200) => {
    const x = await r;
    assert.equal(x.status, status, json(x.body));
    return x.body;
  };
  const raw = async (who: string, path: string, status = 200) => {
    const r = await c[who].raw('GET', path);
    assert.equal(r.status, status, `${who} ${path}: ${r.text}`);
    return r.text;
  };
  const grant = (project: string, userId: string, kind: 'audit' | 'oversight', expiresOn: string) =>
    t.pool.query(
      `INSERT INTO access_grants (id, project_id, user_id, kind, purpose, scope, starts_on, expires_on, requested_by, requested_at, decision, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, 'Annual audit', 'Everything', '2026-11-01', $5, $6, now(), 'approved', $7, now())`,
      [uuidv7(), project, userId, kind, expiresOn, ids.pm, ids.admin],
    );
  const otherLine = (project: string, quantity: string, notes: string, startsOn: string, endsOn: string | null, by: string) => {
    const id = uuidv7();
    return t.pool
      .query(
        `INSERT INTO resource_lines (id, project_id, item_id, description, quantity, unit, starts_on, ends_on, notes, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, '', $4, 'items', $5, $6, $7, 'arranged', $8, now(), now())`,
        [id, project, item, quantity, startsOn, endsOn, notes, by],
      )
      .then(() => id);
  };

  before(async () => {
    t = await startTestApp(START);
    ids.admin = await seedUser(t.pool, 'admin@example.org', 'enterprise_administrator');
    for (const p of ['pm', 'owner', 'sponsor', 'mem', 'former', 'lapsed', 'auditor', 'leader', 'bpm', 'cpm']) ids[p] = await seedUser(t.pool, `${p}@example.org`);
    a = await seedProject(t.pool, {
      status: 'active',
      name: 'Harbour works',
      members: [
        { userId: ids.pm, role: 'pm' },
        { userId: ids.owner, role: 'owner' },
        { userId: ids.sponsor, role: 'sponsor' },
        { userId: ids.mem, role: 'member' },
        { userId: ids.former, role: 'member' },
        { userId: ids.lapsed, role: 'member' },
      ],
    });
    b = await seedProject(t.pool, {
      status: 'active',
      name: HIDDEN_B.name,
      members: [
        { userId: ids.bpm, role: 'pm' },
        { userId: ids.bpm, role: 'owner' },
        { userId: ids.pm, role: 'member' },
        { userId: ids.former, role: 'member', revoked: true },
      ],
    });
    cProject = await seedProject(t.pool, {
      status: 'closed',
      name: HIDDEN_C.name,
      members: [
        { userId: ids.cpm, role: 'pm' },
        { userId: ids.cpm, role: 'owner' },
      ],
    });
    await grant(a, ids.auditor, 'audit', '2026-11-30');
    await grant(cProject, ids.lapsed, 'oversight', '2026-11-19');
    for (const p of Object.keys(ids)) c[p] = await t.signIn(`${p}@example.org`);
    await ok(c.admin.request('POST', '/admin/leadership-grants', { userId: ids.leader, scope: { kind: 'organisation' }, startsOn: '2026-11-20', reason: 'Oversight' }), 201);

    // The shared catalogue item: A records it through the API; B and C (a Closed project still counts) over the same period.
    item = uuidv7();
    await t.pool.query(`INSERT INTO resource_items (id, kind, reference, name, created_by, created_at, status) VALUES ($1, 'equipment', 'P-04', 'Dummy projector', $2, now(), 'active')`, [
      item,
      ids.admin,
    ]);
    const made = await ok(
      c.pm.request('POST', `/projects/${a}/resources/lines`, {
        itemId: item,
        quantity: '2',
        unit: 'items',
        startsOn: '2026-12-03',
        endsOn: '2026-12-14',
        neededBy: '2026-12-01',
        notes: OWN_NOTES,
      }),
      201,
    );
    lineA = made.line.id;
    lineB = await otherLine(b, HIDDEN_B.quantity, HIDDEN_B.notes, '2026-12-05', '2026-12-10', ids.bpm);
    await otherLine(cProject, HIDDEN_C.quantity, HIDDEN_C.notes, '2026-12-01', null, ids.cpm);

    // A's finance: a budget, two MYR entries and a USD one awaiting conversion, an approved correction, a pending refund.
    await t.pool.query(`INSERT INTO project_finance_settings (project_id, tracking, currency) VALUES ($1, 'enabled', 'MYR')`, [a]);
    const approve = async (requestId: string) => {
      t.clock.advanceSeconds(60);
      const r = await ok(c.owner.request('POST', `/changes/${requestId}/approve`, { version: 1 }));
      assert.equal(r.request.status, 'authorised');
    };
    const budget = await ok(c.pm.request('POST', `/projects/${a}/finance/budget`, { amount: TOTALS.budget, reason: DETAIL.budgetReason }), 201);
    await approve(budget.request.id);
    const spend = async (amount: string, currency: string, description: string, reference: string) =>
      (await ok(c.pm.request('POST', `/projects/${a}/finance/spending`, { spentOn: '2026-11-18', amount, currency, description, reference }), 201)).entry.id as string;
    const e1 = await spend(DETAIL.entry1, 'MYR', DETAIL.description1, DETAIL.reference1);
    const e2 = await spend(DETAIL.entry2, 'MYR', DETAIL.description2, DETAIL.reference2);
    await spend(DETAIL.foreign, 'USD', DETAIL.description3, DETAIL.reference3);
    t.clock.advanceSeconds(60);
    const correction = await ok(
      c.pm.request('POST', `/projects/${a}/finance/spending/${e2}/adjust`, { type: 'correction', amount: DETAIL.correction, reason: DETAIL.correctionReason }),
      201,
    );
    await approve(correction.request.id);
    await ok(
      c.pm.request('POST', `/projects/${a}/finance/spending/${e1}/adjust`, { type: 'refund', amount: DETAIL.refund, refundOn: '2026-11-19', reason: DETAIL.refundReason }),
      201,
    );

    // Positive control: the PM's finance view holds every marker, so their absence elsewhere means something.
    const view = await ok(c.pm.request('GET', `/projects/${a}/finance`));
    assert.equal(view.figures.spent, TOTALS.spent);
    assert.equal(view.figures.budget, TOTALS.budget);
    const text = json(view) + json(await ok(c.pm.request('GET', `/projects/${a}/changes`)));
    for (const [what, marker] of Object.entries({ ...DETAIL, budget: TOTALS.budget, spent: TOTALS.spent })) {
      if (what.endsWith('Formatted')) continue;
      assert.ok(text.includes(marker), `the PM's finance view shows ${what}`);
    }
  });
  after(async () => {
    await t?.close();
  });

  const NOT_FOR_NON_READERS = { ...DETAIL, ...TOTALS };
  const NOT_NAMED = { ...HIDDEN_B, ...HIDDEN_C };
  /** B and C may each be named only to someone who can open them; their quantity and notes go to no one through A. */
  const hiddenFor = (who: string) => (who === 'pm' ? { bQuantity: HIDDEN_B.quantity, bNotes: HIDDEN_B.notes, ...HIDDEN_C } : NOT_NAMED);
  const lineOf = (body: { lines: Array<{ id: string; overlap: unknown }> }) => body.lines.find((l) => l.id === lineA) as { overlap: unknown };

  for (const who of ['mem', 'auditor'] as const) {
    describe(`a ${who === 'mem' ? 'Member' : 'grant holder'} with no finance policy`, () => {
      test('the Resources tab shows lines and the tracking value only; overlap is a count', async () => {
        const body = await ok(c[who].request('GET', `/projects/${a}/resources`));
        assert.deepEqual(body.finance, { tracking: 'enabled' });
        assert.deepEqual(lineOf(body).overlap, { named: [], others: 2 });
        assert.ok(json(body).includes(OWN_NOTES), 'the own line shows');
        assertAbsent(json(body), NOT_FOR_NON_READERS, `${who} Resources tab`);
        assertAbsent(json(body), NOT_NAMED, `${who} Resources tab`);
      });

      test('the report JSON and CSV carry no finance section and no hidden overlap detail', async () => {
        const body = await ok(c[who].request('GET', `/projects/${a}/resources/report`));
        assert.equal('finance' in body, false);
        assert.deepEqual(lineOf(body).overlap, { named: [], others: 2 });
        assertAbsent(json(body), { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, `${who} report`);
        const csv = await raw(who, `/projects/${a}/resources/report?format=csv`);
        assert.doesNotMatch(csv, /# Section: finance/);
        assert.match(csv, new RegExp(`,,2,${OWN_NOTES}\\r\\n`));
        assertAbsent(csv, { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, `${who} report CSV`);
      });

      test('the finance read is refused and the settings carry no figures', async () => {
        const fin = await c[who].request('GET', `/projects/${a}/finance`);
        assert.equal(fin.status, 403, json(fin.body));
        assertAbsent(json(fin.body), NOT_FOR_NON_READERS, `${who} finance read`);
        const settings = await ok(c[who].request('GET', `/projects/${a}/settings/finance`));
        assertAbsent(json(settings), NOT_FOR_NON_READERS, `${who} finance settings`);
        const preview = await c[who].request('GET', `/projects/${a}/settings/finance/preview`);
        assert.equal(preview.status, 403, json(preview.body));
      });

      test('the project dashboard, timeline, change list, line history, personal dashboard and notices carry nothing of finance', async () => {
        const dash = await ok(c[who].request('GET', `/projects/${a}/dashboard`));
        assert.deepEqual(dash.finance, { tracking: 'enabled' });
        assertAbsent(json(dash), { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, `${who} project dashboard`);
        const timeline = await ok(c[who].request('GET', `/projects/${a}/timeline`));
        assert.ok(json(timeline).includes('Needed by: P-04 Dummy projector'), 'the timeline shows the line');
        assertAbsent(json(timeline), { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, `${who} timeline`);
        const changes = await ok(c[who].request('GET', `/projects/${a}/changes`));
        assert.deepEqual(changes.requests.filter((r: { kind: string }) => r.kind === 'set_budget' || r.kind === 'finance_adjustment'), []);
        assertAbsent(json(changes), NOT_FOR_NON_READERS, `${who} change list`);
        assert.ok(!json(changes).includes('finance_adjustment') && !json(changes).includes('set_budget'), `${who} change list names a finance kind`);
        const history = await ok(c[who].request('GET', `/projects/${a}/resources/lines/${lineA}/history`));
        assertAbsent(json(history), NOT_FOR_NON_READERS, `${who} line history`);
        for (const path of ['/dashboard/me', '/notifications']) {
          const body = await ok(c[who].request('GET', path));
          assertAbsent(json(body), { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, `${who} ${path}`);
          assert.ok(!json(body).includes('finance_adjustment') && !json(body).includes('Adjust a spending entry'), `${who} ${path} shows a finance request`);
        }
      });
    });
  }

  describe('overlap names only projects the viewer can open', () => {
    for (const who of ['former', 'lapsed'] as const) {
      test(`${who === 'former' ? 'a former Member of B' : 'the holder of an expired grant on C'} sees B and C only as a count`, async () => {
        const tab = await ok(c[who].request('GET', `/projects/${a}/resources`));
        assert.deepEqual(lineOf(tab).overlap, { named: [], others: 2 });
        const report = await ok(c[who].request('GET', `/projects/${a}/resources/report`));
        assert.deepEqual(lineOf(report).overlap, { named: [], others: 2 });
        const csv = await raw(who, `/projects/${a}/resources/report?format=csv`);
        assert.match(csv, new RegExp(`,,2,${OWN_NOTES}\\r\\n`));
        for (const [where, text] of [['tab', json(tab)], ['report', json(report)], ['CSV', csv]]) assertAbsent(text, NOT_NAMED, `${who} ${where}`);
        // Neither can open B's line history through either project.
        assert.equal((await c[who].request('GET', `/projects/${b}/resources/lines/${lineB}/history`)).status, 404);
      });
    }

    test('a viewer who can open B sees it named, with none of its quantity or notes, and C counted', async () => {
      const tab = await ok(c.pm.request('GET', `/projects/${a}/resources`));
      assert.deepEqual(lineOf(tab).overlap, { named: [{ projectId: b, name: HIDDEN_B.name }], others: 1 });
      const report = await ok(c.pm.request('GET', `/projects/${a}/resources/report`));
      assert.deepEqual(lineOf(report).overlap, { named: [{ projectId: b, name: HIDDEN_B.name }], others: 1 });
      const csv = await raw('pm', `/projects/${a}/resources/report?format=csv`);
      assert.match(csv, new RegExp(`,${HIDDEN_B.name},1,${OWN_NOTES}\\r\\n`));
      for (const [where, text] of [['tab', json(tab)], ['report', json(report)], ['CSV', csv]]) assertAbsent(text, hiddenFor('pm'), `pm ${where}`);
    });

    test('line history is per project: another project’s line is not found', async () => {
      // The PM can open both A and B, yet B's line is not A's.
      assert.equal((await c.pm.request('GET', `/projects/${a}/resources/lines/${lineB}/history`)).status, 404);
      assert.equal((await c.pm.request('GET', `/projects/${b}/resources/lines/${lineA}/history`)).status, 404);
      assert.equal((await c.mem.request('GET', `/projects/${a}/resources/lines/${lineB}/history`)).status, 404);
      assert.equal((await c.pm.request('GET', `/projects/${b}/resources/lines/${lineB}/history`)).status, 200);
    });

    test('a Closed project’s lines are read-only', async () => {
      const d = await seedProject(t.pool, {
        status: 'active',
        name: 'Dock works',
        members: [
          { userId: ids.pm, role: 'pm' },
          { userId: ids.owner, role: 'owner' },
        ],
      });
      const url = (path = '') => `/projects/${d}/resources${path}`;
      const line = (await ok(c.pm.request('POST', url('/lines'), { oneOffKind: 'other', description: 'Hired tug' }), 201)).line;
      await t.pool.query(`UPDATE projects SET status = 'closed', closure_outcome = 'abandoned' WHERE id = $1`, [d]);
      assert.equal((await ok(c.pm.request('GET', url()))).lines.length, 1);
      assert.equal((await c.pm.request('POST', url('/lines'), { oneOffKind: 'other', description: 'Another tug' })).status, 403);
      assert.equal((await c.pm.request('PUT', url(`/lines/${line.id}`), { notes: 'Late' })).status, 403);
      assert.equal((await c.pm.request('POST', url(`/lines/${line.id}/status`), { status: 'arranged' })).status, 403);
      assert.equal((await c.pm.request('POST', url(`/lines/${line.id}/cancel`), { reason: 'Not needed' })).status, 403);
      const after = (await ok(c.pm.request('GET', url()))).lines[0];
      assert.equal(after.status, 'needed');
      assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM resource_line_events WHERE line_id = $1`, [line.id])).rows[0].n, 1);
    });
  });

  describe('a leadership holder', () => {
    test('gets 404 from the Resources tab, report, line history, finance and finance settings', async () => {
      for (const path of [
        `/projects/${a}/resources`,
        `/projects/${a}/resources/report`,
        `/projects/${a}/resources/report?format=csv`,
        `/projects/${a}/resources/lines/${lineA}/history`,
        `/projects/${a}/finance`,
        `/projects/${a}/settings/finance`,
        `/projects/${a}/settings/finance/preview`,
        `/projects/${a}/dashboard`,
        `/projects/${a}/timeline`,
        `/projects/${a}/changes`,
      ]) {
        const r = await c.leader.request('GET', path);
        assert.equal(r.status, 404, path);
        assertAbsent(json(r.body), { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, `leader ${path}`);
      }
    });

    test('the leadership card carries only the resource counts and budget summary', async () => {
      const body = await ok(c.leader.request('GET', '/dashboard/leadership'));
      const card = body.cards.find((x: { id: string }) => x.id === a);
      assert.deepEqual(card.resources, { needed: 1, arranged: 0, inUse: 0, neededByPassed: 0 });
      assert.deepEqual(Object.keys(card.budget).sort(), ['budget', 'currency', 'level', 'overBudget', 'percentUsed', 'spent', 'tracking']);
      assert.equal(card.budget.budget, TOTALS.budget);
      assert.equal(card.budget.spent, TOTALS.spent);
      const text = json(body);
      assertAbsent(text, DETAIL, 'the leadership summary');
      assertAbsent(text, { own: OWN_NOTES, bNotes: HIDDEN_B.notes, cNotes: HIDDEN_C.notes, bQuantity: HIDDEN_B.quantity, cQuantity: HIDDEN_C.quantity }, 'the leadership summary');
      assert.ok(!text.includes('P-04') && !text.includes('Dummy projector'), 'the leadership summary names an item');
      const mine = await ok(c.leader.request('GET', '/dashboard/me'));
      assertAbsent(json(mine), { ...NOT_FOR_NON_READERS, ...NOT_NAMED }, 'the leader personal dashboard');
    });
  });

  describe('a non-participant Administrator', () => {
    test('gets 404 from the finance read and the Resources tab; the settings and off-preview carry counts only', async () => {
      for (const path of [`/projects/${a}/finance`, `/projects/${a}/resources`, `/projects/${a}/resources/report`]) {
        const r = await c.admin.request('GET', path);
        assert.equal(r.status, 404, path);
        assertAbsent(json(r.body), NOT_FOR_NON_READERS, `admin ${path}`);
      }
      const settings = await ok(c.admin.request('GET', `/projects/${a}/settings/finance`));
      assert.equal(settings.editable, true);
      assertAbsent(json(settings), NOT_FOR_NON_READERS, 'admin finance settings');
      const preview = await ok(c.admin.request('GET', `/projects/${a}/settings/finance/preview`));
      assert.deepEqual(preview, { entries: 3, budgetVersions: 1, pending: 1 });
    });

    test('drill-down gives counts only, never lines, entries or notes', async () => {
      for (const measure of ['linesNeeded', 'linesOverlapping', 'linesArranged', 'linesInUse', 'linesFinished', 'linesNeededByPassed', 'financeAtFirst', 'financeAtSecond', 'financeBudgetNotProvided']) {
        const r = await ok(c.admin.request('GET', `/admin/analytics/drill?level=project&id=${a}&measure=${measure}`));
        assert.equal(r.lines, undefined, measure);
        assert.equal(r.records, undefined, measure);
        if (measure.startsWith('lines')) assert.equal(r.limited, LIMITED, measure);
        assert.equal(typeof r.counts.total, 'number', measure);
        const text = json(r);
        assertAbsent(text, NOT_FOR_NON_READERS, `drill ${measure}`);
        assertAbsent(text, { own: OWN_NOTES, bNotes: HIDDEN_B.notes, cNotes: HIDDEN_C.notes, bQuantity: HIDDEN_B.quantity, cQuantity: HIDDEN_C.quantity }, `drill ${measure}`);
      }
      assert.equal((await ok(c.admin.request('GET', `/admin/analytics/drill?level=project&id=${a}&measure=linesOverlapping`))).counts.total, 1);
      for (const q of ['level=org&measure=linesOverlapping', 'level=org&measure=financeAtFirst']) {
        const r = await ok(c.admin.request('GET', `/admin/analytics/drill?${q}`));
        assert.equal(r.lines, undefined);
        assertAbsent(json(r), { ...DETAIL, own: OWN_NOTES, bNotes: HIDDEN_B.notes, cNotes: HIDDEN_C.notes }, `drill ${q}`);
      }
    });

    test('the analytics panel and its CSV carry summary figures only', async () => {
      const panel = await ok(c.admin.request('GET', '/admin/analytics?panel=resources'));
      const row = panel.data.finance.find((g: { currency: string }) => g.currency === 'MYR');
      assert.equal(row.totalBudget, TOTALS.budget);
      assert.equal(row.totalSpent, TOTALS.spent);
      // "Not in totals" is a per-project, per-currency summary figure (spec 3.5, 7.3; the measure definition names it), so
      // here it equals the one foreign entry's amount. Every other entry-level value stays out.
      const project = row.projects.find((p: { name: string }) => p.name === 'Harbour works');
      assert.deepEqual(project.notInTotals, [{ currency: 'USD', amount: DETAIL.foreign }]);
      const { foreign: _summary, ...entryDetail } = DETAIL;
      const notes = { own: OWN_NOTES, bNotes: HIDDEN_B.notes, cNotes: HIDDEN_C.notes, bQuantity: HIDDEN_B.quantity, cQuantity: HIDDEN_C.quantity };
      assertAbsent(json(panel), entryDetail, 'the resources panel');
      assertAbsent(json(panel), notes, 'the resources panel');
      for (const table of ['lines', 'sharedItems', 'finance']) {
        const csv = await raw('admin', `/admin/analytics/export?panel=resources&table=${table}`);
        if (table !== 'finance') assert.ok(!csv.includes(DETAIL.foreign), `the ${table} CSV carries the not-in-totals figure`);
        assertAbsent(csv, entryDetail, `the ${table} CSV`);
        assertAbsent(csv, notes, `the ${table} CSV`);
      }
    });
  });
});
