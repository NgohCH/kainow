import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWhen } from './format.ts';
import {
  checkLineLabel, destinationBody, destinationProblem, emptyDestinationForm, moveConfirmProblem, offeredKinds, permissionInstructions,
  quotaLabel, repairLine, secretProblem, siteGrantExample, sizeLabel, storageStateLabel, type DestinationForm,
} from './storage.ts';

test('the quota is "Unavailable" when the provider reports none, never zero', () => {
  assert.equal(quotaLabel(null), 'Unavailable');
  assert.equal(quotaLabel(undefined), 'Unavailable');
  assert.notEqual(quotaLabel(null), '0');
  assert.equal(quotaLabel(0), '0 B');
  assert.equal(quotaLabel(1536), '1.5 KB');
  assert.equal(sizeLabel(5 * 1024 * 1024 * 1024), '5.0 GB');
});

test('every connection state has words, and an unknown one is not shown as a code', () => {
  assert.equal(storageStateLabel('connected'), 'Connected');
  assert.equal(storageStateLabel('not_configured'), 'Not set up');
  assert.equal(storageStateLabel('protected_key_missing'), 'Waiting for the protected key');
  assert.equal(storageStateLabel('refused'), 'Microsoft refused these credentials');
  assert.equal(storageStateLabel('unreachable'), 'Could not reach Microsoft');
  assert.equal(storageStateLabel('not_checked'), 'Not checked yet');
  assert.equal(storageStateLabel('something_else'), 'Not checked yet');
  assert.equal(storageStateLabel(null), 'Not checked yet');
});

test('check lines say Passed or Failed in words for every key', () => {
  for (const key of ['reachable', 'folder', 'upload', 'delete', 'permissions', 'library_permissions', 'sharing_capability']) {
    assert.match(checkLineLabel(key, true), /^Passed: /);
    assert.match(checkLineLabel(key, false), /^Failed: /);
    assert.notEqual(checkLineLabel(key, true).slice(8), checkLineLabel(key, false).slice(8));
  }
  assert.equal(checkLineLabel('library_permissions', false), 'Failed: Others can open the library');
  assert.equal(checkLineLabel('new_check', false), 'Failed: new check');
});

const sp = (): DestinationForm => ({ ...emptyDestinationForm(), label: 'Reports', siteUrl: 'https://tenant.example.net/sites/team', libraryName: 'Documents', reason: 'Needed' });

test('OneDrive is offered only while directory lookup is on, and refused otherwise', () => {
  assert.deepEqual(offeredKinds(false).map((k) => k.value), ['sharepoint_library']);
  assert.deepEqual(offeredKinds(true).map((k) => k.value), ['sharepoint_library', 'onedrive']);
  const od: DestinationForm = { ...emptyDestinationForm(), kind: 'onedrive', label: 'Mine', accountEmail: 'a@example.org', reason: 'Needed' };
  assert.match(destinationProblem(od, false) ?? '', /directory lookup/);
  assert.equal(destinationProblem(od, true), null);
});

test('the destination form asks for a name, the kind-specific fields and a reason', () => {
  assert.equal(destinationProblem(sp(), false), null);
  assert.match(destinationProblem({ ...sp(), label: ' ' }, false) ?? '', /name/);
  assert.match(destinationProblem({ ...sp(), siteUrl: 'tenant' }, false) ?? '', /site address/);
  assert.match(destinationProblem({ ...sp(), libraryName: '' }, false) ?? '', /library/);
  assert.match(destinationProblem({ ...sp(), reason: '  ' }, false) ?? '', /reason/);
  const od: DestinationForm = { ...emptyDestinationForm(), kind: 'onedrive', label: 'Mine', accountEmail: 'nope', reason: 'r' };
  assert.match(destinationProblem(od, true) ?? '', /email/);
});

test('the destination body carries only the fields of the chosen kind', () => {
  assert.deepEqual(destinationBody({ ...sp(), accountEmail: 'x@example.org', folderPath: ' Kainow ' }), {
    kind: 'sharepoint_library', purpose: 'outputs', label: 'Reports', reason: 'Needed', siteUrl: 'https://tenant.example.net/sites/team', libraryName: 'Documents', folderPath: 'Kainow',
  });
  const od = destinationBody({ ...emptyDestinationForm(), kind: 'onedrive', label: 'Mine', accountEmail: ' a@example.org ', siteUrl: 'https://x', reason: 'r' });
  assert.equal(od.accountEmail, 'a@example.org');
  assert.equal('siteUrl' in od, false);
});

test('permission instructions list Sites.Selected always and User.ReadBasic.All only with lookup on', () => {
  assert.deepEqual(permissionInstructions(false).map((p) => p.name), ['Sites.Selected']);
  assert.deepEqual(permissionInstructions(true).map((p) => p.name), ['Sites.Selected', 'User.ReadBasic.All']);
});

test('site grant examples use write for the source area, fullcontrol for outputs and placeholders only', () => {
  const src = siteGrantExample('source_area', 'sharepoint_library');
  const out = siteGrantExample('outputs', 'sharepoint_library');
  assert.equal(src.role, 'write');
  assert.equal(out.role, 'fullcontrol');
  assert.match(src.powershell, /-Permissions Write$/);
  assert.match(out.powershell, /-Permissions FullControl$/);
  assert.match(out.graph, /"fullcontrol"/);
  for (const t of [src.powershell, src.graph, out.powershell, out.graph]) assert.match(t, /<application-id>/);
  assert.match(out.powershell, /<tenant>\.sharepoint\.com\/sites\/<site-name>/);
  assert.match(siteGrantExample('outputs', 'onedrive').powershell, /<tenant>-my\.sharepoint\.com\/personal\/<account>/);
});

test('moving the source area needs the exact file count and size', () => {
  const actual = { files: 12, bytes: 4096 };
  assert.match(moveConfirmProblem('', '', actual) ?? '', /Type/);
  assert.match(moveConfirmProblem('11', '4096', actual) ?? '', /do not match/);
  assert.match(moveConfirmProblem('12', '4000', actual) ?? '', /12 files/);
  assert.equal(moveConfirmProblem('12', '4096', actual), null);
});

test('the client secret is 10 to 200 printable characters', () => {
  assert.notEqual(secretProblem('short'), null);
  assert.notEqual(secretProblem('x'.repeat(201)), null);
  assert.notEqual(secretProblem('abcdefghij\u00e9'), null);
  assert.equal(secretProblem('  abcdefghij  '), null);
  assert.equal(secretProblem('short') ?? '', 'The client secret must be 10 to 200 characters.');
});

test('a sharing repair line names the project, folder, person and state in words', () => {
  const line = repairLine({ project: 'Alpha', projectId: null, folder: 'Outputs', person: 'Sam Lee', kind: 'access', state: 'failed', since: '2026-11-10T01:30:00Z' });
  assert.equal(line, 'Alpha · Outputs · Sam Lee · Access could not be given since ' + formatWhen('2026-11-10T01:30:00Z'));
});

test('a report type needs a name of 1 to 100 characters', async () => {
  const { nameProblem, REPORT_TYPE_STATUS } = await import('./storage.ts');
  assert.notEqual(nameProblem('  '), null);
  assert.notEqual(nameProblem('x'.repeat(101)), null);
  assert.equal(nameProblem(' Status reports '), null);
  assert.match(REPORT_TYPE_STATUS.retired, /^Retired/);
});
