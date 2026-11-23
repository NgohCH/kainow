import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, isNewer, parseTag, versionString } from './version';

test('parseTag accepts v1.2.3 and rejects 1.2.3, v1.2, v1.2.3-rc.1, v01.2.3', () => {
  assert.deepEqual(parseTag('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseTag('v0.0.0'), { major: 0, minor: 0, patch: 0 });
  for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3 ', ' v1.2.3', '', 'V1.2.3', 'v1.2.3\n']) {
    assert.equal(parseTag(bad), null, JSON.stringify(bad));
  }
});

test('compareVersions orders numerically', () => {
  const v = (s: string) => parseTag(s)!;
  assert.equal(compareVersions(v('v1.0.10'), v('v1.0.9')), 1);
  assert.equal(compareVersions(v('v1.0.9'), v('v1.0.10')), -1);
  assert.equal(compareVersions(v('v2.0.0'), v('v1.99.99')), 1);
  assert.equal(compareVersions(v('v1.2.0'), v('v1.10.0')), -1);
  assert.equal(compareVersions(v('v1.2.3'), v('v1.2.3')), 0);
});

test('versionString has no v', () => {
  assert.equal(versionString({ major: 1, minor: 2, patch: 3 }), '1.2.3');
});

test('isNewer compares a tag with the running version', () => {
  assert.equal(isNewer('v1.0.10', '1.0.9'), true);
  assert.equal(isNewer('v1.0.9', '1.0.9'), false);
  assert.equal(isNewer('v1.0.8', '1.0.9'), false);
  assert.equal(isNewer('v0.0.1', '0.0.0'), true);
  assert.equal(isNewer('v1.0.0', 'v0.9.0'), true);
});

test('unknown running version is never older; bad input is never newer', () => {
  assert.equal(isNewer('v9.9.9', 'unknown'), false);
  assert.equal(isNewer('v1.0.0', ''), false);
  assert.equal(isNewer('garbage', '1.0.0'), false);
  assert.equal(isNewer('v1.0.0-rc.1', '0.9.0'), false);
});
