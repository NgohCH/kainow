/**
 * Git fetch, release-tag signature verification and key rotation (10b spec 4.3, 5.3, 8).
 *
 * The updater installs only a release whose annotated tag is SSH-signed by a key
 * listed for the principal `kainow-release` in the installation's trusted signers
 * file (the running release's copy, never the candidate's). After a candidate has
 * verified, `signersAt` gives the caller the candidate's own file so it can replace
 * the trusted one (rotation).
 *
 * git is always run with spawn (never a shell), no global or system config, no
 * terminal prompts and a 2-minute timeout.
 */
import { runProcess } from './process';
import { compareVersions, isNewer, parseTag, versionString } from './version';

export const SIGNING_PRINCIPAL = 'kainow-release';
export const SIGNING_NAMESPACE = 'git';
const GIT_TIMEOUT_MS = 2 * 60_000;
const SIGNERS_PATH = 'release/release-signers';

/**
 * Environment for every git call: no global or system config (so nothing on the
 * host can change signature handling), no prompts, and gpg.format=ssh.
 * The allowed-signers file is passed per call (`-c gpg.ssh.allowedSignersFile=…`).
 */
export const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'gpg.format',
  GIT_CONFIG_VALUE_0: 'ssh',
});

export type GitResult = { code: number; stdout: string; stderr: string };

/**
 * Runs `git <args>` in `dir`. Never throws: a failure to start is code 127, a timeout code 124 (default 2 minutes;
 * the whole process tree is killed, helpers included), output over 64 MB code 125.
 */
export function git(dir: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitResult> {
  return runProcess('git', args, { cwd: dir, env: gitEnv(env), timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

const withoutGitVars = (env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => !/^GIT_/i.test(k)));

/**
 * The environment of a git call (final review #5): no GIT_* variable from the updater's own environment or the caller
 * (they could point git at another config, object store or signature program), and GIT_ENV last, so it always wins.
 */
export function gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...withoutGitVars(process.env), ...withoutGitVars(env), ...GIT_ENV };
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // SHA-1 or SHA-256
const isObjectId = (s: string) => OBJECT_ID.test(s);

const candidateRef = (tag: string) => `refs/kainow/candidate/${tag}`;

/**
 * Step 1: fetches `refs/tags/<tag>` from origin into the private ref
 * `refs/kainow/candidate/<tag>` (forced, so a moved tag is seen and then caught by
 * the commit and tag-object comparisons) and returns the fetched object's id.
 */
export async function fetchCandidate(
  repoDir: string,
  tag: string,
): Promise<{ ok: true; tagObject: string } | { ok: false; code: 'fetch_failed' }> {
  if (!parseTag(tag)) return { ok: false, code: 'fetch_failed' };
  const f = await git(repoDir, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/tags/${tag}:${candidateRef(tag)}`]);
  if (f.code !== 0) return { ok: false, code: 'fetch_failed' };
  const r = await git(repoDir, ['rev-parse', '--verify', '--quiet', `${candidateRef(tag)}^{object}`]);
  const id = r.stdout.trim();
  if (r.code !== 0 || !isObjectId(id)) return { ok: false, code: 'fetch_failed' };
  return { ok: true, tagObject: id };
}

export type VerifyCode = 'not_annotated' | 'tag_name_mismatch' | 'signature_invalid' | 'commit_mismatch' | 'version_mismatch' | 'not_newer';

type TagObject = { object: string; type: string; tag: string; message: string; signature: string | null };

const SSH_SIG_BEGIN = '-----BEGIN SSH SIGNATURE-----';
const SIG_BEGIN_ALL = /^-----BEGIN (SSH|PGP) SIGNATURE-----$/gm;

function parseTagObject(raw: string): TagObject | null {
  const split = raw.indexOf('\n\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split + 2);
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const k = line.slice(0, sp);
    if (!headers.has(k)) headers.set(k, line.slice(sp + 1));
  }
  const object = headers.get('object');
  const type = headers.get('type');
  const tag = headers.get('tag');
  if (!object || !type || tag === undefined) return null;
  // The signature is the last block (final review #4): a marker line quoted inside the notes must not cut them short.
  let m: RegExpMatchArray | null = null;
  for (const x of body.matchAll(SIG_BEGIN_ALL)) m = x;
  const message = (m ? body.slice(0, m.index) : body).replace(/\s+$/, '');
  const signature = m ? body.slice(m.index) : null;
  return { object, type, tag, message, signature };
}

/** ssh-keygen's success line for our principal and namespace, as git prints it with --raw. */
const GOOD_SIGNATURE = new RegExp(`^Good "${SIGNING_NAMESPACE}" signature for ${SIGNING_PRINCIPAL} with \\S+ key \\S+`, 'm');

/**
 * Steps 2–5: the fetched object must be an annotated tag named `tag`, SSH-signed by
 * `kainow-release` per `signersFile` (the installation's trusted file), pointing at
 * the approved commit, whose app/package.json carries the tag's version, which must
 * be newer than the running one. `notes` is the tag message without its signature.
 */
export async function verifyCandidate(
  repoDir: string,
  tag: string,
  tagObject: string,
  signersFile: string,
  expect: { commit: string; runningVersion: string },
): Promise<{ ok: true; commit: string; notes: string } | { ok: false; code: VerifyCode }> {
  const version = parseTag(tag);
  if (!version) return { ok: false, code: 'tag_name_mismatch' };
  if (!isObjectId(tagObject)) return { ok: false, code: 'not_annotated' };

  // Step 2: an annotated tag object whose internal name is the tag.
  const type = await git(repoDir, ['cat-file', '-t', tagObject]);
  if (type.code !== 0 || type.stdout.trim() !== 'tag') return { ok: false, code: 'not_annotated' };
  const raw = await git(repoDir, ['cat-file', 'tag', tagObject]);
  const parsed = raw.code === 0 ? parseTagObject(raw.stdout) : null;
  if (!parsed) return { ok: false, code: 'not_annotated' };
  if (parsed.tag !== tag) return { ok: false, code: 'tag_name_mismatch' };

  // Step 3: an SSH signature (never PGP) good for kainow-release in the trusted file.
  if (!parsed.signature || !parsed.signature.startsWith(SSH_SIG_BEGIN)) return { ok: false, code: 'signature_invalid' };
  const allowed = signersFile.replace(/\\/g, '/');
  const v = await git(repoDir, [
    '-c', 'gpg.format=ssh',
    '-c', `gpg.ssh.allowedSignersFile=${allowed}`,
    '-c', 'gpg.ssh.program=ssh-keygen',
    'verify-tag', '--raw', tagObject,
  ]);
  if (v.code !== 0 || !GOOD_SIGNATURE.test(`${v.stdout}\n${v.stderr}`)) return { ok: false, code: 'signature_invalid' };

  // Step 4: the approved commit.
  const commit = parsed.object.toLowerCase();
  if (parsed.type !== 'commit' || !isObjectId(commit) || commit !== expect.commit.trim().toLowerCase()) {
    return { ok: false, code: 'commit_mismatch' };
  }

  // Step 5: the release's version, and newer than the running one.
  const pkg = await git(repoDir, ['show', `${commit}:app/package.json`]);
  let pkgVersion: unknown;
  try {
    pkgVersion = pkg.code === 0 ? (JSON.parse(pkg.stdout) as { version?: unknown }).version : undefined;
  } catch {
    pkgVersion = undefined;
  }
  if (pkgVersion !== versionString(version)) return { ok: false, code: 'version_mismatch' };
  if (!isNewer(tag, expect.runningVersion)) return { ok: false, code: 'not_newer' };

  return { ok: true, commit, notes: parsed.message };
}

/** The content of release/release-signers at `commit`, or null when absent (or `commit` is not a commit). */
export async function signersAt(repoDir: string, commit: string): Promise<string | null> {
  const c = commit.trim().toLowerCase();
  if (!isObjectId(c)) return null;
  const type = await git(repoDir, ['cat-file', '-t', c]);
  if (type.code !== 0 || type.stdout.trim() !== 'commit') return null;
  const r = await git(repoDir, ['show', `${c}:${SIGNERS_PATH}`]);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Tracked changes only (untracked files such as .env are ignored), and the release
 * tag at HEAD when there is exactly-matching one (the highest, if several).
 */
export async function workingTreeState(repoDir: string): Promise<{ clean: boolean; changed: string[]; headTag: string | null }> {
  const s = await git(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']);
  if (s.code !== 0) throw new Error(`git status failed (${s.code})`);
  const entries = s.stdout.split('\0');
  const changed: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    changed.push(e.slice(3));
    if (xy.includes('R') || xy.includes('C')) i++; // the next entry is the original path
  }
  changed.sort();

  const t = await git(repoDir, ['tag', '--points-at', 'HEAD']);
  const tags = t.code === 0 ? t.stdout.split('\n').map((x) => x.trim()).filter((x) => parseTag(x)) : [];
  tags.sort((a, b) => compareVersions(parseTag(b)!, parseTag(a)!));
  return { clean: changed.length === 0, changed, headTag: tags[0] ?? null };
}
