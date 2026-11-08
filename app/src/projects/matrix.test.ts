import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectRole } from './membership';
import { PROJECT_MATRIX, PROJECT_STATUSES, type ProjectAction, ROLE_MANAGERS, canManageRole, decide } from './matrix';

const ROLES: ProjectRole[] = ['pm', 'deputy_pm', 'owner', 'sponsor', 'member'];

test('the matrix holds exactly the agreed rows', () => {
  const rows = Object.fromEntries(Object.entries(PROJECT_MATRIX).map(([a, r]) => [a, [r.roles.join(','), r.states.join(',')]]));
  assert.deepEqual(rows, {
    'project.view': ['participant', 'draft,planned,active,deferred,closed'],
    'note.view': ['participant', 'draft,planned,active,deferred,closed'],
    'project.edit': ['pm,owner,sponsor', 'draft,planned,active'],
    'project.stage': ['pm', 'active'],
    'note.import': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'extraction.run': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'proposal.edit': ['pm,owner,sponsor', 'draft,planned,active'],
    'meeting_date.set': ['pm,owner,sponsor', 'draft,planned,active'],
    'proposal.review': ['owner,sponsor', 'planned,active'],
  });
  assert.equal(PROJECT_MATRIX['proposal.review'].refusal, 'Only the Owner or a Sponsor can approve or reject proposals, and only while the project is Planned or Active.');
});

test('decide allows exactly the listed roles in the listed states, for every action, role and state', () => {
  for (const action of Object.keys(PROJECT_MATRIX) as ProjectAction[]) {
    const row = PROJECT_MATRIX[action];
    for (const status of PROJECT_STATUSES) {
      for (const role of ROLES) {
        const expected = (row.roles.includes('participant') || row.roles.includes(role)) && row.states.includes(status);
        const got = decide({ action, roles: [role], status });
        assert.equal(got.allowed, expected, `${action} ${role} ${status}`);
        if (!got.allowed) assert.equal(got.reason, row.refusal);
      }
      const none = decide({ action, roles: [], status });
      assert.equal(none.allowed, false, `${action} with no roles ${status}`);
    }
  }
});

test('combined roles give the permissions of each', () => {
  assert.equal(decide({ action: 'proposal.review', roles: ['pm', 'owner'], status: 'active' }).allowed, true);
  assert.equal(decide({ action: 'proposal.review', roles: ['pm', 'deputy_pm', 'member'], status: 'active' }).allowed, false);
});

test('role managers follow the accepted matrix for every target, manager and state', () => {
  assert.deepEqual(ROLE_MANAGERS, {
    owner: ['administrator'],
    sponsor: ['administrator', 'owner'],
    pm: ['administrator', 'owner', 'sponsor'],
    deputy_pm: ['pm', 'owner', 'sponsor'],
    member: ['pm', 'owner', 'sponsor'],
  });
  for (const target of ROLES) {
    for (const status of PROJECT_STATUSES) {
      const open = ['draft', 'planned', 'active'].includes(status);
      for (const via of ['appointment', 'invitation'] as const) {
        // Appointments may be repaired in every status; invitations are locked while Deferred or Closed.
        const stateOk = via === 'appointment' || open;
        for (const role of ROLES) {
          const expected: boolean = stateOk && (ROLE_MANAGERS[target] as readonly string[]).includes(role);
          assert.equal(canManageRole({ target, roles: [role], isAdmin: false, status, via }).allowed, expected, `${role} manages ${target} by ${via} in ${status}`);
        }
        const admin = canManageRole({ target, roles: [], isAdmin: true, status, via });
        assert.equal(admin.allowed, stateOk && ROLE_MANAGERS[target].includes('administrator'), `admin manages ${target} by ${via} in ${status}`);
      }
    }
  }
  const refused = canManageRole({ target: 'owner', roles: ['pm', 'sponsor'], isAdmin: false, status: 'active', via: 'appointment' });
  assert.deepEqual(refused, { allowed: false, reason: 'Only an Enterprise Administrator can manage the Owner role.' });
  const member = canManageRole({ target: 'member', roles: ['deputy_pm'], isAdmin: true, status: 'draft', via: 'invitation' });
  assert.deepEqual(member, { allowed: false, reason: 'Only the Project Manager, the Owner or a Sponsor can invite for the Member role, and not while the project is Deferred or Closed.' });
  const locked = canManageRole({ target: 'member', roles: ['pm'], isAdmin: false, status: 'deferred', via: 'invitation' });
  assert.deepEqual(locked, { allowed: false, reason: 'Only the Project Manager, the Owner or a Sponsor can invite for the Member role, and not while the project is Deferred or Closed.' });
});
