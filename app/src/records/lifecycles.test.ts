import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectRole } from '../projects/membership';
import { questionTransition, riskTransition } from './lifecycles';

const q = (over: Partial<Parameters<typeof questionTransition>[0]>) =>
  questionTransition({ action: 'answer', status: 'open', actor: { isRequester: false, roles: ['member'] as ProjectRole[], active: true }, projectStatus: 'active', note: 'n', ...over });

test('questions: answering does not resolve', () => {
  assert.deepEqual(q({}), { allowed: true, to: 'answered' });
  assert.deepEqual(q({ status: 'answered' }), { allowed: true, to: 'answered' });
  assert.equal(q({ actor: { isRequester: false, roles: ['member'], active: false } }).allowed, false, 'an answer needs an Active membership');
  assert.deepEqual(q({ action: 'resolve', status: 'open', actor: { isRequester: true, roles: [], active: true } }), {
    allowed: false,
    reason: 'Answered is not Resolved: the requester, Project Manager or a Deputy confirms the answer.',
  });
  assert.deepEqual(q({ action: 'resolve', status: 'answered', actor: { isRequester: true, roles: [], active: true } }), { allowed: true, to: 'resolved' });
  assert.equal(q({ action: 'resolve', status: 'answered' }).allowed, false, 'a member who is not the requester');
  assert.deepEqual(q({ action: 'reopen', status: 'resolved', actor: { isRequester: false, roles: ['deputy_pm'], active: true } }), { allowed: true, to: 'open' });
  assert.deepEqual(q({ action: 'withdraw', status: 'answered', actor: { isRequester: false, roles: ['pm'], active: true } }), { allowed: true, to: 'withdrawn' });
  assert.equal(q({ action: 'withdraw', status: 'open', actor: { isRequester: false, roles: ['deputy_pm'], active: true } }).allowed, false, 'a Deputy does not withdraw');
  assert.equal(q({ action: 'reopen', status: 'withdrawn', actor: { isRequester: true, roles: [], active: true } }).allowed, false, 'withdrawn is final');
  assert.equal(q({ projectStatus: 'deferred' }).allowed, false);
  assert.equal(q({ note: '' }).allowed, false, 'an answer needs text');
});

const r = (over: Partial<Parameters<typeof riskTransition>[0]>) =>
  riskTransition({
    action: 'mitigate', status: 'open', actor: { isResponsible: false, roles: ['pm'] as ProjectRole[] }, projectStatus: 'active', note: 'n', responsibleSet: true, reviewOnSet: true, ...over,
  });

test('risks: mitigation, acceptance, resolution and reopening', () => {
  assert.deepEqual(r({}), { allowed: true, to: 'mitigating' });
  assert.equal(r({ actor: { isResponsible: false, roles: ['member'] } }).allowed, false);
  assert.deepEqual(r({ actor: { isResponsible: true, roles: ['member'] } }), { allowed: true, to: 'mitigating' });
  assert.deepEqual(r({ action: 'update', status: 'mitigating' }), { allowed: true, to: 'mitigating' });
  assert.equal(r({ action: 'accept', status: 'mitigating' }).allowed, false, 'the PM does not accept exposure');
  assert.deepEqual(r({ action: 'accept', status: 'mitigating', actor: { isResponsible: false, roles: ['owner'] }, reviewOnSet: false }), {
    allowed: false,
    reason: 'Accepting a risk needs a responsible person and a review date.',
  });
  assert.deepEqual(r({ action: 'accept', status: 'open', actor: { isResponsible: false, roles: ['sponsor'] } }), { allowed: true, to: 'accepted' });
  assert.deepEqual(r({ action: 'resolve', status: 'accepted', actor: { isResponsible: false, roles: ['owner'] } }), { allowed: true, to: 'resolved' });
  assert.equal(r({ action: 'reopen', status: 'accepted' }).allowed, false, 'reversing acceptance needs the Owner or a Sponsor');
  assert.deepEqual(r({ action: 'reopen', status: 'accepted', actor: { isResponsible: false, roles: ['owner'] } }), { allowed: true, to: 'open' });
  assert.deepEqual(r({ action: 'reopen', status: 'resolved' }), { allowed: true, to: 'open' });
  assert.equal(r({ note: ' ' }).allowed, false);
  assert.equal(r({ projectStatus: 'closed' }).allowed, false);
});
