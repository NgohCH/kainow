import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProjectRole } from '../projects/membership';
import { type Holder, applyCover, routeFor } from './recipients';

const h = (userId: string, ...roles: ProjectRole[]): Holder => ({ userId, roles });
const admins = ['admin1', 'admin2'];

describe('routeFor', () => {
  const holders = [h('pm', 'pm'), h('own', 'owner'), h('sp', 'sponsor'), h('dep', 'deputy_pm'), h('mem', 'member')];
  const ctx = (assigneeId: string | null, extra: object = {}) => ({ holders, assigneeId, admins, ...extra });

  test('reminder goes to the assignee when a holder', () => {
    assert.deepEqual(routeFor('reminder', ctx('mem')).to, ['mem']);
    assert.deepEqual(routeFor('reminder', ctx('gone')).to, []);
  });
  test('overdue Member and Deputy go to the PM', () => {
    assert.deepEqual(routeFor('overdue', ctx('mem')), { to: ['pm'], noIndependent: false, minimal: false });
    assert.deepEqual(routeFor('overdue', ctx('dep')).to, ['pm']);
  });
  test('overdue PM goes to every Owner and Sponsor', () => {
    assert.deepEqual(routeFor('overdue', ctx('pm')).to, ['own', 'sp']);
  });
  test('overdue Owner goes to other Sponsors and the PM', () => {
    assert.deepEqual(routeFor('overdue', ctx('own')).to, ['pm', 'sp']);
  });
  test('Owner who is the only Sponsor and the PM has no independent recipient', () => {
    const solo = [h('x', 'owner', 'pm', 'sponsor'), h('mem', 'member')];
    assert.deepEqual(routeFor('overdue', { holders: solo, assigneeId: 'x', admins }), { to: [], noIndependent: true, minimal: false });
  });
  test('person holding several routed roles appears once', () => {
    const two = [h('a', 'pm', 'owner'), h('mem', 'member')];
    assert.deepEqual(routeFor('overdue', { holders: two, assigneeId: 'mem', admins }).to, ['a']);
  });
  test('assignee with several roles uses the most senior', () => {
    const hs = [h('pm', 'pm'), h('own', 'owner'), h('z', 'member', 'owner')];
    assert.deepEqual(routeFor('overdue', { holders: hs, assigneeId: 'z', admins }).to, ['own', 'pm']);
  });
  test('parent deadline goes to the PM, or to O/S when the PM is the assignee', () => {
    assert.deepEqual(routeFor('parent_deadline', ctx('mem')).to, ['pm']);
    assert.deepEqual(routeFor('parent_deadline', ctx('pm')).to, ['own', 'sp']);
  });
  test('PM who is also the only Owner and assignee: parent deadline has no independent recipient', () => {
    const hs = [h('pm', 'pm', 'owner'), h('mem', 'member')];
    assert.deepEqual(routeFor('parent_deadline', { holders: hs, assigneeId: 'pm', admins }), { to: [], noIndependent: true, minimal: false });
  });
  test('past_due_set goes to assignee and PM', () => {
    assert.deepEqual(routeFor('past_due_set', ctx('mem')).to, ['mem', 'pm']);
    assert.deepEqual(routeFor('past_due_set', ctx('pm')).to, ['pm']);
  });
  test('risk with no responsible goes to the PM only', () => {
    assert.deepEqual(routeFor('risk_review_due', ctx(null, { responsibleId: null })).to, ['pm']);
    assert.deepEqual(routeFor('risk_review_missed', ctx(null, { responsibleId: 'gone' })).to, ['pm']);
    assert.deepEqual(routeFor('risk_review_due', ctx(null, { responsibleId: 'mem' })).to, ['mem', 'pm']);
  });
  test('unavailable assignee: PM, else O/S, else admins minimal', () => {
    assert.deepEqual(routeFor('assignee_unavailable', ctx('gone')), { to: ['pm'], noIndependent: false, minimal: false });
    const noPm = [h('own', 'owner'), h('sp', 'sponsor')];
    assert.deepEqual(routeFor('assignee_unavailable', { holders: noPm, assigneeId: 'gone', admins }).to, ['own', 'sp']);
    assert.deepEqual(routeFor('assignee_unavailable', { holders: [h('m', 'member')], assigneeId: 'gone', admins }), { to: admins, noIndependent: false, minimal: true });
  });
  test('resumption goes to the PM', () => {
    assert.deepEqual(routeFor('resumption', ctx(null)).to, ['pm']);
  });
  test('kinds with nobody return empty without noIndependent', () => {
    const r = routeFor('past_due_set', { holders: [], assigneeId: 'x', admins });
    assert.deepEqual(r, { to: [], noIndependent: false, minimal: false });
  });
});

describe('applyCover', () => {
  const holders = [h('pm', 'pm'), h('own', 'owner'), h('sp', 'sponsor'), h('mem', 'member')];
  test('PM away on a Member escalation adds every O/S', () => {
    const r = applyCover('overdue', { to: ['pm'] }, { holders, assigneeId: 'mem', unreachable: new Set(['pm']) });
    assert.deepEqual(r, { to: ['own', 'pm', 'sp'], covering: ['own', 'sp'] });
  });
  test('PM away and every O/S away adds nobody', () => {
    const r = applyCover('overdue', { to: ['pm'] }, { holders, assigneeId: 'mem', unreachable: new Set(['pm', 'own', 'sp']) });
    assert.deepEqual(r, { to: ['pm'], covering: [] });
  });
  test('Owner task with PM away: Sponsors keep it and the Owner is never added', () => {
    const r = applyCover('overdue', { to: ['pm', 'sp'] }, { holders, assigneeId: 'own', unreachable: new Set(['pm']) });
    assert.deepEqual(r, { to: ['pm', 'sp'], covering: [] });
    const r2 = applyCover('overdue', { to: ['pm', 'sp'] }, { holders, assigneeId: 'own', unreachable: new Set(['pm', 'sp']) });
    assert.deepEqual(r2.covering, []);
    assert.ok(!r2.to.includes('own'));
  });
  test('Sponsor away is covered by the PM, not the assignee', () => {
    const r = applyCover('overdue', { to: ['sp'] }, { holders, assigneeId: 'own', unreachable: new Set(['sp']) });
    assert.deepEqual(r, { to: ['pm', 'sp'], covering: ['pm'] });
  });
  test('reminders and other kinds get no cover', () => {
    const r = applyCover('reminder', { to: ['mem'] }, { holders, assigneeId: 'mem', unreachable: new Set(['mem']) });
    assert.deepEqual(r, { to: ['mem'], covering: [] });
    assert.deepEqual(applyCover('past_due_set', { to: ['pm'] }, { holders, assigneeId: 'mem', unreachable: new Set(['pm']) }).covering, []);
  });
  test('minimal admin fallback has no cover', () => {
    const r = applyCover('assignee_unavailable', { to: ['admin1'], minimal: true }, { holders, assigneeId: 'x', unreachable: new Set(['admin1']) });
    assert.deepEqual(r, { to: ['admin1'], covering: [] });
  });
  test('parent deadline and unavailable alert are covered', () => {
    const un = { holders, assigneeId: 'mem', unreachable: new Set(['pm']) };
    assert.deepEqual(applyCover('parent_deadline', { to: ['pm'] }, un).covering, ['own', 'sp']);
    assert.deepEqual(applyCover('assignee_unavailable', { to: ['pm'] }, un).covering, ['own', 'sp']);
  });
});
