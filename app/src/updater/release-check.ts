/**
 * Release checks (10b spec 6.2, D120): read GitHub's tags list, keep valid release tags newer than the running version,
 * record the result and tell the Enterprise Administrators once per tag. Reads only; nothing is downloaded or installed.
 * What it learns is unverified (a tag name and a commit); the signature is checked before installing.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '../common/uuid7';
import { notifyAdmins } from '../ops/notify';
import { auditReleaseAvailable } from './audit';
import { compareVersions, isNewer, parseTag } from './version';

export type FailureCode = 'unreachable' | 'bad_response' | 'rate_limited';
export type CheckResult = {
  outcome: 'found' | 'none_newer' | 'failed';
  newest?: { tag: string; commit: string };
  failureCode?: FailureCode;
};

export interface CheckDeps {
  pool: Pool;
  fetch: typeof fetch;
  repo: string;
  api: string;
  runningVersion: string;
  now: Date;
}

export const CHECK_TIMEOUT_MS = 10_000;
export const USER_AGENT = 'kainow-update-check';
/** Three days without a successful check shows a warning (spec 6.2). */
export const STALE_AFTER_MS = 3 * 86_400_000;
const LINK = '#/admin/operations';
const COMMIT = /^[0-9a-f]{40}$/;

type Fetched = { ok: true; tags: Array<{ tag: string; commit: string }> } | { ok: false; code: FailureCode };

async function fetchTags(deps: CheckDeps): Promise<Fetched> {
  const url = `${deps.api.replace(/\/+$/, '')}/repos/${deps.repo}/tags?per_page=100`;
  let res: Response;
  try {
    res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch {
    return { ok: false, code: 'unreachable' };
  }
  const limited =
    res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
  if (limited) return { ok: false, code: 'rate_limited' };
  if (!res.ok) return { ok: false, code: 'bad_response' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: 'bad_response' };
  }
  if (!Array.isArray(body)) return { ok: false, code: 'bad_response' };
  const tags: Array<{ tag: string; commit: string }> = [];
  for (const item of body as Array<{ name?: unknown; commit?: { sha?: unknown } }>) {
    const name = item?.name;
    const sha = item?.commit?.sha;
    if (typeof name === 'string' && typeof sha === 'string' && COMMIT.test(sha)) tags.push({ tag: name, commit: sha });
  }
  return { ok: true, tags };
}

const byNewest = (a: { tag: string }, b: { tag: string }): number =>
  compareVersions(parseTag(b.tag) as ReturnType<typeof parseTag> & object, parseTag(a.tag) as ReturnType<typeof parseTag> & object) ||
  (a.tag < b.tag ? -1 : 1);

export async function checkReleases(deps: CheckDeps, trigger: 'daily' | 'manual', actorId?: string): Promise<CheckResult> {
  const fetched = await fetchTags(deps);
  const { pool, now } = deps;
  let result: CheckResult;
  if (!fetched.ok) {
    result = { outcome: 'failed', failureCode: fetched.code };
  } else {
    const newer = fetched.tags.filter((t) => isNewer(t.tag, deps.runningVersion)).sort(byNewest);
    result = newer.length > 0 ? { outcome: 'found', newest: newer[0] } : { outcome: 'none_newer' };
  }

  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO release_checks (id, at, trigger, actor_id, outcome, failure_code, newest_tag, newest_commit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv7(now.getTime()), now, trigger, actorId ?? null, result.outcome, result.failureCode ?? null, result.newest?.tag ?? null, result.newest?.commit ?? null],
      );
      if (result.newest) {
        const first = await client.query(
          `INSERT INTO releases_seen (tag, commit, first_seen_at, notified_at) VALUES ($1, $2, $3, $3)
           ON CONFLICT (tag) DO NOTHING RETURNING tag`,
          [result.newest.tag, result.newest.commit, now],
        );
        if (first.rowCount === 1) {
          await auditReleaseAvailable(client, { at: now, actorUserId: actorId ?? null, subjectType: 'release', detail: { tag: result.newest.tag } });
          await notifyAdmins(client, {
            kind: 'release_available',
            summary: `Kainow ${result.newest.tag} is available. Review it on the Operations page.`,
            link: LINK,
            now,
            urgent: true,
          });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => (broken = true));
      throw err;
    }
  } finally {
    client.release(broken);
  }
  return result;
}

export type LatestCheck = {
  latest: {
    at: Date;
    trigger: 'daily' | 'manual';
    outcome: CheckResult['outcome'];
    failureCode: FailureCode | null;
    newestTag: string | null;
    newestCommit: string | null;
  } | null;
  lastSuccessAt: Date | null;
  /** Three days without a successful check, once checking has been going on that long. */
  stale: boolean;
};

export async function latestCheck(pool: Pool, now: Date = new Date()): Promise<LatestCheck> {
  const latest = (
    await pool.query(
      `SELECT at, trigger, outcome, failure_code AS "failureCode", newest_tag AS "newestTag", newest_commit AS "newestCommit"
         FROM release_checks ORDER BY at DESC, id DESC LIMIT 1`,
    )
  ).rows[0] as LatestCheck['latest'] | undefined;
  if (!latest) return { latest: null, lastSuccessAt: null, stale: false };
  const s = (
    await pool.query(`SELECT max(at) FILTER (WHERE outcome <> 'failed') AS "lastSuccessAt", min(at) AS "firstAt" FROM release_checks`)
  ).rows[0] as { lastSuccessAt: Date | null; firstAt: Date };
  const since = s.lastSuccessAt ?? s.firstAt;
  return { latest, lastSuccessAt: s.lastSuccessAt, stale: now.getTime() - since.getTime() >= STALE_AFTER_MS };
}

/** The newest release any check has found that is newer than the running version. */
export async function newestAvailable(pool: Pool, runningVersion: string): Promise<{ tag: string; commit: string; firstSeenAt: Date } | null> {
  const rows = (await pool.query(`SELECT tag, commit, first_seen_at AS "firstSeenAt" FROM releases_seen ORDER BY first_seen_at, tag`)).rows as Array<{
    tag: string;
    commit: string;
    firstSeenAt: Date;
  }>;
  return rows.filter((r) => isNewer(r.tag, runningVersion)).sort(byNewest)[0] ?? null;
}
