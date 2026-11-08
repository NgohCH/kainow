import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TransitionRequest, checkTransition } from './lifecycle';
import { PROJECT_STATUSES } from './matrix';

const ok = { allowed: true };
const base = (over: Partial<TransitionRequest>): TransitionRequest => ({
  from: 'draft', to: 'planned', roles: [], isAdmin: false, reason: 'Because', outcome: null, stage: null,
  requiredAccepted: true, requiredActive: true, separationOk: true, ...over,
});

const ALLOWED: Array<[TransitionRequest['from'], TransitionRequest['to'], Partial<TransitionRequest>]> = [
  ['draft', 'planned', { roles: ['pm'], reason: null }],
  ['draft', 'active', { roles: ['pm'] }],
  ['planned', 'active', { roles: ['sponsor'], reason: null }],
  ['active', 'deferred', { roles: ['owner'] }],
  ['deferred', 'active', { isAdmin: true, stage: 'Execution' }],
  ['active', 'closed', { roles: ['owner'], outcome: 'delivered' }],
  ['deferred', 'closed', { roles: ['sponsor'], outcome: 'partially_delivered' }],
  ['planned', 'closed', { roles: ['owner'], outcome: 'abandoned' }],
  ['closed', 'active', { roles: ['sponsor'], stage: 'Review & Acceptance' }],
];

test('each of the nine transitions is allowed for its actor with its inputs', () => {
  for (const [from, to, over] of ALLOWED) assert.deepEqual(checkTransition(base({ from, to, ...over })), ok, `${from} → ${to}`);
});

test('every other status change is refused', () => {
  const allowed = new Set(ALLOWED.map(([f, t]) => `${f}>${t}`));
  for (const from of PROJECT_STATUSES) {
    for (const to of PROJECT_STATUSES) {
      if (allowed.has(`${from}>${to}`)) continue;
      const r = checkTransition(base({ from, to, roles: ['pm', 'owner'], isAdmin: true, outcome: 'abandoned', stage: 'Execution' }));
      assert.deepEqual(r, { allowed: false, reason: 'That status change is not allowed.' }, `${from} → ${to}`);
    }
  }
});

test('the wrong actor is refused with who may do it', () => {
  const cases: Array<[TransitionRequest, string]> = [
    [base({ from: 'draft', to: 'planned', roles: ['member'] }), 'Only the Project Manager, the Owner or a Sponsor can move the project to Planned.'],
    [base({ from: 'draft', to: 'active', roles: ['owner'] }), 'Only the Project Manager can fast-track the project to Active.'],
    [base({ from: 'active', to: 'deferred', roles: ['deputy_pm'] }), 'Only the Project Manager, the Owner or a Sponsor can defer the project.'],
    [base({ from: 'deferred', to: 'active', roles: ['member'], stage: 'Execution' }), 'Only an Enterprise Administrator, the Project Manager, the Owner or a Sponsor can resume the project.'],
    [base({ from: 'active', to: 'closed', roles: ['pm'], outcome: 'delivered' }), 'Only the Owner or a Sponsor can close the project.'],
    [base({ from: 'active', to: 'closed', isAdmin: true, outcome: 'delivered' }), 'Only the Owner or a Sponsor can close the project.'],
    [base({ from: 'closed', to: 'active', isAdmin: true, stage: 'Execution' }), 'Only the Owner or a Sponsor can reopen the project.'],
  ];
  for (const [req, reason] of cases) assert.deepEqual(checkTransition(req), { allowed: false, reason }, `${req.from} → ${req.to}`);
});

test('a small-team Project Manager who is also the Owner may close and reopen', () => {
  assert.deepEqual(checkTransition(base({ from: 'active', to: 'closed', roles: ['pm', 'owner'], outcome: 'abandoned' })), ok);
  assert.deepEqual(checkTransition(base({ from: 'closed', to: 'active', roles: ['pm', 'owner'], stage: 'Execution' })), ok);
});

test('missing inputs and unmet gates are refused with the reason', () => {
  const cases: Array<[TransitionRequest, string]> = [
    [base({ from: 'active', to: 'deferred', roles: ['pm'], reason: '  ' }), 'A reason is required.'],
    [base({ from: 'draft', to: 'active', roles: ['pm'], reason: null }), 'A reason is required.'],
    [base({ from: 'active', to: 'closed', roles: ['owner'] }), 'Choose a closure outcome.'],
    [base({ from: 'planned', to: 'closed', roles: ['owner'], outcome: 'delivered' }), 'A project closed from Planned can only be Abandoned.'],
    [base({ from: 'deferred', to: 'active', roles: ['pm'] }), 'Choose the stage to continue in.'],
    [base({ from: 'closed', to: 'active', roles: ['owner'], stage: 'Somewhere' }), 'Choose the stage to continue in.'],
    [base({ from: 'draft', to: 'planned', roles: ['pm'], requiredAccepted: false }), 'The required roles are not all accepted yet.'],
    [base({ from: 'planned', to: 'active', roles: ['pm'], requiredActive: false }), 'The required roles are not all active yet.'],
    [base({ from: 'draft', to: 'active', roles: ['pm'], requiredActive: false }), 'The required roles are not all active yet.'],
    [base({ from: 'closed', to: 'active', roles: ['owner'], stage: 'Execution', separationOk: false }), 'With seven or more people, the Project Manager, Owner and Sponsors must be different people.'],
  ];
  for (const [req, reason] of cases) assert.deepEqual(checkTransition(req), { allowed: false, reason }, reason);
});

test('moving to Planned needs accepted roles, not active ones; deferring and closing need neither', () => {
  assert.deepEqual(checkTransition(base({ from: 'draft', to: 'planned', roles: ['pm'], requiredActive: false })), ok);
  assert.deepEqual(checkTransition(base({ from: 'active', to: 'deferred', roles: ['pm'], requiredAccepted: false, requiredActive: false })), ok);
  assert.deepEqual(checkTransition(base({ from: 'active', to: 'closed', roles: ['owner'], outcome: 'abandoned', requiredActive: false })), ok);
});
