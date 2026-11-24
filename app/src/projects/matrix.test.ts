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
    'project.stages': ['pm,owner,sponsor', 'draft,planned,active'],
    'note.import': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'extraction.run': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'proposal.edit': ['pm,owner,sponsor', 'draft,planned,active'],
    'meeting_date.set': ['pm,owner,sponsor', 'draft,planned,active'],
    'proposal.review': ['owner,sponsor', 'planned,active'],
    'project.archive': ['pm,owner,sponsor', 'closed'],
    'proposal.submit': ['participant', 'draft,planned,active'],
    'audience.change': ['pm,owner,sponsor', 'draft,planned,active'],
    'discussion.post': ['participant', 'draft,planned,active'],
    'analysis.request': ['participant', 'draft,planned,active'],
    'notes.submit': ['participant', 'draft,planned,active'],
    'meeting.restricted': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'minutes.publish': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'message.moderate': ['pm,deputy_pm', 'draft,planned,active'],
    'message.restore': ['pm,deputy_pm', 'draft,planned,active,deferred,closed'],
    'feedback.review': ['pm,deputy_pm', 'draft,planned,active,deferred,closed'],
    'assist.ask': ['participant', 'draft,planned,active'],
    'assist.share': ['participant', 'draft,planned,active'],
    'assist.review': ['pm,deputy_pm', 'draft,planned,active,deferred,closed'],
    'report.request': ['participant', 'draft,planned,active'],
    'report.manage': ['pm,deputy_pm', 'draft,planned,active'],
    'summary.request': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'summary.approve': ['pm,owner,sponsor', 'draft,planned,active'],
    'summary.review': ['pm,owner,sponsor', 'draft,planned,active,deferred,closed'],
    'source.delete': ['pm,owner,sponsor', 'draft,planned,active'],
    'source.restore': ['pm,owner,sponsor', 'draft,planned,active,deferred,closed'],
    'record.delete': ['owner,sponsor', 'draft,planned,active'],
    'record.restore': ['owner,sponsor', 'draft,planned,active,deferred,closed'],
    'record.delegate_deletion': ['owner,sponsor', 'draft,planned,active,deferred,closed'],
    'secret.report': ['participant', 'draft,planned,active,deferred,closed'],
    'quarantine.release': ['pm,owner,sponsor', 'draft,planned,active,deferred,closed'],
    'quarantine.copies': ['pm,deputy_pm', 'draft,planned,active,deferred,closed'],
    'ai.limits.manage': ['pm,owner,sponsor', 'draft,planned,active'],
    'ai.connections.manage': ['pm,owner,sponsor', 'draft,planned,active'],
    'outputs.settings': ['pm,owner,sponsor', 'draft,planned,active'],
    'ai.connections.view': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active,deferred,closed'],
    'ai.usage.view': ['pm,owner,sponsor', 'draft,planned,active,deferred,closed'],
    'output.submit': ['pm,deputy_pm,owner,sponsor,member', 'draft,planned,active'],
    'output.manage': ['pm,deputy_pm', 'draft,planned,active'],
    'output.approve_request': ['pm,deputy_pm', 'planned,active'],
    'output.audience': ['pm,owner,sponsor', 'draft,planned,active,deferred,closed'],
    'output.delete': ['pm,deputy_pm', 'draft,planned,active'],
    'output.restore': ['pm,deputy_pm', 'draft,planned,active,deferred,closed'],
    'resource.view': ['participant', 'draft,planned,active,deferred,closed'],
    'resource.edit': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'finance.record': ['pm,deputy_pm', 'draft,planned,active'],
    'finance.propose': ['pm,deputy_pm,owner,sponsor', 'draft,planned,active'],
    'finance.settings': ['pm,owner,sponsor', 'draft,planned,active'],
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

test('a grant allows reading, and asking the AI privately', async () => {
  const { GRANT_ACTIONS } = await import('./matrix');
  assert.deepEqual(GRANT_ACTIONS, ['project.view', 'note.view', 'assist.ask', 'secret.report', 'resource.view']);
});

test('AI assist actions: participants ask, share and request reports; leaders review; summaries for accountable roles', () => {
  const ok = (action: ProjectAction, role: ProjectRole, status: 'draft' | 'planned' | 'active' | 'deferred' | 'closed') => decide({ action, roles: [role], status }).allowed;
  // assist.ask
  assert.equal(ok('assist.ask', 'member', 'draft'), true);
  assert.equal(ok('assist.ask', 'member', 'active'), true);
  assert.equal(ok('assist.ask', 'pm', 'deferred'), false);
  assert.equal(ok('assist.ask', 'owner', 'closed'), false);
  // assist.share
  assert.equal(ok('assist.share', 'member', 'planned'), true);
  assert.equal(ok('assist.share', 'member', 'closed'), false);
  // assist.review: PM and Deputy, in every state (protective)
  assert.equal(ok('assist.review', 'pm', 'closed'), true);
  assert.equal(ok('assist.review', 'deputy_pm', 'deferred'), true);
  assert.equal(ok('assist.review', 'owner', 'active'), false);
  assert.equal(ok('assist.review', 'member', 'active'), false);
  // report.request and report.manage
  assert.equal(ok('report.request', 'member', 'active'), true);
  assert.equal(ok('report.request', 'pm', 'deferred'), false);
  assert.equal(ok('report.manage', 'deputy_pm', 'active'), true);
  assert.equal(ok('report.manage', 'sponsor', 'active'), false);
  assert.equal(ok('report.manage', 'pm', 'closed'), false);
  // summary.request: PM, Deputy, Owner, Sponsor
  assert.equal(ok('summary.request', 'deputy_pm', 'draft'), true);
  assert.equal(ok('summary.request', 'sponsor', 'active'), true);
  assert.equal(ok('summary.request', 'member', 'active'), false);
  assert.equal(ok('summary.request', 'owner', 'deferred'), false);
  // summary.approve: PM, Owner, Sponsor (not the Deputy)
  assert.equal(ok('summary.approve', 'owner', 'active'), true);
  assert.equal(ok('summary.approve', 'deputy_pm', 'active'), false);
  assert.equal(ok('summary.approve', 'pm', 'closed'), false);
  // summary.review: PM, Owner, Sponsor in every state
  assert.equal(ok('summary.review', 'sponsor', 'closed'), true);
  assert.equal(ok('summary.review', 'deputy_pm', 'active'), false);
  assert.equal(ok('summary.review', 'member', 'deferred'), false);
});

test('discussion actions: members post, leaders moderate, restore and feedback review work in every state', () => {
  assert.equal(decide({ action: 'discussion.post', roles: ['member'], status: 'active' }).allowed, true);
  assert.equal(decide({ action: 'discussion.post', roles: ['member'], status: 'deferred' }).allowed, false);
  assert.equal(decide({ action: 'discussion.post', roles: [], status: 'active' }).allowed, false);
  assert.equal(decide({ action: 'analysis.request', roles: ['member'], status: 'planned' }).allowed, true);
  assert.equal(decide({ action: 'notes.submit', roles: ['member'], status: 'closed' }).allowed, false);
  assert.equal(decide({ action: 'meeting.restricted', roles: ['member'], status: 'active' }).allowed, false);
  assert.equal(decide({ action: 'meeting.restricted', roles: ['sponsor'], status: 'active' }).allowed, true);
  assert.equal(decide({ action: 'minutes.publish', roles: ['deputy_pm'], status: 'draft' }).allowed, true);
  assert.equal(decide({ action: 'message.moderate', roles: ['owner'], status: 'active' }).allowed, false);
  assert.equal(decide({ action: 'message.moderate', roles: ['deputy_pm'], status: 'closed' }).allowed, false);
  assert.equal(decide({ action: 'message.restore', roles: ['pm'], status: 'closed' }).allowed, true);
  assert.equal(decide({ action: 'message.restore', roles: ['sponsor'], status: 'active' }).allowed, false);
  assert.equal(decide({ action: 'feedback.review', roles: ['deputy_pm'], status: 'deferred' }).allowed, true);
  assert.equal(decide({ action: 'feedback.review', roles: ['member'], status: 'active' }).allowed, false);
});
