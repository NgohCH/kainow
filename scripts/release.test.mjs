// Tests for scripts/release.mjs. Throwaway ed25519 keys and temp repositories only;
// nothing is pushed anywhere except to a temp bare "origin".
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release.mjs');
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const slash = (p) => p.replace(/\\/g, '/');

function sh(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf8', input, windowsHide: true });
  return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '', missing: r.error?.code === 'ENOENT' };
}
function git(cwd, ...args) {
  const r = sh('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function toolsMissing() {
  if (sh('git', ['--version']).missing) return 'git is not installed';
  const dir = mkdtempSync(join(tmpdir(), 'kainow-rel-probe-'));
  try {
    const k = sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'k')]);
    if (k.missing) return 'ssh-keygen is not installed';
    return k.code === 0 ? null : 'ssh-keygen cannot make an ed25519 key';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const skip = toolsMissing() ?? false;

const COMPOSE = `services:
  app:
    image: kainow-app:0.0.0
  db:
    image: postgres:16
  ops:
    image: kainow-ops:0.0.0
  updater:
    image: kainow-updater:0.0.0
`;
const CHANGELOG = `# Changelog

## Unreleased

- later

## 1.2.0

### Added

- the new thing

## 1.1.0

- older
`;

describe('scripts/release.mjs', { skip }, () => {
  let root;
  let n = 0;
  const made = [];
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'kainow-rel-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function newKey(name) {
    const priv = join(root, name);
    const r = sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', priv]);
    assert.equal(r.code, 0, r.stderr);
    const [type, b64] = readFileSync(`${priv}.pub`, 'utf8').trim().split(/\s+/);
    return { priv: slash(priv), line: `kainow-release namespaces="git" ${type} ${b64}` };
  }

  /** A bare origin plus a work clone on main with a signed-release-ready layout. */
  function setup({ signers, key, changelog = CHANGELOG, tags = [] }) {
    const id = ++n;
    const origin = join(root, `origin${id}.git`);
    const work = join(root, `work${id}`);
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'init', '-q', '-b', 'main', work);
    for (const [k, v] of [
      ['user.name', 'Release Test'],
      ['user.email', 'release@example.org'],
      ['core.autocrlf', 'false'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['user.signingkey', key.priv],
    ]) git(work, 'config', k, v);
    git(work, 'remote', 'add', 'origin', slash(origin));
    const put = (rel, text) => {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), text);
    };
    put('app/package.json', JSON.stringify({ name: 'kainow-app', version: '1.1.0', private: true }, null, 2) + '\n');
    put('app/package-lock.json', JSON.stringify({ name: 'kainow-app', version: '1.1.0', lockfileVersion: 3, packages: { '': { name: 'kainow-app', version: '1.1.0' } } }, null, 2) + '\n');
    put('app/web/package.json', JSON.stringify({ name: 'kainow-web', version: '1.1.0' }, null, 2) + '\n');
    put('compose.yaml', COMPOSE.replace(/0\.0\.0/g, '1.1.0'));
    put('CHANGELOG.md', changelog);
    put('release/release-signers', signers.map((k) => k.line).join('\n') + '\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'initial');
    git(work, 'push', '-q', 'origin', 'main');
    for (const t of tags) git(work, 'tag', t);
    made.push(work);
    return { origin, work };
  }

  const release = (work, ...args) => sh('node', [SCRIPT, ...args], work);

  it('refuses when not on main', () => {
    const key = newKey('k1');
    const { work } = setup({ signers: [key], key });
    git(work, 'checkout', '-q', '-b', 'topic');
    const r = release(work, '1.2.0', '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /main/);
  });

  it('refuses with a dirty tree', () => {
    const key = newKey('k2');
    const { work } = setup({ signers: [key], key });
    writeFileSync(join(work, 'README.md'), 'x\n');
    git(work, 'add', 'README.md');
    const r = release(work, '1.2.0', '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /uncommitted/);
  });

  it('refuses when the version is not greater than the last tag', () => {
    const key = newKey('k3');
    const { work } = setup({ signers: [key], key, tags: ['v1.2.0', 'v1.10.0'] });
    const r = release(work, '1.2.0', '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not greater/);
    // 1.9.0 is below v1.10.0 (numeric, not text, comparison).
    assert.equal(release(work, '1.9.0', '--dry-run').code, 1);
  });

  it('refuses when user.signingkey is not in release/release-signers', () => {
    const listed = newKey('k4a');
    const other = newKey('k4b');
    const { work } = setup({ signers: [listed], key: other });
    const r = release(work, '1.2.0', '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not listed/);
  });

  it('refuses when the signers file holds no key (as in the repository today)', () => {
    const key = newKey('k4c');
    const { work } = setup({ signers: [], key });
    writeFileSync(join(work, 'release/release-signers'), '# no key yet\n');
    git(work, 'commit', '-q', '-am', 'comment only');
    git(work, 'push', '-q', 'origin', 'main');
    const r = release(work, '1.2.0', '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not listed/);
  });

  it('refuses without a CHANGELOG section for the version', () => {
    const key = newKey('k5');
    const { work } = setup({ signers: [key], key });
    const r = release(work, '1.3.0', '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CHANGELOG/);
  });

  it('refuses a malformed version with a usage error', () => {
    const key = newKey('k5b');
    const { work } = setup({ signers: [key], key });
    assert.equal(release(work, '1.2', '--dry-run').code, 2);
    assert.equal(release(work, 'v1.2.0', '--dry-run').code, 2);
  });

  it('--dry-run sets versions and compose tags, commits, signs, verifies and pushes nothing', () => {
    const key = newKey('k6');
    const { origin, work } = setup({ signers: [key], key });
    const headBefore = git(work, 'rev-parse', 'HEAD');
    const clone = join(root, 'dry-clone');
    const r = release(work, '1.2.0', '--dry-run', '--clone-dir', clone);
    assert.equal(r.code, 0, r.stderr + r.stdout);

    for (const f of ['app/package.json', 'app/web/package.json']) {
      assert.equal(JSON.parse(readFileSync(join(clone, f), 'utf8')).version, '1.2.0', f);
    }
    const lock = JSON.parse(readFileSync(join(clone, 'app/package-lock.json'), 'utf8'));
    assert.equal(lock.version, '1.2.0');
    assert.equal(lock.packages[''].version, '1.2.0');
    const compose = readFileSync(join(clone, 'compose.yaml'), 'utf8');
    for (const name of ['kainow-app', 'kainow-ops', 'kainow-updater']) assert.match(compose, new RegExp(`image: ${name}:1\\.2\\.0\\b`));
    assert.match(compose, /image: postgres:16\b/);

    assert.equal(git(clone, 'log', '-1', '--format=%s'), 'Release v1.2.0');
    assert.equal(git(clone, 'cat-file', '-t', 'v1.2.0'), 'tag');
    const raw = git(clone, 'cat-file', 'tag', 'v1.2.0');
    const message = raw.slice(raw.indexOf('\n\n') + 2, raw.indexOf('-----BEGIN SSH SIGNATURE-----')).trim();
    assert.equal(message, '### Added\n\n- the new thing');
    assert.equal(git(clone, 'rev-parse', 'v1.2.0^{commit}'), git(clone, 'rev-parse', 'HEAD'));

    // Verifies the way an installation does.
    const signers = join(clone, 'release/release-signers');
    const v = sh('git', ['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${slash(signers)}`, 'verify-tag', '--raw', 'v1.2.0'], clone);
    assert.equal(v.code, 0, v.stderr);
    assert.match(v.stdout + v.stderr, /Good "git" signature for kainow-release/);

    // Pushed nothing; the original repository is untouched.
    assert.equal(sh('git', ['tag', '-l'], origin).stdout.trim(), '');
    assert.equal(git(origin, 'rev-parse', 'main'), headBefore);
    assert.equal(git(work, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(work, 'tag', '-l'), '');
  });

  it('refuses when an image: kainow- line would keep its old version, before committing anything', () => {
    const key = newKey('k8');
    const { work } = setup({ signers: [key], key });
    writeFileSync(join(work, 'compose.yaml'), COMPOSE.replace(/0\.0\.0/g, '1.1.0').replace('image: kainow-ops:1.1.0', 'image: "kainow-ops:1.1.0"'));
    git(work, 'commit', '-q', '-am', 'quoted image');
    git(work, 'push', '-q', 'origin', 'main');
    const clone = join(root, 'stale-clone');
    const r = release(work, '1.2.0', '--dry-run', '--clone-dir', clone);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /compose\.yaml has image lines that would not carry 1\.2\.0: image: "kainow-ops:1\.1\.0"/);
    assert.equal(git(clone, 'log', '-1', '--format=%s'), 'quoted image', 'no release commit');
    assert.equal(JSON.parse(readFileSync(join(clone, 'app/package.json'), 'utf8')).version, '1.1.0', 'nothing written');
  });

  it('answering no makes no push', () => {
    const key = newKey('k7');
    const { origin, work } = setup({ signers: [key], key });
    const headBefore = git(work, 'rev-parse', 'HEAD');
    const r = sh('node', [SCRIPT, '1.2.0'], work, 'no\n');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Push v1\.2\.0 to origin and create the GitHub release\? \(yes\/no\)/);
    assert.equal(sh('git', ['tag', '-l'], origin).stdout.trim(), '');
    assert.equal(git(origin, 'rev-parse', 'main'), headBefore);
  });
});
