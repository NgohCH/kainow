import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { loadProtectedKey } from '../quarantine/protected-key';
import { DbStorageConnectorFactory, StorageWaitingForKey } from './connector-factory';
import { GraphConnector, SIMPLE_UPLOAD_MAX } from './connectors/graph';
import { quickXorHash } from './quickxor';
import { type DestinationRef, StorageError, type StoredRef } from './types';

/**
 * Real-tenant check of the Microsoft Graph storage connector (spec 15), run by the Product Owner once a tenant exists.
 * Not run in CI. Needs the database (for the saved storage connection and the destination) and the protected key:
 *
 *   DATABASE_URL=... KAINOW_PROTECTED_KEY_FILE=... npm run probe-storage -- --destination "<label>"
 *       [--test-account <a person's address in the tenant>] [--granted write|fullcontrol]
 *
 * `--destination` is the label of a destination added on System Settings › Storage (proposed or approved). The probe
 * works in its own new folder `kainow-probe-<time>` at the destination's root and removes it permanently at the end. It
 * prints one line per check: the token, the destination check, folder creation, a small and a chunked upload, the
 * QuickXorHash Microsoft returns against Kainow's own (this confirms the self-derived vectors of quickxor.test.ts), a
 * move and rename, read and write folder invitations to the test account and their removal, how Microsoft refuses an
 * invitation to an unknown address, how the library's permissions appear (site owners, site collection administrators,
 * a OneDrive owner), permanent deletion, and whether the `write` site permission sufficed for folder invitations
 * (`--granted` says which site permission the Microsoft administrator gave the app). It never prints the client secret
 * or a token: errors are shown as Kainow's storage error codes and HTTP statuses only.
 */

export class ProbeUsageError extends Error {}

/** Every line the probe prints, in order: each check prints exactly one line starting `<check>: `. */
export const PROBE_CHECKS = [
  'token', 'destination', 'folder', 'small upload', 'chunked upload', 'hashes', 'move', 'invite and revoke',
  'unknown account', 'library permissions', 'permanent delete', 'write sufficed', 'permissions needed',
] as const;
type Check = (typeof PROBE_CHECKS)[number];
type Status = 'ok' | 'FAILED' | 'note' | 'not run';

export interface ProbeArgs {
  destination: string;
  testAccount?: string;
  granted?: 'write' | 'fullcontrol';
}

const USAGE =
  'Usage: npm run probe-storage -- --destination "<label>" [--test-account <address in the tenant>] [--granted write|fullcontrol]';
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseProbeArgs(argv: string[]): ProbeArgs {
  const out: Partial<ProbeArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ProbeUsageError(USAGE);
    i++;
    if (flag === '--destination' && value.trim()) out.destination = value.trim();
    else if (flag === '--test-account' && ADDRESS.test(value.trim())) out.testAccount = value.trim();
    else if (flag === '--granted' && (value === 'write' || value === 'fullcontrol')) out.granted = value;
    else throw new ProbeUsageError(USAGE);
  }
  if (!out.destination) throw new ProbeUsageError(USAGE);
  return out as ProbeArgs;
}

/** Storage errors carry fixed text; only the code and status are shown. Anything else is named only by its class. */
function failure(e: unknown): string {
  if (e instanceof StorageError) return `${e.code}${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message}`;
  return `unexpected ${e instanceof Error ? e.name : 'error'}`;
}

/** 6 MiB of a fixed pattern: above the simple-upload limit, so it goes in an upload session of two chunks. */
function chunkedBytes(): Buffer {
  const b = Buffer.alloc(6 * 1024 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + (i >> 9)) & 0xff;
  return b;
}

export interface ProbeOptions {
  testAccount?: string;
  granted?: 'write' | 'fullcontrol';
  log?: (line: string) => void;
}

/**
 * Runs every check against one destination and prints one line each. `ok` is false when any check FAILED (a check
 * that could not run because an earlier one failed, or for want of a test account, counts as failed too).
 */
export async function probeStorage(connector: GraphConnector, dest: DestinationRef, opts: ProbeOptions = {}): Promise<{ ok: boolean }> {
  const log = opts.log ?? console.log;
  let ok = true;
  const line = (check: Check, status: Status, detail: string) => {
    if (status === 'FAILED' || status === 'not run') ok = false;
    log(`${check}: ${status} — ${detail}`);
  };
  let stop = false;
  const step = async (check: Check, needs: boolean, fn: () => Promise<[Status, string]>): Promise<boolean> => {
    if (stop || !needs) {
      line(check, 'not run', stop ? 'an earlier check failed' : 'needs an earlier check that failed or was not run');
      return false;
    }
    try {
      const [status, detail] = await fn();
      line(check, status, detail);
      return status !== 'FAILED';
    } catch (e) {
      line(check, 'FAILED', failure(e));
      return false;
    }
  };

  let folderId = '';
  let small: StoredRef | null = null;
  let big: StoredRef | null = null;
  const smallBytes = Buffer.from('abc'); // the "abc" vector of quickxor.test.ts
  const bigBytes = chunkedBytes();
  /** How the folder invitations went: ok, refused as forbidden (the site permission), or anything else (says nothing about it). */
  let invited: 'ok' | 'forbidden' | 'other' | null = null;

  const tokenOk = await step('token', true, async () => {
    await connector.getItem(dest, dest.rootItemId);
    return ['ok', 'Microsoft issued a token and Graph accepted it for this destination'];
  });
  if (!tokenOk) stop = true;

  await step('destination', true, async () => {
    const c = await connector.checkDestination(dest, opts.testAccount ? { testPerson: opts.testAccount } : {});
    const parts = c.lines.map((l) => `${l.key} ${l.ok ? 'ok' : 'FAILED'} (${l.detail})`);
    const quota = c.quotaBytes === null ? 'quota not reported' : `quota ${c.quotaBytes} bytes, ${c.usedBytes ?? 'unknown'} used`;
    return [c.ok ? 'ok' : 'FAILED', `${parts.join('; ')}; ${quota}`];
  });

  const folderOk = await step('folder', true, async () => {
    const name = `kainow-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    folderId = (await connector.createFolder(dest, null, name)).itemId;
    return ['ok', `created ${name} at the destination root`];
  });

  const smallOk = await step('small upload', folderOk, async () => {
    small = await connector.upload(dest, folderId, 'probe-small.txt', smallBytes, { conflict: 'fail' });
    return [small.size === smallBytes.length ? 'ok' : 'FAILED', `${small.size} bytes confirmed by Microsoft in one request`];
  });

  const bigOk = await step('chunked upload', folderOk, async () => {
    big = await connector.upload(dest, folderId, 'probe-chunked.bin', bigBytes, { conflict: 'fail' });
    const ok2 = big.size === bigBytes.length && bigBytes.length > SIMPLE_UPLOAD_MAX;
    return [ok2 ? 'ok' : 'FAILED', `${big.size} bytes confirmed by Microsoft through an upload session`];
  });

  await step('hashes', smallOk && bigOk, async () => {
    const s = await connector.getItem(dest, small!.itemId);
    const b = await connector.getItem(dest, big!.itemId);
    const mine = { s: quickXorHash(smallBytes), b: quickXorHash(bigBytes) };
    const same = s.providerHash === mine.s && b.providerHash === mine.b && small!.providerHash === mine.s && big!.providerHash === mine.b;
    return same
      ? ['ok', `Microsoft's QuickXorHash equals Kainow's for "abc" (${mine.s}) and the 6 MiB file (${mine.b})`]
      : ['FAILED', `Microsoft returned ${s.providerHash ?? 'no hash'} for "abc" (Kainow: ${mine.s}) and ${b.providerHash ?? 'no hash'} for the 6 MiB file (Kainow: ${mine.b})`];
  });

  await step('move', smallOk, async () => {
    const sub = await connector.createFolder(dest, folderId, 'moved');
    const moved = await connector.move(dest, small!.itemId, sub.itemId, 'probe-small-moved.txt');
    const ok2 = moved.itemId === small!.itemId && moved.parentId === sub.itemId && moved.name === 'probe-small-moved.txt';
    return [ok2 ? 'ok' : 'FAILED', ok2 ? 'moved and renamed within the destination; the item id was kept' : 'the moved item did not come back as expected'];
  });

  await step('invite and revoke', folderOk && !!opts.testAccount, async () => {
    const done: string[] = [];
    for (const role of ['read', 'write'] as const) {
      let g;
      try {
        g = await connector.grant(dest, folderId, opts.testAccount!, role);
      } catch (e) {
        invited = e instanceof StorageError && e.code === 'forbidden' ? 'forbidden' : 'other';
        throw e;
      }
      if (!('permissionId' in g)) {
        invited = 'other';
        return ['FAILED', `${opts.testAccount} could not be given ${role} access: not an account Kainow can share with (directory lookup, or the approved email domains)`];
      }
      const listed = (await connector.listPermissions(dest, folderId)).some((p) => p.id === g.permissionId);
      await connector.revoke(dest, folderId, g.permissionId);
      const gone = !(await connector.listPermissions(dest, folderId)).some((p) => p.id === g.permissionId);
      if (!listed || !gone) {
        invited = 'other';
        return ['FAILED', `the ${role} permission was ${listed ? 'not removed' : 'not listed after the invitation'}`];
      }
      done.push(role);
    }
    invited = 'ok';
    return ['ok', `${done.join(' and ')} folder invitations to ${opts.testAccount} were created, listed and removed`];
  });

  await step('unknown account', folderOk && !!opts.testAccount, async () => {
    const domain = opts.testAccount!.slice(opts.testAccount!.lastIndexOf('@') + 1);
    const nobody = `kainow-probe-nobody-${randomBytes(4).toString('hex')}@${domain}`;
    const r = await connector.probeInvite(dest, folderId, nobody, 'read');
    if (r.permissionId) await connector.revoke(dest, folderId, r.permissionId).catch(() => undefined);
    const what = `Microsoft answered HTTP ${r.status}${r.code ? ` ${r.code}` : ''} to an invitation for an unknown address in ${domain}`;
    return r.status === 404 && r.code !== 'itemNotFound'
      ? ['ok', `${what}; Kainow records it as "Not shared in SharePoint"`]
      : ['FAILED', `${what}; the connector expects 404 (not itemNotFound) here, so its handling of unknown people must be updated`];
  });

  await step('library permissions', tokenOk, async () => {
    const perms = await connector.permissionFacets(dest, dest.rootItemId);
    if (perms.length === 0) return ['note', 'Graph listed no permissions on the destination root'];
    const each = perms.map((p) => `${p.kind} via ${p.facets.join('+') || 'no facet'} roles [${p.roles.join(', ')}] "${p.principal}"`);
    return ['note', `how this destination's root permissions appear (site owners, site collection administrators, a OneDrive owner): ${each.join('; ')}`];
  });

  await step('permanent delete', folderOk, async () => {
    const files = [small, big].filter((f): f is StoredRef => f !== null);
    for (const f of files) await connector.removePermanently(dest, f.itemId);
    for (const f of files) {
      try {
        await connector.getItem(dest, f.itemId);
        return ['FAILED', 'a permanently deleted file can still be read'];
      } catch (e) {
        if (!(e instanceof StorageError && e.code === 'not_found')) throw e;
      }
    }
    await connector.removePermanently(dest, folderId);
    return ['ok', `${files.length} files and the probe folder removed permanently (not to the recycle bin)`];
  });

  await step('write sufficed', true, async () => {
    if (invited === null) return ['not run', 'needs the invitation check (give --test-account)'];
    if (invited === 'other') return ['not run', 'the invitation check failed for another reason, so it shows nothing about the site permission'];
    if (!opts.granted) return ['note', `folder invitations ${invited === 'ok' ? 'worked' : 'were refused as forbidden'} with the site permission the app holds now; say which with --granted write|fullcontrol`];
    if (opts.granted === 'fullcontrol') return ['note', 'not tested: the app holds fullcontrol; run again after the Microsoft administrator grants write only'];
    return invited === 'ok'
      ? ['ok', 'write suffices for folder invitations: the Storage page can ask for write only']
      : ['FAILED', 'write does not suffice for folder invitations: grant fullcontrol on output sites and the source-area site'];
  });

  line(
    'permissions needed',
    'note',
    `application permission Sites.Selected, with ${invited === 'ok' && opts.granted === 'write' ? 'write' : 'fullcontrol (write if the line above says it suffices)'} on each destination's site; User.ReadBasic.All only with directory lookup on`,
  );
  return { ok };
}

async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new ProbeUsageError('Set DATABASE_URL to the Kainow database whose storage connection you want to check.');
  const key = loadProtectedKey(process.env.KAINOW_PROTECTED_KEY_FILE?.trim() || null, (m) => console.error(m));
  if (!key) throw new ProbeUsageError('Set KAINOW_PROTECTED_KEY_FILE to the protected key file: the saved client secret cannot be opened without it.');
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const found = (
      await pool.query<{ id: string; connector: string; status: string }>(
        `SELECT id, connector, status FROM storage_destinations WHERE label = $1 AND status <> 'withdrawn' ORDER BY created_at`,
        [args.destination],
      )
    ).rows;
    if (found.length !== 1) throw new ProbeUsageError(found.length ? 'More than one destination has that label.' : 'No destination has that label (withdrawn ones are left out).');
    if (found[0].connector !== 'graph') throw new ProbeUsageError('The probe checks Microsoft destinations only.');
    const factory = new DbStorageConnectorFactory(pool, () => new Date(), key);
    const { connector, dest } = await factory.forDestination(found[0].id);
    if (!(connector instanceof GraphConnector)) throw new ProbeUsageError('The probe checks Microsoft destinations only.');
    console.log(`destination "${args.destination}" (${found[0].status})`);
    const { ok } = await probeStorage(connector, dest, { testAccount: args.testAccount, granted: args.granted });
    process.exitCode = ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    if (err instanceof ProbeUsageError) console.error(err.message);
    else if (err instanceof StorageWaitingForKey) console.error(err.message);
    else if (err instanceof StorageError) console.error(`The storage connection could not be used: ${failure(err)}`);
    else console.error(`The probe stopped on an unexpected ${err instanceof Error ? err.name : 'error'}.`);
    process.exit(err instanceof ProbeUsageError ? 2 : 1);
  });
}
