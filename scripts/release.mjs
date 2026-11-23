#!/usr/bin/env node
/**
 * Kainow release script (10b spec 4.2). Run from the repository root:
 *
 *   node scripts/release.mjs <X.Y.Z> [--dry-run] [--clone-dir <dir>]
 *
 * Checks, sets the version, commits "Release vX.Y.Z", makes an SSH-signed annotated
 * tag whose message is the CHANGELOG.md section, verifies it exactly as an
 * installation will, then (without --dry-run) asks before pushing and creating the
 * GitHub release. --dry-run does the work in a throwaway clone and pushes nothing.
 * No dependencies. Exit 0 ok, 1 refused or failed, 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import readline from 'node:readline';

const PRINCIPAL = 'kainow-release';
const NAMESPACE = 'git';
const SIGNERS = 'release/release-signers';
const GOOD = new RegExp(`^Good "${NAMESPACE}" signature for ${PRINCIPAL} with \\S+ key \\S+`, 'm');
const KEY_RE = /(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)/;

class Refusal extends Error {}
const refuse = (m) => {
  throw new Refusal(m);
};

function run(cmd, args, cwd, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
  return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const git = (cwd, args) => run('git', args, cwd);
function must(cwd, args) {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const slash = (p) => p.replace(/\\/g, '/');
const parseV = (s) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The text of the `## X.Y.Z` (or `## vX.Y.Z`, `## X.Y.Z - date`) section, or null when absent or empty. */
function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s.*)?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? null : body;
}

const keyOf = (text) => {
  const m = KEY_RE.exec(text);
  return m ? `${m[1]} ${m[2]}` : null;
};

/** "type base64" of the public half of git's user.signingkey, or null. */
function signingPublicKey(cwd, value) {
  if (value.startsWith('key::')) return keyOf(value.slice(5));
  if (/^(ssh-|ecdsa-|sk-)/.test(value)) return keyOf(value);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  const path = resolve(cwd, value.replace(/^~(?=[\\/]|$)/, home));
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('PRIVATE KEY')) return keyOf(text);
  }
  if (existsSync(`${path}.pub`)) return keyOf(readFileSync(`${path}.pub`, 'utf8'));
  if (existsSync(path)) {
    const r = run('ssh-keygen', ['-y', '-f', path], cwd, { stdio: ['inherit', 'pipe', 'pipe'] });
    if (r.code === 0) return keyOf(r.stdout);
  }
  return null;
}

function signerKeys(file) {
  const keys = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.split(/\s+/)[0] !== PRINCIPAL) continue;
    const k = keyOf(line);
    if (k) keys.push(k);
  }
  return keys;
}

function setJsonVersion(file, version, alsoRoot) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  j.version = version;
  if (alsoRoot && j.packages && j.packages['']) j.packages[''].version = version;
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
}

/**
 * Every `image: kainow-<name>:X.Y.Z` line (app, ops, updater, ...) gets the new version. Refuses when any line naming a
 * `kainow-` image would keep another tag (quoted, `latest`, a comment after it, ...): an installation would otherwise
 * build the release over the running version's images (final review I2; the installation refuses it too).
 */
function setComposeTags(text, version) {
  const out = text.replace(/^(\s*image:\s*kainow-[a-z0-9-]+:)\d+\.\d+\.\d+(\s*)$/gm, `$1${version}$2`);
  const lines = out.split(/\r?\n/).filter((l) => /^\s*image:\s*["']?kainow-/.test(l));
  const want = new RegExp(String.raw`^\s*image:\s*kainow-[a-z0-9-]+:` + version.replace(/\./g, String.raw`\.`) + String.raw`\s*$`);
  const stale = lines.filter((l) => !want.test(l));
  if (!lines.length) refuse('compose.yaml has no "image: kainow-<name>:X.Y.Z" line.');
  if (stale.length) {
    refuse(`compose.yaml has image lines that would not carry ${version}: ${stale.map((l) => l.trim()).join('; ')}. Write them as "image: kainow-<name>:X.Y.Z".`);
  }
  return out;
}

function checks(repo, version) {
  const branch = must(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') refuse(`Releases are made from main; this is ${branch}.`);
  if (must(repo, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    refuse('The working tree has uncommitted changes. Commit or discard them first.');
  }
  const f = git(repo, ['fetch', '-q', 'origin', 'main']);
  if (f.code !== 0) refuse(`Cannot fetch origin/main: ${f.stderr.trim()}`);
  if (must(repo, ['rev-parse', 'HEAD']) !== must(repo, ['rev-parse', 'origin/main'])) {
    refuse('main is not the same as origin/main. Pull (or push) first.');
  }
  const want = parseV(version);
  const tags = must(repo, ['tag', '-l', 'v*'])
    .split('\n')
    .map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t.trim()))
    .filter(Boolean)
    .map((m) => parseV(m[1]));
  for (const t of tags) {
    if (cmp(want, t) <= 0) refuse(`Version ${version} is not greater than the existing release v${t.join('.')}.`);
  }
  const previous = tags.length ? `v${tags.sort(cmp).at(-1).join('.')}` : null;
  const signers = join(repo, SIGNERS);
  if (!existsSync(signers)) refuse(`${SIGNERS} is missing.`);
  const signingKey = git(repo, ['config', '--get', 'user.signingkey']).stdout.trim();
  if (!signingKey) refuse('git user.signingkey is not set.');
  const pub = signingPublicKey(repo, signingKey);
  if (!pub) refuse('Cannot read the public key for git user.signingkey.');
  if (!signerKeys(signers).includes(pub)) refuse(`The signing key is not listed in ${SIGNERS}.`);
  const log = join(repo, 'CHANGELOG.md');
  const section = existsSync(log) ? changelogSection(readFileSync(log, 'utf8'), version) : null;
  if (section === null) refuse(`CHANGELOG.md has no section "## ${version}" with content.`);
  return { signingKey, section, previous };
}

/** The tag verified as an installation does, against `signersFile`. */
function verifies(work, tag, signersFile) {
  const v = git(work, [
    '-c', 'gpg.format=ssh',
    '-c', `gpg.ssh.allowedSignersFile=${slash(signersFile)}`,
    '-c', 'gpg.ssh.program=ssh-keygen',
    'verify-tag', '--raw', tag,
  ]);
  return v.code === 0 && GOOD.test(`${v.stdout}\n${v.stderr}`);
}

function release(work, version, signingKey, section, identity, notesDir, previous) {
  const tag = `v${version}`;
  const compose = join(work, 'compose.yaml');
  const composeText = setComposeTags(readFileSync(compose, 'utf8'), version); // refuses before anything is written
  setJsonVersion(join(work, 'app/package.json'), version, false);
  setJsonVersion(join(work, 'app/package-lock.json'), version, true);
  setJsonVersion(join(work, 'app/web/package.json'), version, false);
  writeFileSync(compose, composeText);
  const id = ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];
  must(work, ['add', 'app/package.json', 'app/package-lock.json', 'app/web/package.json', 'compose.yaml']);
  must(work, [...id, 'commit', '-q', '--allow-empty', '-m', `Release ${tag}`]);
  const notes = join(notesDir, 'notes.md');
  writeFileSync(notes, section + '\n');
  must(work, [...id, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${signingKey}`, 'tag', '-s', '--cleanup=verbatim', tag, '-F', notes]);
  // Exactly as an installation verifies it (app/src/updater/git.ts).
  if (!verifies(work, tag, join(work, SIGNERS))) {
    refuse(`The new tag ${tag} does not verify against ${SIGNERS}. Nothing was pushed.`);
  }
  // An installation on the previous release verifies against that release's signers file, never this one's (spec 4.3,
  // final review #7): a release signed only by a key added now would be refused by every installation.
  if (previous) {
    const prev = git(work, ['show', `${previous}:${SIGNERS}`]);
    if (prev.code === 0) {
      const file = join(notesDir, 'previous-signers');
      writeFileSync(file, prev.stdout);
      if (!verifies(work, tag, file)) {
        refuse(
          `The new tag ${tag} does not verify against ${SIGNERS} of ${previous}, which installations on ${previous} trust. ` +
            'Sign it with a key listed there (a new key is added by one release and used from the next). Nothing was pushed.',
        );
      }
    }
  }
  return { tag, notes };
}

function ask(question) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(`${question} `, (a) => {
      answered = true;
      rl.close();
      res(a.trim().toLowerCase());
    });
    rl.on('close', () => {
      if (!answered) res('');
    });
  });
}

async function main(argv) {
  const args = argv.slice(2);
  const dry = args.includes('--dry-run');
  const ci = args.indexOf('--clone-dir');
  const cloneDir = ci === -1 ? null : args[ci + 1];
  const rest = args.filter((a, i) => a !== '--dry-run' && a !== '--clone-dir' && !(ci !== -1 && i === ci + 1));
  if (rest.length !== 1 || !parseV(rest[0]) || (ci !== -1 && !cloneDir)) {
    console.error('Usage: node scripts/release.mjs <X.Y.Z> [--dry-run] [--clone-dir <dir>]');
    return 2;
  }
  const version = rest[0];
  const top = run('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (top.code !== 0) {
    console.error('Run this from inside the Kainow repository.');
    return 2;
  }
  const repo = top.stdout.trim();
  const temp = mkdtempSync(join(tmpdir(), 'kainow-release-'));
  try {
    const { signingKey, section, previous } = checks(repo, version);
    const identity = {
      name: git(repo, ['config', '--get', 'user.name']).stdout.trim() || 'Kainow release',
      email: git(repo, ['config', '--get', 'user.email']).stdout.trim() || 'release@example.org',
    };
    let work = repo;
    if (dry) {
      work = cloneDir ? resolve(cloneDir) : join(temp, 'clone');
      must(repo, ['clone', '-q', '--no-hardlinks', slash(repo), work]);
    }
    const { tag, notes } = release(work, version, signingKey, section, identity, temp, previous);
    console.log(`Made and verified ${tag} in ${work}.`);
    if (dry) {
      console.log('Dry run: nothing was pushed and no GitHub release was created.');
      return 0;
    }
    const answer = await ask(`Push ${tag} to origin and create the GitHub release? (yes/no)`);
    if (answer !== 'yes') {
      console.log(`Not pushed. The commit and tag ${tag} exist only on this PC.`);
      return 1;
    }
    must(repo, ['push', 'origin', 'main', tag]);
    const gh = run('gh', ['release', 'create', tag, '--notes-file', notes], repo, { stdio: ['inherit', 'inherit', 'inherit'] });
    if (gh.code !== 0) {
      console.error(`Pushed, but "gh release create ${tag}" failed. Create the GitHub release by hand.`);
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Refusal ? `Refused: ${e.message}` : `Failed: ${e.message}`);
    return 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv);
