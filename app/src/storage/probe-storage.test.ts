import assert from 'node:assert/strict';
import { test } from 'node:test';
import { M365TokenSource } from '../email/m365-token';
import { startFakeGraph } from '../testing/fake-graph';
import { GraphConnector } from './connectors/graph';
import { PROBE_CHECKS, ProbeUsageError, parseProbeArgs, probeStorage } from './probe-storage-cli';
import type { DestinationRef } from './types';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'probe-secret-value-1234567890';
const TEST_ACCOUNT = 'probe.person@example.org';

test('probe against the fake Graph prints every check line and no token or secret', async () => {
  const fake = await startFakeGraph();
  try {
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: APP_ID, clientSecret: SECRET }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    const connector = new GraphConnector(tokens, {
      fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: false, allowedDomains: async () => ['example.org'], appClientId: APP_ID,
    });
    const d = fake.addDrive();
    fake.addUser(TEST_ACCOUNT);
    fake.seedPermission(d.driveId, d.rootItemId, { kind: 'owner_group', principal: 'Site Owners', roles: ['owner'] });
    const dest: DestinationRef = { id: 'probe-dest', connector: 'graph', driveId: d.driveId, rootItemId: d.rootItemId };

    const lines: string[] = [];
    const result = await probeStorage(connector, dest, { testAccount: TEST_ACCOUNT, granted: 'write', log: (l) => lines.push(l) });
    const out = lines.join('\n');

    for (const check of PROBE_CHECKS) assert.ok(lines.some((l) => l.startsWith(`${check}: `)), `a line for ${check}\n${out}`);
    assert.ok(result.ok, out);
    assert.ok(!/FAILED/.test(out), out);
    assert.match(out, /hashes: ok .*YRDDGAAAAAAAAAAAAwAAAAAAAAA=/);
    assert.match(out, /unknown account: ok .*404/);
    assert.match(out, /write sufficed: ok .*write suffices/);
    assert.match(out, /library permissions: note .*owner_group via grantedToV2\.siteGroup roles \[owner\]/);
    // Both the small upload and the chunked one (an upload session) really ran.
    assert.ok(fake.chunkSizes.length >= 2, 'the chunked upload used an upload session');
    // The destination check's read invitation, then read and write to the test account, then the unknown account's (refused).
    assert.deepEqual(fake.invites.map((i) => (i.body as { roles: string[] }).roles[0]), ['read', 'read', 'write', 'read']);
    // Cleaned up: the probe folder is gone, nothing went to the recycle bin.
    assert.deepEqual(fake.recycleBin(d.driveId), []);
    assert.ok(!out.includes(fake.token), 'never the token');
    assert.ok(!out.includes(SECRET), 'never the secret');
  } finally {
    await fake.close();
  }
});

test('a refused token stops the probe at its first line and prints no secret', async () => {
  const fake = await startFakeGraph();
  try {
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: APP_ID, clientSecret: SECRET }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    const connector = new GraphConnector(tokens, {
      fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: false, allowedDomains: async () => ['example.org'], appClientId: APP_ID,
    });
    const d = fake.addDrive();
    fake.fault({ pathIncludes: '/oauth2/v2.0/token' }, '401', 5);
    const lines: string[] = [];
    const result = await probeStorage(connector, { id: 'x', connector: 'graph', driveId: d.driveId, rootItemId: d.rootItemId }, { log: (l) => lines.push(l) });
    assert.equal(result.ok, false);
    assert.match(lines[0], /^token: FAILED/);
    for (const check of PROBE_CHECKS) assert.ok(lines.some((l) => l.startsWith(`${check}: `)), check);
    assert.ok(!lines.join('\n').includes(SECRET));
  } finally {
    await fake.close();
  }
});

test('folder invitations refused as forbidden with --granted write say write does not suffice', async () => {
  const fake = await startFakeGraph();
  try {
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: APP_ID, clientSecret: SECRET }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    const connector = new GraphConnector(tokens, {
      fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: false, allowedDomains: async () => ['example.org'], appClientId: APP_ID,
    });
    const d = fake.addDrive();
    fake.addUser(TEST_ACCOUNT);
    fake.fault({ method: 'POST', pathIncludes: '/invite' }, '403', 10);
    const lines: string[] = [];
    const result = await probeStorage(connector, { id: 'x', connector: 'graph', driveId: d.driveId, rootItemId: d.rootItemId }, { testAccount: TEST_ACCOUNT, granted: 'write', log: (l) => lines.push(l) });
    const out = lines.join('\n');
    assert.equal(result.ok, false);
    assert.match(out, /invite and revoke: FAILED — forbidden \(HTTP 403\)/);
    assert.match(out, /write sufficed: FAILED — write does not suffice/);
    assert.match(out, /permissions needed: note — .*fullcontrol/);
    // The other checks still ran, and the probe folder was still removed.
    assert.match(out, /hashes: ok/);
    assert.match(out, /permanent delete: ok/);
  } finally {
    await fake.close();
  }
});

test('an account that cannot be shared with says nothing about write', async () => {
  const fake = await startFakeGraph();
  try {
    const tokens = new M365TokenSource({ tenantId: 'test-tenant', clientId: APP_ID, clientSecret: SECRET }, fake.fetch, undefined, undefined, GRAPH_SCOPE);
    const connector = new GraphConnector(tokens, {
      fetchFn: fake.fetch, graphBase: fake.graphBase, lookup: false, allowedDomains: async () => ['example.net'], appClientId: APP_ID,
    });
    const d = fake.addDrive();
    const lines: string[] = [];
    await probeStorage(connector, { id: 'x', connector: 'graph', driveId: d.driveId, rootItemId: d.rootItemId }, { testAccount: TEST_ACCOUNT, granted: 'write', log: (l) => lines.push(l) });
    const out = lines.join('\n');
    assert.match(out, /invite and revoke: FAILED — .*could not be given read access/);
    assert.match(out, /write sufficed: not run — /);
  } finally {
    await fake.close();
  }
});

test('the probe needs a destination label; the other flags are checked', () => {
  assert.throws(() => parseProbeArgs([]), ProbeUsageError);
  assert.throws(() => parseProbeArgs(['--destination', 'Outputs', '--granted', 'owner']), ProbeUsageError);
  assert.throws(() => parseProbeArgs(['--destination', 'Outputs', '--test-account', 'not-an-address']), ProbeUsageError);
  assert.deepEqual(parseProbeArgs(['--destination', 'Outputs library', '--test-account', TEST_ACCOUNT, '--granted', 'fullcontrol']), {
    destination: 'Outputs library', testAccount: TEST_ACCOUNT, granted: 'fullcontrol',
  });
});
