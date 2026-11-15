import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EffectiveAnalysisSettings } from './settings.service';
import { type Readiness, type ThreadFacts, analysisState, explanation, statusLine } from './state';

const MIN = 60_000;
// 2026-11-11 02:00 UTC = 10:00 in UTC+8.
const NOW = new Date(Date.UTC(2026, 10, 11, 2, 0, 0));
const ago = (m: number) => new Date(NOW.getTime() - m * MIN);
const settings = (o: Partial<EffectiveAnalysisSettings> = {}): EffectiveAnalysisSettings => ({
  automatic: true, quietMinutes: 5, projectsMayChange: false, source: { automatic: 'organisation', quietMinutes: 'organisation' }, ...o,
});
const ready: Readiness = { spendApproved: true, allowanceLeft: true };
const facts = (o: Partial<ThreadFacts> = {}): ThreadFacts => ({
  kind: 'discussion', projectStatus: 'active', meetingState: null, newestVisibleAt: ago(6), unanalysedCount: 3, activeRun: null,
  recentAutoStarts: [], hasHumanDraft: false, lastAnalysedAt: ago(60), lastFailure: null, lastAutoFailedAt: null, finalDraftRequested: false, ...o,
});
const run = (f: Partial<ThreadFacts> = {}, s = settings(), r = ready) => analysisState(facts(f), s, r, NOW);

describe('analysisState', () => {
  test('an active run shows Queued or Running and is never due', () => {
    assert.deepEqual(run({ activeRun: 'queued' }), { status: { state: 'queued' }, due: false });
    assert.deepEqual(run({ activeRun: 'running', projectStatus: 'deferred' }), { status: { state: 'running' }, due: false });
  });
  test('a Deferred or Closed project is paused', () => {
    assert.deepEqual(run({ projectStatus: 'deferred' }).status, { state: 'paused', reason: 'The project is Deferred.' });
    assert.deepEqual(run({ projectStatus: 'closed' }).status, { state: 'paused', reason: 'The project is Closed.' });
    assert.equal(run({ projectStatus: 'deferred' }).due, false);
  });
  test('nothing unanalysed is up to date', () => {
    const r = run({ unanalysedCount: 0 });
    assert.deepEqual(r, { status: { state: 'up_to_date', lastAnalysedAt: ago(60) }, due: false });
  });
  test('an ended meeting with unanalysed messages is never up to date', () => {
    const ended = { kind: 'meeting' as const, meetingState: 'ended' as const };
    const first = run(ended);
    assert.deepEqual([first.due, first.trigger], [true, 'meeting_end'], 'its final draft is due once');
    assert.equal(run({ ...ended, unanalysedCount: 0 }).status.state, 'up_to_date');
    assert.equal(run({ ...ended, finalDraftRequested: true }).status.state, 'paused');
    assert.equal(run({ ...ended, finalDraftRequested: true }).due, false);
    assert.equal(run({ ...ended, hasHumanDraft: true }).status.state, 'paused');
    assert.equal(run(ended, settings({ automatic: false })).status.state, 'paused');
    assert.equal(run(ended, settings(), { spendApproved: true, allowanceLeft: false }).status.state, 'blocked');
  });
  test('automatic analysis off is paused', () => {
    const r = run({}, settings({ automatic: false }));
    assert.deepEqual(r, { status: { state: 'paused', reason: 'Automatic analysis is off for this project.' }, due: false });
  });
  test('a meeting with a human draft is paused', () => {
    const r = run({ kind: 'meeting', meetingState: 'open', hasHumanDraft: true });
    assert.deepEqual(r.status, { state: 'paused', reason: 'Automatic minutes paused: edited by a person.' });
    assert.equal(run({ kind: 'discussion', hasHumanDraft: true }).due, true, 'a human draft matters only for meetings');
  });
  test('quiet period not elapsed waits until newest + quiet', () => {
    const r = run({ newestVisibleAt: ago(2) });
    assert.deepEqual(r, { status: { state: 'waiting', at: new Date(NOW.getTime() + 3 * MIN), reason: 'quiet' }, due: false });
  });
  test('quiet period of 10 minutes waits until newest + 10', () => {
    const newest = ago(6);
    const r = run({ newestVisibleAt: newest }, settings({ quietMinutes: 10 }));
    assert.deepEqual(r.status, { state: 'waiting', at: new Date(newest.getTime() + 10 * MIN), reason: 'quiet' });
    assert.equal(r.due, false);
  });
  test('two starts in the last 20 minutes wait for the limit', () => {
    const r = run({ recentAutoStarts: [ago(15), ago(4)] });
    assert.deepEqual(r, { status: { state: 'waiting', at: new Date(ago(15).getTime() + 20 * MIN), reason: 'limit' }, due: false });
  });
  test('limit counts only quiet_period starts in the last 20 minutes', () => {
    // Facts carry quiet_period starts only; older ones are outside the window and ignored.
    assert.equal(run({ recentAutoStarts: [ago(25), ago(4)] }).due, true);
    assert.equal(run({ recentAutoStarts: [ago(20), ago(4)] }).due, true, 'exactly 20 minutes ago has left the window');
    assert.equal(run({ recentAutoStarts: [ago(19), ago(4)] }).due, false);
    // With three in the window the limit lifts when the second-newest leaves it.
    const r = run({ recentAutoStarts: [ago(18), ago(10), ago(2)] });
    assert.deepEqual(r.status, { state: 'waiting', at: new Date(ago(10).getTime() + 20 * MIN), reason: 'limit' });
  });
  test('a failed or blocked automatic run is not repeated until a newer message (R22)', () => {
    const paused = run({ newestVisibleAt: ago(8), lastAutoFailedAt: ago(7) });
    assert.equal(paused.status.state, 'paused');
    assert.equal(paused.due, false);
    assert.equal(run({ newestVisibleAt: ago(7), lastAutoFailedAt: ago(7) }).due, false, 'a message at the same instant is not newer');
    assert.equal(run({ newestVisibleAt: ago(6), lastAutoFailedAt: ago(8) }).due, true, 'a message written after the run');
    // It sits just before the quiet-period rule, so the quiet period is not shown for it.
    assert.equal(run({ newestVisibleAt: ago(3), lastAutoFailedAt: ago(2) }).due, false);
    assert.equal(run({ newestVisibleAt: ago(1), lastAutoFailedAt: ago(3) }).status.state, 'waiting');
    assert.equal(run({ unanalysedCount: 0, lastAutoFailedAt: ago(2) }).status.state, 'up_to_date');
  });
  test('spend not approved is blocked', () => {
    const r = run({}, settings(), { spendApproved: false, allowanceLeft: false });
    assert.deepEqual(r, { status: { state: 'blocked', reason: 'The AI spend settings have not been approved yet.' }, due: false });
  });
  test('no allowance is blocked', () => {
    const r = run({}, settings(), { spendApproved: true, allowanceLeft: false });
    assert.deepEqual(r, { status: { state: 'blocked', reason: 'There is no AI allowance left.' }, due: false });
  });
  test('otherwise it is due', () => {
    assert.deepEqual(run(), { status: { state: 'waiting', at: NOW, reason: 'quiet' }, due: true, trigger: 'quiet_period' });
    assert.equal(run({ kind: 'meeting', meetingState: 'open' }).due, true);
  });
});

test('explanation reads the effective values', () => {
  assert.equal(explanation(settings()), 'Automatic analysis: after 5 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.');
  assert.equal(explanation(settings({ quietMinutes: 12 })), 'Automatic analysis: after 12 minutes without new messages; maximum 2 analyses per thread in any rolling 20 minutes.');
  assert.equal(explanation(settings({ automatic: false })), 'Automatic analysis is off for this project.');
});

test('statusLine uses UTC+8', () => {
  assert.equal(statusLine({ state: 'up_to_date', lastAnalysedAt: ago(0) }), 'Up to date — last analysed 10:00');
  assert.equal(statusLine({ state: 'waiting', at: new Date(Date.UTC(2026, 10, 11, 16, 42)), reason: 'quiet' }), 'Analysis at 00:42 if no new messages');
  assert.equal(statusLine({ state: 'waiting', at: new Date(Date.UTC(2026, 10, 11, 2, 55)), reason: 'limit' }), 'Limit reached — next eligible 10:55');
  assert.equal(statusLine({ state: 'queued' }), 'Queued');
  assert.equal(statusLine({ state: 'running' }), 'Running');
  assert.equal(statusLine({ state: 'paused', reason: 'The project is Closed.' }), 'Paused — The project is Closed.');
  assert.equal(statusLine({ state: 'blocked', reason: 'There is no AI allowance left.' }), 'Blocked — There is no AI allowance left.');
});
