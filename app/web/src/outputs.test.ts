import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWhen } from './format.ts';
import {
  APPROVAL_NOTICE, ACCESS_REVIEW, KEPT_AT_EXISTING, approvalNoticeFor, audiencePreviewText, checkLabel, effectiveSourceLabel, exportControls,
  exportPath, fileAccess, filenameFromDisposition, filingLabel, mayAskApproval, mayFile, notMovedLabel, notSharedLabel, openRefusal, sourceStorageLabel, transferConfirmText,
  versionStatusLabel, type OutputVersion,
} from './outputs.ts';

test('version statuses in the spec’s words: a Draft says it is not approved', () => {
  assert.equal(versionStatusLabel('draft'), 'Draft — not approved');
  assert.equal(versionStatusLabel('approved'), 'Approved');
  assert.equal(versionStatusLabel('superseded'), 'Superseded');
});

test('filing states in words, with the reason after "Filing failed — "', () => {
  assert.equal(filingLabel('stored'), 'Filed');
  assert.equal(filingLabel('pending'), 'Waiting to file');
  assert.equal(filingLabel('not_filed'), 'Not filed');
  assert.equal(filingLabel(null), 'Not filed');
  assert.equal(filingLabel('linked'), 'Kept at its existing location');
  assert.equal(KEPT_AT_EXISTING, 'Kept at its existing location');
  assert.equal(filingLabel('not_kept'), 'Not filed — file no longer kept; generate or upload it again');
  assert.equal(filingLabel('failed', 'The storage location is full'), 'Filing failed — The storage location is full');
  assert.equal(filingLabel('failed'), 'Filing failed — Kainow ran into a problem');
  assert.equal(filingLabel('something_new'), 'Not filed');
});

test('check results carry their time; a changed approved file says it is not the approved content', () => {
  const at = '2026-11-20T02:00:00.000Z';
  assert.equal(checkLabel('ok', at), `Checked ${formatWhen(at)}`);
  assert.equal(checkLabel('missing', at), `Missing ${formatWhen(at)}`);
  assert.equal(checkLabel('access_denied', at), `Access denied ${formatWhen(at)}`);
  assert.equal(checkLabel('changed', at, 'approved'), 'File changed since approval — this is not the approved content');
  assert.equal(checkLabel('changed', at, 'superseded'), 'File changed since approval — this is not the approved content');
  assert.equal(checkLabel('changed', at, 'draft'), `Changed ${formatWhen(at)}`);
  assert.equal(checkLabel('unverified', at), `Unverified — last checked ${formatWhen(at)}`);
  assert.equal(checkLabel('unverified', null), 'Unverified — never checked');
  assert.equal(checkLabel(null, null), 'Never checked');
});

test('not-shared, review and transfer labels are the spec’s exact copy', () => {
  assert.equal(notSharedLabel('ann@example.org'), 'Not shared in SharePoint — no Microsoft account found for ann@example.org');
  assert.equal(ACCESS_REVIEW, 'Access review required');
  assert.equal(notMovedLabel('Finance/Bridge'), 'Files not moved — still at Finance/Bridge');
});

test('effective values say where they come from', () => {
  assert.equal(effectiveSourceLabel('organisation'), 'From the organisation');
  assert.equal(effectiveSourceLabel('project'), 'Set for this project');
  assert.equal(effectiveSourceLabel('none'), 'Not chosen yet');
});

test('source version storage states in words; nothing for people not shown it', () => {
  assert.equal(sourceStorageLabel('stored'), 'Stored');
  assert.equal(sourceStorageLabel('waiting'), 'Waiting to store');
  assert.equal(sourceStorageLabel('failed'), 'Storage failed');
  assert.equal(sourceStorageLabel(null), null);
  assert.equal(sourceStorageLabel(undefined), null);
});

test('Export CSV is hidden when not allowed; Save as output only for those who may also submit', () => {
  assert.deepEqual(exportControls(null), []);
  assert.deepEqual(exportControls({ mayExport: false, maySubmit: true }), []);
  assert.deepEqual(exportControls({ mayExport: true, maySubmit: false }), ['export']);
  assert.deepEqual(exportControls({ mayExport: true, maySubmit: true }), ['export', 'save']);
});

test('the export path carries the kind and only the filters that are set', () => {
  assert.equal(exportPath('p1', 'tasks'), '/projects/p1/export?kind=tasks');
  assert.equal(exportPath('p1', 'outputs', { status: 'registered', reportTypeId: undefined, overdue: '' }), '/projects/p1/export?kind=outputs&status=registered');
});

test('an output approval shows that approving does not approve the commitments it mentions', () => {
  assert.equal(APPROVAL_NOTICE, 'Approving this document does not approve the commitments it mentions.');
  assert.equal(approvalNoticeFor({ kind: 'approve_output' }), 'Approving this document does not approve the commitments it mentions.');
  assert.equal(approvalNoticeFor({ kind: 'approve_output', notice: APPROVAL_NOTICE }), APPROVAL_NOTICE);
  assert.equal(approvalNoticeFor({ kind: 'amend_task' }), null);
});

const version = (status: OutputVersion['status'], state: string, checkStatus: string | null, extra: Partial<OutputVersion['filing']> = {}): OutputVersion => ({
  no: 1, origin: state === 'linked' ? 'link' : 'upload', format: 'pdf', status, sizeBytes: 10, createdAt: '2026-11-20T00:00:00Z',
  createdBy: { id: 'u', displayName: 'Ann' }, approvalRequestId: null,
  filing: { state, label: '', checkStatus: checkStatus as OutputVersion['filing']['checkStatus'], lastCheckedAt: null, ...extra },
});

test('approval is offered only for a filed (or checked linked) Draft whose check does not block it', () => {
  assert.equal(mayAskApproval(version('draft', 'stored', 'ok')), true);
  assert.equal(mayAskApproval(version('draft', 'stored', 'unverified')), true);
  for (const s of ['changed', 'missing', 'access_denied']) assert.equal(mayAskApproval(version('draft', 'stored', s)), false, s);
  assert.equal(mayAskApproval(version('draft', 'not_filed', null)), false);
  assert.equal(mayAskApproval(version('approved', 'stored', 'ok')), false);
  assert.equal(mayAskApproval(version('draft', 'linked', 'ok')), true);
  assert.equal(mayAskApproval(version('draft', 'linked', 'unverified')), false, 'a linked document must be checked first');
});

test('File it is offered for an unfiled version, and Try again only where the server says so', () => {
  assert.equal(mayFile(version('draft', 'not_filed', null)), true);
  assert.equal(mayFile(version('draft', 'failed', null)), false);
  assert.equal(mayFile(version('draft', 'failed', null, { tryAgain: true })), true);
  assert.equal(mayFile(version('draft', 'stored', 'ok')), false);
  assert.equal(mayFile(version('draft', 'linked', 'ok')), false);
});

test('a refused Open is read from its 409 body; unknown actions are dropped', () => {
  assert.deepEqual(openRefusal({ state: 'missing', label: 'Missing', actions: ['relink', 'add_version', 'explode'] }), { state: 'missing', label: 'Missing', actions: ['relink', 'add_version'] });
  assert.equal(openRefusal({ message: 'x' }), null);
  assert.equal(openRefusal(null), null);
});

test('audience preview names who gains and who loses access', () => {
  assert.equal(audiencePreviewText({ gaining: [{ id: '1', name: 'Ann' }], losing: [] }), '1 person will gain access: Ann.');
  assert.equal(
    audiencePreviewText({ gaining: [], losing: [{ id: '1', name: 'Ann' }, { id: '2', name: 'Ben' }] }),
    '2 people will lose access: Ann, Ben.',
  );
  assert.equal(audiencePreviewText({ gaining: [], losing: [] }), 'Nobody gains or loses access.');
});

test('the department change confirmation states the affected files and that sharing is unchanged', () => {
  const move = transferConfirmText(3, 'move', 'Finance', 'Works');
  assert.match(move, /3 filed output files will be moved/);
  assert.match(move, /Who can open them in SharePoint does not change\./);
  const keep = transferConfirmText(1, 'keep', 'Finance', 'Works');
  assert.match(keep, /1 filed output file will stay where it is/);
  assert.match(keep, /Kept at its existing location \(filed under Finance\)/);
  assert.match(keep, /does not change/);
  assert.match(transferConfirmText(0, null, 'Finance', 'Works'), /no files are affected/);
});

test('a download is named from its Content-Disposition, else the fallback', () => {
  assert.equal(filenameFromDisposition('attachment; filename="Bridge tasks 2026-11-20.csv"', 'tasks.csv'), 'Bridge tasks 2026-11-20.csv');
  assert.equal(filenameFromDisposition("attachment; filename=\"x.csv\"; filename*=UTF-8''Jambatan%20t%C3%A1sk.csv", 'tasks.csv'), 'Jambatan tásk.csv');
  assert.equal(filenameFromDisposition(null, 'tasks.csv'), 'tasks.csv');
});

test('a filed file opens and downloads; a linked document only opens (in SharePoint); anything else neither', () => {
  assert.deepEqual(fileAccess('stored'), { open: true, download: true });
  assert.deepEqual(fileAccess('linked'), { open: true, download: false });
  for (const s of ['pending', 'failed', 'withheld', 'missing', null]) assert.deepEqual(fileAccess(s), { open: false, download: false }, String(s));
});
