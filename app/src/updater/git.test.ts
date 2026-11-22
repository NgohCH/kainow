import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gitToolsMissing, makeReleaseRepos, type Key, type ReleaseRepos } from '../testing/git-releases';
import { fetchCandidate, signersAt, verifyCandidate, workingTreeState } from './git';

let skip: string | false = false;
let r: ReleaseRepos;
let oldKey: Key;
let otherKey: Key;
let trusted: string; // the installation's trusted signers file (old key only)

before(async () => {
  const missing = await gitToolsMissing();
  if (missing) {
    skip = `skipped: ${missing}`;
    return;
  }
  r = await makeReleaseRepos();
  oldKey = await r.newKey('old');
  otherKey = await r.newKey('other');
  trusted = await r.signersFile('trusted-signers', [oldKey]);
});

after(async () => {
  if (r) await r.cleanup();
});

const t = (name: string, fn: () => Promise<void>) => test(name, async (ctx) => {
  if (skip) return ctx.skip(skip);
  await fn();
});

async function fetched(tag: string): Promise<string> {
  const f = await fetchCandidate(r.install, tag);
  assert.equal(f.ok, true, `fetch ${tag}`);
  return (f as { tagObject: string }).tagObject;
}

t('a signed annotated tag verifies and returns its commit and notes', async () => {
  const commit = await r.release('1.0.2');
  await r.tag('v1.0.2', { key: oldKey, message: 'Kainow 1.0.2\n\n- Fixed a thing' });
  await r.pushTag('v1.0.2');
  const obj = await fetched('v1.0.2');
  assert.match(obj, /^[0-9a-f]{40,64}$/);
  const v = await verifyCandidate(r.install, 'v1.0.2', obj, trusted, { commit, runningVersion: '1.0.1' });
  assert.deepEqual(v, { ok: true, commit, notes: 'Kainow 1.0.2\n\n- Fixed a thing' });
});

t('an unsigned annotated tag is signature_invalid', async () => {
  const commit = await r.release('1.0.3');
  await r.tag('v1.0.3', { key: null });
  await r.pushTag('v1.0.3');
  const obj = await fetched('v1.0.3');
  const v = await verifyCandidate(r.install, 'v1.0.3', obj, trusted, { commit, runningVersion: '1.0.1' });
  assert.deepEqual(v, { ok: false, code: 'signature_invalid' });
});

t('a lightweight tag is not_annotated', async () => {
  const commit = await r.release('1.0.4');
  await r.tag('v1.0.4', { lightweight: true });
  await r.pushTag('v1.0.4');
  const obj = await fetched('v1.0.4');
  assert.equal(obj, commit);
  const v = await verifyCandidate(r.install, 'v1.0.4', obj, trusted, { commit, runningVersion: '1.0.1' });
  assert.deepEqual(v, { ok: false, code: 'not_annotated' });
});

t('a tag signed by another key is signature_invalid', async () => {
  const commit = await r.release('1.0.5');
  await r.tag('v1.0.5', { key: otherKey });
  await r.pushTag('v1.0.5');
  const obj = await fetched('v1.0.5');
  const v = await verifyCandidate(r.install, 'v1.0.5', obj, trusted, { commit, runningVersion: '1.0.1' });
  assert.deepEqual(v, { ok: false, code: 'signature_invalid' });
});

t('a tag object whose internal name differs (v1.0.2 pushed as v1.0.3) is tag_name_mismatch', async () => {
  const commit = await r.release('1.0.6');
  await r.tag('v1.0.6', { key: oldKey });
  await r.pushTag('v1.0.6', 'v1.0.7');
  const obj = await fetched('v1.0.7');
  const v = await verifyCandidate(r.install, 'v1.0.7', obj, trusted, { commit, runningVersion: '1.0.1' });
  assert.deepEqual(v, { ok: false, code: 'tag_name_mismatch' });
});

t('a tag re-pointed to another commit after approval is commit_mismatch', async () => {
  const approved = await r.release('1.0.8');
  await r.tag('v1.0.8', { key: oldKey });
  await r.pushTag('v1.0.8');
  const first = await fetched('v1.0.8');
  const ok = await verifyCandidate(r.install, 'v1.0.8', first, trusted, { commit: approved, runningVersion: '1.0.1' });
  assert.equal(ok.ok, true);
  // The tag is moved (still validly signed) to a later commit after approval.
  await r.release('1.0.8', { 'app/extra.txt': 'moved\n' });
  await r.tag('v1.0.8', { key: oldKey });
  await r.pushTag('v1.0.8');
  const second = await fetched('v1.0.8');
  assert.notEqual(second, first, 'the private ref follows the moved tag');
  const v = await verifyCandidate(r.install, 'v1.0.8', second, trusted, { commit: approved, runningVersion: '1.0.1' });
  assert.deepEqual(v, { ok: false, code: 'commit_mismatch' });
});

t('package.json 1.0.1 under tag v1.0.2 is version_mismatch', async () => {
  const commit = await r.release('1.0.1');
  await r.tag('v1.0.9', { key: oldKey });
  await r.pushTag('v1.0.9');
  const obj = await fetched('v1.0.9');
  const v = await verifyCandidate(r.install, 'v1.0.9', obj, trusted, { commit, runningVersion: '1.0.0' });
  assert.deepEqual(v, { ok: false, code: 'version_mismatch' });
});

t('a tag not newer than the running version is not_newer', async () => {
  const commit = await r.release('1.1.0');
  await r.tag('v1.1.0', { key: oldKey });
  await r.pushTag('v1.1.0');
  const obj = await fetched('v1.1.0');
  for (const running of ['1.1.0', '1.2.0', '2.0.0']) {
    const v = await verifyCandidate(r.install, 'v1.1.0', obj, trusted, { commit, runningVersion: running });
    assert.deepEqual(v, { ok: false, code: 'not_newer' }, running);
  }
});

t('rotation: release signed by the old key carrying a new signers file verifies, and signersAt returns the new file', async () => {
  const newKey = await r.newKey('new');
  const rotated = r.signersText([oldKey, newKey]);
  const commit = await r.release('2.0.0', { 'release/release-signers': rotated });
  await r.tag('v2.0.0', { key: oldKey });
  await r.pushTag('v2.0.0');
  const obj = await fetched('v2.0.0');
  const v = await verifyCandidate(r.install, 'v2.0.0', obj, trusted, { commit, runningVersion: '1.1.0' });
  assert.equal(v.ok, true);
  assert.equal(await signersAt(r.install, commit), rotated);
  assert.equal(await signersAt(r.install, (await fetched('v1.0.2'))), null, 'a tag object id is not a commit with the file');

  // The next release is signed only by the new key; until the installation has
  // copied the new file over its trusted one, the old file must refuse it.
  const next = await r.release('2.0.1', { 'release/release-signers': r.signersText([newKey]) });
  await r.tag('v2.0.1', { key: newKey });
  await r.pushTag('v2.0.1');
  const obj2 = await fetched('v2.0.1');
  const refused = await verifyCandidate(r.install, 'v2.0.1', obj2, trusted, { commit: next, runningVersion: '2.0.0' });
  assert.deepEqual(refused, { ok: false, code: 'signature_invalid' }, 'a release signed only by the new key, against the old signers file, is signature_invalid');

  // After installing v2.0.0 the installation trusts the rotated file.
  const installed = await r.signersFile('trusted-after-rotation', [oldKey, newKey]);
  const accepted = await verifyCandidate(r.install, 'v2.0.1', obj2, installed, { commit: next, runningVersion: '2.0.0' });
  assert.equal(accepted.ok, true);
});

t('a release signed only by the new key, against the old signers file, is signature_invalid', async () => {
  const brandNew = await r.newKey('brand-new');
  const commit = await r.release('3.0.0', { 'release/release-signers': r.signersText([brandNew]) });
  await r.tag('v3.0.0', { key: brandNew });
  await r.pushTag('v3.0.0');
  const obj = await fetched('v3.0.0');
  const v = await verifyCandidate(r.install, 'v3.0.0', obj, trusted, { commit, runningVersion: '2.0.1' });
  assert.deepEqual(v, { ok: false, code: 'signature_invalid' });
});

t('a key listed under another principal is signature_invalid', async () => {
  const commit = await r.release('3.0.1');
  await r.tag('v3.0.1', { key: otherKey });
  await r.pushTag('v3.0.1');
  const obj = await fetched('v3.0.1');
  const wrongPrincipal = join(r.root, 'wrong-principal');
  await writeFile(wrongPrincipal, otherKey.line.replace(/^kainow-release /, 'someone-else ') + '\n');
  const v = await verifyCandidate(r.install, 'v3.0.1', obj, wrongPrincipal, { commit, runningVersion: '2.0.1' });
  assert.deepEqual(v, { ok: false, code: 'signature_invalid' });
});

t('fetchCandidate refuses a tag that is not a release tag or does not exist', async () => {
  assert.deepEqual(await fetchCandidate(r.install, 'v9.9.9'), { ok: false, code: 'fetch_failed' });
  assert.deepEqual(await fetchCandidate(r.install, '--upload-pack=x'), { ok: false, code: 'fetch_failed' });
  assert.deepEqual(await fetchCandidate(r.install, 'v1.0.2:refs/heads/main'), { ok: false, code: 'fetch_failed' });
});

t('workingTreeState reports an edited compose.yaml and ignores untracked .env', async () => {
  const before = await workingTreeState(r.install);
  assert.deepEqual(before, { clean: true, changed: [], headTag: null });
  await writeFile(join(r.install, 'compose.yaml'), 'services: { edited: {} }\n');
  await writeFile(join(r.install, '.env'), 'X=1\n');
  const s = await workingTreeState(r.install);
  assert.deepEqual(s, { clean: false, changed: ['compose.yaml'], headTag: null });
});

t('workingTreeState names the release tag at HEAD', async () => {
  const st = await workingTreeState(r.pub);
  assert.equal(st.clean, true);
  assert.equal(st.headTag, 'v3.0.1');
});
