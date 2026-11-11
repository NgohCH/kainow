import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MembershipRecord, ProjectContext } from '../projects/access.service';
import { type GrantRow, grantGivesAccess } from '../projects/grants';
import { type ProjectRole, effectiveRoles } from '../projects/membership';
import { type AudienceRow, inAudience, parseAudienceChange } from './audience';

const TODAY = '2026-11-11';
const PROJECT = '00000000-0000-4000-8000-0000000000aa';

const row = (userId: string, role: ProjectRole, extra: Partial<MembershipRecord> = {}): MembershipRecord => ({
  id: `m-${userId}-${role}`, userId, role, startsOn: '2026-11-01', expiresOn: null, revokedAt: null, displayName: userId, email: `${userId}@example.org`, ...extra,
});

function ctxFor(viewerId: string, rows: MembershipRecord[], opts: { grants?: GrantRow[]; isAdmin?: boolean } = {}): ProjectContext {
  const grants = opts.grants ?? [];
  return {
    project: { id: PROJECT, status: 'active', createdOn: '2026-11-01' },
    roles: effectiveRoles(rows, viewerId, TODAY),
    isAdmin: opts.isAdmin ?? false,
    rows,
    today: TODAY,
    missingAccountability: false,
    missingRoles: [],
    onHold: false,
    grants,
    grantKinds: [...new Set(grants.filter((g) => g.userId === viewerId && grantGivesAccess(g, TODAY, rows)).map((g) => g.kind))],
    viewerId,
  };
}

const project: AudienceRow = { id: 'a1', projectId: PROJECT, mode: 'project', namedUserIds: [] };
const restricted = (named: string[] = []): AudienceRow => ({ id: 'a2', projectId: PROJECT, mode: 'restricted', namedUserIds: named });
const grant = (userId: string, extra: Partial<GrantRow> = {}): GrantRow => ({
  id: `g-${userId}`, userId, kind: 'audit', startsOn: '2026-11-01', expiresOn: '2026-11-30', requestedBy: 'x', decision: 'approved', suspendedAt: null, revokedAt: null, ...extra,
});

describe('inAudience', () => {
  test('project audience admits any reader', () => {
    assert.equal(inAudience(ctxFor('u', [row('u', 'member')]), project), true);
    assert.equal(inAudience(ctxFor('g', [row('u', 'member')], { grants: [grant('g')] }), project), true);
  });

  test('restricted admits PM, Deputy, Owner, Sponsor', () => {
    for (const role of ['pm', 'deputy_pm', 'owner', 'sponsor'] as const) {
      assert.equal(inAudience(ctxFor('u', [row('u', role)]), restricted()), true, role);
    }
  });

  test('restricted refuses a plain Member unless named', () => {
    const rows = [row('u', 'member')];
    assert.equal(inAudience(ctxFor('u', rows), restricted()), false);
    assert.equal(inAudience(ctxFor('u', rows), restricted(['u'])), true);
  });

  test('restricted admits a named grant holder with a valid grant', () => {
    const rows = [row('p', 'pm')];
    assert.equal(inAudience(ctxFor('g', rows, { grants: [grant('g')] }), restricted(['g'])), true);
    assert.equal(inAudience(ctxFor('g', rows, { grants: [grant('g')] }), restricted()), false);
    assert.equal(inAudience(ctxFor('g', rows, { grants: [grant('g', { expiresOn: '2026-11-10' })] }), restricted(['g'])), false);
    assert.equal(inAudience(ctxFor('g', rows, { grants: [grant('g', { suspendedAt: new Date() })] }), restricted(['g'])), false);
  });

  test('named person whose membership expired is refused', () => {
    const rows = [row('u', 'member', { expiresOn: '2026-11-10' })];
    assert.equal(inAudience(ctxFor('u', rows), restricted(['u'])), false);
    assert.equal(inAudience(ctxFor('u', rows), project), false);
  });

  test('Administrator with no role is refused', () => {
    const rows = [row('p', 'pm')];
    assert.equal(inAudience(ctxFor('adm', rows, { isAdmin: true }), project), false);
    assert.equal(inAudience(ctxFor('adm', rows, { isAdmin: true }), restricted(['adm'])), false);
  });
});

describe('inAudience across projects', () => {
  test('an audience from another project, or from none, is refused', () => {
    const ctx = ctxFor('u', [row('u', 'pm')]);
    assert.equal(inAudience(ctx, { ...project, projectId: '00000000-0000-4000-8000-0000000000bb' }), false);
    assert.equal(inAudience(ctx, { ...restricted(['u']), projectId: '00000000-0000-4000-8000-0000000000bb' }), false);
    assert.equal(inAudience(ctx, { ...project, projectId: null }), false);
    assert.equal(inAudience(ctx, { ...restricted(), projectId: null }), false);
  });
});

describe('parseAudienceChange', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  test('accepts project and restricted with named people', () => {
    assert.deepEqual(parseAudienceChange({ mode: 'project' }), { mode: 'project', namedUserIds: [] });
    assert.deepEqual(parseAudienceChange({ mode: 'restricted', namedUserIds: [id, id] }), { mode: 'restricted', namedUserIds: [id] });
  });
  test('refuses named people on a Project-wide audience, bad modes and bad ids', () => {
    assert.throws(() => parseAudienceChange({ mode: 'project', namedUserIds: [id] }));
    assert.throws(() => parseAudienceChange({ mode: 'secret' }));
    assert.throws(() => parseAudienceChange({ mode: 'restricted', namedUserIds: ['nope'] }));
    assert.throws(() => parseAudienceChange(null));
  });
});
