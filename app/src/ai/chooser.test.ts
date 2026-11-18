import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type CandidateConnection, NOTE_BAD_RESPONSE, NOTE_RATE_LIMITED, chooseConnection, isMoveOn } from './chooser';

const PRICES = { inputMicroUsdPerMillion: 1n, cachedInputMicroUsdPerMillion: 1n, cacheWriteMicroUsdPerMillion: 0n, outputMicroUsdPerMillion: 1n };
const c = (position: number, eligible: boolean): CandidateConnection => ({
  id: `c${position}`, position, provider: 'anthropic', modelId: 'm', modelRef: `r${position}`, prices: PRICES, eligible,
});
const moved = (connectionId: string) => ({ connectionId, moveOn: true });

describe('chooseConnection', () => {
  test('first attempt uses the first eligible', () => {
    assert.equal(chooseConnection([c(1, false), c(2, true), c(3, true)], null)?.id, 'c2');
  });
  test('no previous entry → first eligible', () => {
    assert.equal(chooseConnection([c(2, true), c(1, true)], null)?.id, 'c1');
  });
  test('outage moves to the next eligible and wraps', () => {
    const all = [c(1, true), c(2, false), c(3, true)];
    assert.equal(chooseConnection(all, moved('c1'))?.id, 'c3');
    assert.equal(chooseConnection(all, moved('c3'))?.id, 'c1');
  });
  test('previous no longer eligible → first eligible after its old position, wrapping', () => {
    const all = [c(1, true), c(2, false), c(3, true), c(4, true)];
    assert.equal(chooseConnection(all, moved('c2'))?.id, 'c3');
    assert.equal(chooseConnection([c(1, true), c(2, true), c(3, false)], moved('c3'))?.id, 'c1');
  });
  test('one eligible → always it', () => {
    const all = [c(1, false), c(2, true)];
    assert.equal(chooseConnection(all, moved('c2'))?.id, 'c2');
    assert.equal(chooseConnection(all, null)?.id, 'c2');
  });
  test('none eligible → null', () => {
    assert.equal(chooseConnection([c(1, false)], moved('c1')), null);
    assert.equal(chooseConnection([], null), null);
  });
  test('a previous that did not move on, or is unknown, gives the first eligible', () => {
    const all = [c(1, true), c(2, true)];
    assert.equal(chooseConnection(all, { connectionId: 'c2', moveOn: false })?.id, 'c1');
    assert.equal(chooseConnection(all, moved('gone'))?.id, 'c1');
  });
});

describe('isMoveOn', () => {
  test('uncertain, a 429 note or a bad response move on; others do not', () => {
    assert.equal(isMoveOn('uncertain', null), true);
    assert.equal(isMoveOn('confirmed', NOTE_BAD_RESPONSE), true);
    assert.equal(isMoveOn('released', NOTE_RATE_LIMITED), true);
    assert.equal(isMoveOn('confirmed', null), false);
    assert.equal(isMoveOn('released', 'never sent'), false);
  });
});
