/**
 * Throwaway release repositories for the updater's git tests (10b Task 3).
 * Everything lives in one os.tmpdir() folder: a bare "origin", a publisher
 * clone that commits and tags, an "installation" clone that the updater code
 * fetches into, and throwaway ed25519 keys made with `ssh-keygen -N ""`.
 * No real key, ~/.ssh or .env is ever read.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GIT_ENV, git } from '../updater/git';

const slash = (p: string) => p.replace(/\\/g, '/');

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...GIT_ENV }, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        missing: e?.code === 'ENOENT',
      });
    });
  });
}

/** A reason to skip, or null when git and ssh-keygen are both usable. */
export async function gitToolsMissing(): Promise<string | null> {
  const g = await run('git', ['--version']);
  if (g.missing || g.code !== 0) return 'git is not installed or not on PATH';
  const dir = await mkdtemp(join(tmpdir(), 'kainow-sshcheck-'));
  try {
    const k = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'probe', '-f', join(dir, 'k')]);
    if (k.missing) return 'ssh-keygen is not installed or not on PATH';
    if (k.code !== 0) return `ssh-keygen cannot make an ed25519 key: ${k.stderr.trim()}`;
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Key = { priv: string; pub: string; line: string };

async function must(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await git(dir, args, env);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

export type ReleaseRepos = {
  root: string;
  origin: string;
  /** Publisher clone: commits, tags, pushes. */
  pub: string;
  /** Installation clone: the updater's code works here. */
  install: string;
  newKey(name: string): Promise<Key>;
  /** Writes `kainow-release namespaces="git" <key>` lines to a file in root; returns its path. */
  signersFile(name: string, keys: Key[]): Promise<string>;
  signersText(keys: Key[]): string;
  /** Writes files in the publisher clone (paths relative to it), commits, returns the commit SHA. */
  commit(files: Record<string, string>, message?: string): Promise<string>;
  /** Commits app/package.json with that version (and any extra files). */
  release(version: string, extra?: Record<string, string>): Promise<string>;
  /** Annotated tag (signed with `key` when given, unsigned when null), or lightweight. */
  tag(name: string, opts: { key?: Key | null; lightweight?: boolean; message?: string; at?: string }): Promise<void>;
  /** Pushes local tag `local` to origin as refs/tags/<remote> (force). */
  pushTag(local: string, remote?: string): Promise<void>;
  pushMain(): Promise<void>;
  cleanup(): Promise<void>;
};

export async function makeReleaseRepos(): Promise<ReleaseRepos> {
  const root = await mkdtemp(join(tmpdir(), 'kainow-git-'));
  const origin = join(root, 'origin.git');
  const pub = join(root, 'pub');
  const install = join(root, 'install');
  const keys = join(root, 'keys');
  await mkdir(keys);
  await must(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  await must(root, ['init', '-q', '-b', 'main', pub]);
  for (const [k, v] of [
    ['core.autocrlf', 'false'],
    ['user.name', 'Release Test'],
    ['user.email', 'release@example.org'],
    ['gpg.format', 'ssh'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ]) {
    await must(pub, ['config', k, v]);
  }
  await must(pub, ['remote', 'add', 'origin', slash(origin)]);

  const signersText = (ks: Key[]) => ks.map((k) => k.line).join('\n') + '\n';

  const repos: ReleaseRepos = {
    root,
    origin,
    pub,
    install,
    async newKey(name) {
      const priv = join(keys, name);
      const r = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `test-${name}`, '-f', priv]);
      if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
      const pubLine = (await readFile(`${priv}.pub`, 'utf8')).trim().split(/\s+/);
      return { priv: slash(priv), pub: slash(`${priv}.pub`), line: `kainow-release namespaces="git" ${pubLine[0]} ${pubLine[1]}` };
    },
    signersText,
    async signersFile(name, ks) {
      const p = join(root, name);
      await writeFile(p, signersText(ks));
      return p;
    },
    async commit(files, message = 'change') {
      for (const [rel, content] of Object.entries(files)) {
        const p = join(pub, rel);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, content);
      }
      await must(pub, ['add', '-A']);
      await must(pub, ['commit', '-q', '--allow-empty', '-m', message]);
      return must(pub, ['rev-parse', 'HEAD']);
    },
    async release(version, extra = {}) {
      const pkg = JSON.stringify({ name: 'kainow-app', private: true, version }, null, 2) + '\n';
      return repos.commit({ 'app/package.json': pkg, ...extra }, `Release v${version}`);
    },
    async tag(name, opts) {
      const at = opts.at ?? 'HEAD';
      if (opts.lightweight) {
        await must(pub, ['tag', '-f', name, at]);
        return;
      }
      const msg = opts.message ?? `Notes for ${name}\n\n- one change`;
      if (opts.key) {
        await must(pub, ['-c', `user.signingkey=${opts.key.priv}`, 'tag', '-f', '-s', name, '-m', msg, at]);
      } else {
        await must(pub, ['tag', '-f', '-a', name, '-m', msg, at]);
      }
    },
    async pushTag(local, remote = local) {
      await must(pub, ['push', '-q', '-f', 'origin', `refs/tags/${local}:refs/tags/${remote}`]);
    },
    async pushMain() {
      await must(pub, ['push', '-q', '-f', 'origin', 'main']);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };

  // A first commit on main so the installation has something to clone.
  await repos.commit({ 'README.md': 'kainow\n', 'compose.yaml': 'services: {}\n' }, 'initial');
  await repos.pushMain();
  await must(root, ['clone', '-q', '-c', 'core.autocrlf=false', slash(origin), install]);
  return repos;
}
