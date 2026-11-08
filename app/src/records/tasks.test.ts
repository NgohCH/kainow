import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectStatus } from '../projects/matrix';
import type { ProjectRole } from '../projects/membership';
import { todayUtc8 } from '../projects/membership';
import { type TaskAction, type TaskStatus, ancestorsToReopen, parentMayComplete, taskIndicators, taskTransition } from './tasks';

const STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'completed', 'cancelled'];
const ACTIONS: TaskAction[] = ['start', 'block', 'unblock', 'complete', 'reopen'];
const PROJECT: ProjectStatus[] = ['draft', 'planned', 'active', 'deferred', 'closed'];
const ACTORS: Array<[string, { isAssignee: boolean; roles: ProjectRole[] }]> = [
  ['assignee', { isAssignee: true, roles: ['member'] }],
  ['pm', { isAssignee: false, roles: ['pm'] }],
  ['deputy', { isAssignee: false, roles: ['deputy_pm'] }],
  ['owner', { isAssignee: false, roles: ['owner'] }],
  ['member', { isAssignee: false, roles: ['member'] }],
];
const FROM: Record<TaskAction, TaskStatus[]> = {
  start: ['not_started'],
  block: ['not_started', 'in_progress'],
  unblock: ['blocked'],
  complete: ['not_started', 'in_progress', 'blocked'],
  reopen: ['completed'],
};
const TO: Record<TaskAction, TaskStatus> = { start: 'in_progress', block: 'blocked', unblock: 'in_progress', complete: 'completed', reopen: 'in_progress' };

test('the task table: every action, state, actor and project status', () => {
  for (const action of ACTIONS) {
    for (const status of STATUSES) {
      for (const [name, actor] of ACTORS) {
        for (const projectStatus of PROJECT) {
          const mayAct = action === 'reopen' ? name === 'pm' || name === 'deputy' : ['assignee', 'pm', 'deputy'].includes(name);
          const expected = projectStatus === 'active' && mayAct && FROM[action].includes(status);
          const got = taskTransition({ action, status, actor, projectStatus, assigneeActive: true, note: 'n' });
          assert.equal(got.allowed, expected, `${action} ${status} ${name} ${projectStatus}`);
          if (got.allowed) assert.equal(got.to, TO[action]);
        }
      }
    }
  }
});

test('refusals say why', () => {
  const base = { status: 'not_started' as TaskStatus, projectStatus: 'active' as ProjectStatus, assigneeActive: true, note: 'n' };
  const pm = { isAssignee: false, roles: ['pm'] as ProjectRole[] };
  assert.deepEqual(taskTransition({ ...base, action: 'start', actor: pm, projectStatus: 'planned' }), { allowed: false, reason: 'Tasks change only while the project is Active.' });
  assert.deepEqual(taskTransition({ ...base, action: 'start', actor: { isAssignee: false, roles: ['member'] } }), { allowed: false, reason: 'Only the assignee, the Project Manager or a Deputy can do this.' });
  assert.deepEqual(taskTransition({ ...base, action: 'reopen', status: 'completed', actor: { isAssignee: true, roles: ['member'] } }), { allowed: false, reason: 'Only the Project Manager or a Deputy can reopen a task.' });
  assert.deepEqual(taskTransition({ ...base, action: 'start', actor: pm, assigneeActive: false }), { allowed: false, reason: 'The assignee must be an Active member to start this task.' });
  assert.deepEqual(taskTransition({ ...base, action: 'block', actor: pm, note: ' ' }), { allowed: false, reason: 'A note is required.' });
  assert.deepEqual(taskTransition({ ...base, action: 'unblock', actor: pm }), { allowed: false, reason: 'That change is not possible from Not Started.' });
  // Completion: the PM or a Deputy may record it for an assignee who is not Active; the assignee cannot.
  assert.equal(taskTransition({ ...base, action: 'complete', actor: pm, assigneeActive: false }).allowed, true);
  assert.equal(taskTransition({ ...base, action: 'complete', actor: { isAssignee: true, roles: [] }, assigneeActive: false }).allowed, false);
});

test('parent completion', () => {
  assert.deepEqual(parentMayComplete(['completed', 'cancelled'], null, ['member']), { allowed: true, override: false });
  assert.deepEqual(parentMayComplete(['completed', 'in_progress'], null, ['pm']), { allowed: false, reason: 'Finish the subtasks first, or record an override.' });
  assert.deepEqual(parentMayComplete(['in_progress'], 'Handled outside Kainow', ['pm']), { allowed: true, override: true });
  assert.deepEqual(parentMayComplete(['in_progress'], 'x', ['deputy_pm']), { allowed: true, override: true });
  assert.equal(parentMayComplete(['in_progress'], 'x', ['owner']).allowed, false, 'only the PM or a Deputy overrides');
  assert.equal(parentMayComplete(['in_progress'], '  ', ['pm']).allowed, false);
});

test('reopening reaches completed ancestors only', () => {
  assert.deepEqual(ancestorsToReopen([{ id: 'p', status: 'completed' }, { id: 'g', status: 'completed' }]), ['p', 'g']);
  assert.deepEqual(ancestorsToReopen([{ id: 'p', status: 'in_progress' }, { id: 'g', status: 'completed' }]), []);
  assert.deepEqual(ancestorsToReopen([{ id: 'p', status: 'completed' }, { id: 'g', status: 'in_progress' }]), ['p']);
  assert.deepEqual(ancestorsToReopen([]), []);
});

test('indicators, with Overdue at the UTC+8 boundary', () => {
  const base = { status: 'in_progress' as TaskStatus, dueOn: '2026-11-09', parentDueOn: null, assigneeActive: true, invitationStatus: null };
  assert.equal(taskIndicators({ ...base, today: todayUtc8(new Date('2026-11-09T15:59:59Z')) }).overdue, false);
  assert.equal(taskIndicators({ ...base, today: todayUtc8(new Date('2026-11-09T16:00:00Z')) }).overdue, true);
  assert.equal(taskIndicators({ ...base, status: 'completed', today: '2026-12-01' }).overdue, false);
  assert.deepEqual(taskIndicators({ ...base, assigneeActive: false, invitationStatus: 'invited', today: '2026-11-01' }), {
    overdue: false, awaitingMembership: true, invitation: 'invited', dueAfterParent: false,
  });
  assert.equal(taskIndicators({ ...base, parentDueOn: '2026-11-05', today: '2026-11-01' }).dueAfterParent, true);
});
