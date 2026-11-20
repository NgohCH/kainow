import { randomUUID } from 'node:crypto';
import type { StorageConnector } from '../connector';
import { quickXorHash } from '../quickxor';
import {
  StorageError, type DestinationCheck, type DestinationRef, type FolderRef, type GrantResult,
  type ItemState, type ItemVersion, type PermissionInfo, type StoredRef,
} from '../types';

// Microsoft Graph (SharePoint libraries and OneDrive) behind the storage connector contract (spec §5.3).
// Every request goes through call(), which maps statuses and network failures to StorageError and never reads
// a response body into an error. Paths are reported "/"-separated from the destination root.

const MiB = 1024 * 1024;
/** Files up to this size go in one PUT; larger ones use an upload session. */
export const SIMPLE_UPLOAD_MAX = 4 * MiB;
/** Upload-session chunk: 16 × 320 KiB (Graph requires chunks to be multiples of 320 KiB). */
export const UPLOAD_CHUNK = 16 * 320 * 1024;
const ITEM_SELECT = 'id,name,size,file,folder,root,eTag,cTag,parentReference,webUrl';
const FAIL = '@microsoft.graph.conflictBehavior';
const COPY_DEADLINE_MS = 10 * 60_000;
const CHECK_FOLDER = '.kainow-check';

interface GraphItem {
  id: string; name: string; size?: number; eTag?: string; cTag?: string; webUrl?: string;
  file?: { hashes?: { quickXorHash?: string } }; folder?: object; root?: object;
  parentReference?: { id?: string; driveId?: string; path?: string };
}
interface GraphIdentity { id?: string; displayName?: string; email?: string; loginName?: string }
interface GraphPermission {
  id: string; roles?: string[];
  link?: { scope?: string; type?: string };
  grantedToV2?: { user?: GraphIdentity; group?: GraphIdentity; siteGroup?: GraphIdentity; siteUser?: GraphIdentity; application?: GraphIdentity };
  grantedTo?: { user?: GraphIdentity; application?: GraphIdentity };
  invitation?: { email?: string };
}

interface CallOpts {
  body?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** false for pre-authenticated URLs (upload sessions, copy monitors), which must not carry the token. */
  auth?: boolean;
  read?: 'json' | 'bytes' | 'none';
  /** Error statuses returned to the caller instead of thrown. */
  allow?: number[];
}
interface Reply { status: number; headers: Headers; json: any; bytes: Buffer | null }

export interface GraphConnectorOptions {
  fetchFn?: typeof fetch;
  graphBase?: string;
  /** Directory lookup (D102): when off, no /users calls are made and sharing is limited to allowedDomains. */
  lookup: boolean;
  /** The organisation's approved email domains. */
  allowedDomains: () => Promise<string[]>;
  callTimeoutMs?: number;
  chunkTimeoutMs?: number;
}

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get('retry-after');
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function statusError(status: number, headers: Headers): StorageError {
  const retry = status === 429 || status === 503 ? retryAfterMs(headers) : undefined;
  const opts = { status, retryAfterMs: retry };
  if (status === 401) return new StorageError('unauthorised', opts);
  if (status === 403) return new StorageError('forbidden', opts);
  if (status === 404 || status === 410) return new StorageError('not_found', opts);
  if (status === 409 || status === 412) return new StorageError('conflict', opts);
  if (status === 413) return new StorageError('too_large', opts);
  if (status === 429) return new StorageError('throttled', opts);
  if (status === 507) return new StorageError('quota', opts);
  if (status >= 500) return new StorageError('server', opts);
  return new StorageError('invalid', opts);
}

/** A failure before or while reading a reply: our own deadline is a timeout, anything else is unreachable. */
function networkError(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const name = (e as { name?: string } | null)?.name;
  return new StorageError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable');
}

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0]/.test(name)) throw new StorageError('invalid');
}

export class GraphConnector implements StorageConnector {
  readonly kind = 'graph' as const;
  private readonly fetchFn: typeof fetch;
  private readonly graphBase: string;
  private readonly callTimeoutMs: number;
  private readonly chunkTimeoutMs: number;
  /** Drive-relative path of each destination root ('' for a drive root). */
  private readonly rootPaths = new Map<string, string>();

  constructor(private readonly tokens: { token(): Promise<string> }, private readonly opts: GraphConnectorOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.graphBase = (opts.graphBase ?? 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    this.chunkTimeoutMs = opts.chunkTimeoutMs ?? 120_000;
  }

  // ---- transport ----
  private async bearer(): Promise<string> {
    try {
      return await this.tokens.token();
    } catch (e) {
      // M365TokenSource throws TokenError with the HTTP status (0 when Microsoft could not be reached)
      const status = (e as { status?: unknown } | null)?.status;
      if (status === 0) throw new StorageError('unreachable');
      if (status === 400 || status === 401) throw new StorageError('unauthorised', { status });
      if (typeof status === 'number') throw statusError(status, new Headers());
      throw new StorageError('unreachable');
    }
  }

  private async call(method: string, pathOrUrl: string, o: CallOpts = {}): Promise<Reply> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.graphBase}${pathOrUrl}`;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.auth !== false) headers.Authorization = `Bearer ${await this.bearer()}`;
    let body: BodyInit | undefined;
    if (o.bytes) {
      headers['Content-Type'] ??= 'application/octet-stream';
      body = o.bytes as unknown as BodyInit;
    } else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    const signal = AbortSignal.timeout(o.timeoutMs ?? this.callTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body, signal });
    } catch (e) {
      throw networkError(e);
    }
    const allowed = o.allow?.includes(res.status) ?? false;
    if (!res.ok && !allowed) {
      await res.body?.cancel().catch(() => undefined);
      throw statusError(res.status, res.headers);
    }
    try {
      if (!res.ok || (o.read ?? 'json') === 'json') {
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { if (res.ok) throw new StorageError('server', { status: res.status }); }
        return { status: res.status, headers: res.headers, json, bytes: null };
      }
      if (o.read === 'bytes') return { status: res.status, headers: res.headers, json: null, bytes: Buffer.from(await res.arrayBuffer()) };
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, headers: res.headers, json: null, bytes: null };
    } catch (e) {
      throw networkError(e);
    }
  }

  /** Every page of a collection (follows @odata.nextLink). */
  private async listAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let next: string | undefined = path; next;) {
      const r = await this.call('GET', next);
      if (!Array.isArray(r.json?.value)) throw new StorageError('server', { status: r.status });
      out.push(...(r.json.value as T[]));
      next = typeof r.json['@odata.nextLink'] === 'string' ? r.json['@odata.nextLink'] : undefined;
    }
    return out;
  }

  private drive(driveId: string): string { return `/drives/${enc(driveId)}`; }
  private itemPath(dest: DestinationRef, itemId: string): string { return `${this.drive(dest.driveId)}/items/${enc(itemId)}`; }
  private childPath(dest: DestinationRef, folderId: string, name: string): string { return `${this.itemPath(dest, folderId)}:/${enc(name)}`; }

  private item(json: any, status: number): GraphItem {
    if (!json || typeof json.id !== 'string' || typeof json.name !== 'string') throw new StorageError('server', { status });
    return json as GraphItem;
  }

  private async getRaw(dest: DestinationRef, itemId: string): Promise<GraphItem> {
    const r = await this.call('GET', `${this.itemPath(dest, itemId)}?$select=${ITEM_SELECT}`);
    return this.item(r.json, r.status);
  }

  /** The item's path from the drive root, decoded ('' for the root itself). */
  private drivePath(g: GraphItem): string {
    if (g.root) return '';
    const p = g.parentReference?.path ?? '';
    const i = p.indexOf('root:');
    const parent = i >= 0 ? p.slice(i + 'root:'.length) : '';
    return `${parent.split('/').map(safeDecode).join('/')}/${g.name}`;
  }

  private async rootPath(dest: DestinationRef): Promise<string> {
    const key = `${dest.driveId}/${dest.rootItemId}`;
    let p = this.rootPaths.get(key);
    if (p === undefined) {
      p = this.drivePath(await this.getRaw(dest, dest.rootItemId));
      this.rootPaths.set(key, p);
    }
    return p;
  }

  private async toRef(dest: DestinationRef, g: GraphItem): Promise<StoredRef> {
    const prefix = await this.rootPath(dest);
    const full = this.drivePath(g);
    let path: string;
    if (full === prefix) path = '/';
    else if (prefix === '') path = full;
    else path = full.startsWith(`${prefix}/`) ? full.slice(prefix.length) : full;
    return {
      itemId: g.id, parentId: g.parentReference?.id ?? '', name: g.name, path,
      size: typeof g.size === 'number' ? g.size : 0,
      providerHash: g.file?.hashes?.quickXorHash ?? null,
      etag: g.eTag ?? null, ctag: g.cTag ?? null, webUrl: g.webUrl ?? null,
    };
  }

  // ---- resolving destinations (used when an Administrator adds one) ----
  async resolveSharePointLibrary(siteUrl: string, libraryName: string): Promise<{ siteId: string; driveId: string; rootItemId: string }> {
    let u: URL;
    try { u = new URL(siteUrl); } catch { throw new StorageError('invalid'); }
    if (u.protocol !== 'https:' || !libraryName.trim()) throw new StorageError('invalid');
    const sitePath = u.pathname.replace(/\/+$/, '');
    const segs = sitePath.split('/').filter(Boolean).map((s) => enc(safeDecode(s))).join('/');
    const site = await this.call('GET', segs ? `/sites/${enc(u.hostname)}:/${segs}?$select=id` : `/sites/${enc(u.hostname)}?$select=id`);
    if (typeof site.json?.id !== 'string') throw new StorageError('server', { status: site.status });
    const drives = await this.listAll<{ id: string; name?: string; webUrl?: string }>(`/sites/${enc(site.json.id)}/drives?$select=id,name,webUrl`);
    const want = libraryName.trim().toLowerCase();
    const lastSeg = (w?: string) => (w ? safeDecode(w.replace(/\/+$/, '').split('/').pop() ?? '').toLowerCase() : '');
    const d = drives.find((x) => x.name?.toLowerCase() === want) ?? drives.find((x) => lastSeg(x.webUrl) === want);
    if (!d) throw new StorageError('not_found');
    const root = await this.call('GET', `${this.drive(d.id)}/root?$select=id`);
    if (typeof root.json?.id !== 'string') throw new StorageError('server', { status: root.status });
    return { siteId: site.json.id, driveId: d.id, rootItemId: root.json.id };
  }

  /** A named account's OneDrive (needs directory lookup), optionally a folder in it. */
  async resolveOneDrive(email: string, folderPath?: string): Promise<{ driveId: string; rootItemId: string }> {
    if (!this.opts.lookup) throw new StorageError('unsupported');
    const d = await this.call('GET', `/users/${enc(email.trim())}/drive?$select=id`);
    if (typeof d.json?.id !== 'string') throw new StorageError('server', { status: d.status });
    const segs = (folderPath ?? '').split('/').filter(Boolean);
    const r = await this.call('GET', segs.length
      ? `${this.drive(d.json.id)}/root:/${segs.map(enc).join('/')}?$select=id,folder`
      : `${this.drive(d.json.id)}/root?$select=id`);
    if (typeof r.json?.id !== 'string') throw new StorageError('server', { status: r.status });
    if (segs.length && !r.json.folder) throw new StorageError('invalid');
    return { driveId: d.json.id, rootItemId: r.json.id };
  }

  // ---- contract ----
  async checkDestination(dest: DestinationRef): Promise<DestinationCheck> {
    const lines: DestinationCheck['lines'] = [];
    let quotaBytes: number | null = null;
    let usedBytes: number | null = null;
    let others: PermissionInfo[] = [];
    let failed = false;
    const step = async (key: DestinationCheck['lines'][number]['key'], fn: () => Promise<{ ok: boolean; detail: string }>) => {
      if (failed) { lines.push({ key, ok: false, detail: 'Not checked' }); return; }
      try {
        const r = await fn();
        lines.push({ key, ...r });
      } catch (e) {
        failed = key !== 'library_permissions' && key !== 'sharing_capability';
        lines.push({ key, ok: false, detail: e instanceof StorageError ? e.message : 'The check failed.' });
      }
    };
    let folderId = '';
    let probeId = '';
    await step('reachable', async () => {
      const d = await this.call('GET', `${this.drive(dest.driveId)}?$select=id,quota`);
      quotaBytes = typeof d.json?.quota?.total === 'number' ? d.json.quota.total : null;
      usedBytes = typeof d.json?.quota?.used === 'number' ? d.json.quota.used : null;
      await this.getRaw(dest, dest.rootItemId);
      return { ok: true, detail: 'Reached the library' };
    });
    await step('folder', async () => {
      folderId = (await this.ensureFolder(dest, null, CHECK_FOLDER)).itemId;
      return { ok: true, detail: 'Can create a folder' };
    });
    await step('upload', async () => {
      const bytes = Buffer.from('k');
      const ref = await this.upload(dest, folderId, `check-${randomUUID()}.txt`, bytes, { conflict: 'fail' });
      probeId = ref.itemId;
      const ok = ref.size === 1 && ref.providerHash === quickXorHash(bytes);
      return { ok, detail: ok ? 'Can upload a file' : 'The uploaded test file did not match' };
    });
    await step('delete', async () => {
      await this.removePermanently(dest, probeId);
      return { ok: true, detail: 'Can permanently delete a file' };
    });
    await step('permissions', async () => {
      await this.listPermissions(dest, folderId);
      return { ok: true, detail: 'Can list folder permissions' };
    });
    await step('library_permissions', async () => {
      const perms = await this.listPermissions(dest, dest.rootItemId);
      others = perms.filter((p) => p.kind !== 'owner_group' && p.kind !== 'site_admin' && p.kind !== 'app');
      return others.length
        ? { ok: false, detail: `Others can open everything in this library: ${others.map((p) => p.principal).join(', ')}. Limit the library to site owners before approving it.` }
        : { ok: true, detail: 'Only site owners and administrators can open the library' };
    });
    await step('sharing_capability', async () => ({
      ok: true,
      detail: "Microsoft Graph does not report this site's sharing setting; the tenant should block guest sharing on it.",
    }));
    return { ok: lines.every((l) => l.ok), lines, quotaBytes, usedBytes, others };
  }

  async ensureFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef> {
    checkName(name);
    const pid = parentId ?? dest.rootItemId;
    const r = await this.call('POST', `${this.itemPath(dest, pid)}/children`, {
      body: { name, folder: {}, [FAIL]: 'fail' }, allow: [409],
    });
    if (r.status !== 409) {
      const g = this.item(r.json, r.status);
      return { itemId: g.id, name: g.name };
    }
    const existing = await this.findRaw(dest, pid, name);
    if (!existing || !existing.folder) throw new StorageError('conflict', { status: 409 });
    return { itemId: existing.id, name: existing.name };
  }

  async upload(dest: DestinationRef, folderId: string, name: string, bytes: Buffer, opts: { conflict: 'fail' }): Promise<StoredRef> {
    if (opts.conflict !== 'fail') throw new StorageError('invalid');
    checkName(name);
    let g: GraphItem;
    if (bytes.length <= SIMPLE_UPLOAD_MAX) {
      const r = await this.call('PUT', `${this.childPath(dest, folderId, name)}:/content?${FAIL}=fail`, { bytes });
      g = this.item(r.json, r.status);
    } else {
      g = await this.uploadSession(dest, folderId, name, bytes);
    }
    // the provider may compute hashes after replying; ask again once before reporting none
    if (!g.file?.hashes?.quickXorHash) g = await this.getRaw(dest, g.id);
    return this.toRef(dest, g);
  }

  private async uploadSession(dest: DestinationRef, folderId: string, name: string, bytes: Buffer): Promise<GraphItem> {
    const s = await this.call('POST', `${this.childPath(dest, folderId, name)}:/createUploadSession`, {
      body: { item: { [FAIL]: 'fail' } },
    });
    const uploadUrl = s.json?.uploadUrl;
    if (typeof uploadUrl !== 'string' || !/^https?:\/\//.test(uploadUrl)) throw new StorageError('server', { status: s.status });
    const total = bytes.length;
    const maxRounds = Math.ceil(total / UPLOAD_CHUNK) * 2 + 2;
    try {
      let next = 0;
      for (let round = 0; round < maxRounds; round++) {
        const end = Math.min(next + UPLOAD_CHUNK, total);
        const r = await this.call('PUT', uploadUrl, {
          bytes: bytes.subarray(next, end), auth: false, timeoutMs: this.chunkTimeoutMs,
          headers: { 'Content-Range': `bytes ${next}-${end - 1}/${total}` },
        });
        if (r.status === 200 || r.status === 201) return this.item(r.json, r.status);
        const range = Array.isArray(r.json?.nextExpectedRanges) ? String(r.json.nextExpectedRanges[0] ?? '') : '';
        const m = /^(\d+)-/.exec(range);
        if (!m || Number(m[1]) >= total) throw new StorageError('server', { status: r.status });
        next = Number(m[1]);
      }
      throw new StorageError('server');
    } catch (e) {
      // best effort: an abandoned session holds nothing once cancelled (a completed one is already gone)
      await this.call('DELETE', uploadUrl, { auth: false, read: 'none' }).catch(() => undefined);
      throw e;
    }
  }

  private async findRaw(dest: DestinationRef, folderId: string, name: string): Promise<GraphItem | null> {
    const r = await this.call('GET', `${this.childPath(dest, folderId, name)}?$select=${ITEM_SELECT}`, { allow: [404] });
    return r.status === 404 ? null : this.item(r.json, r.status);
  }

  async findChild(dest: DestinationRef, folderId: string, name: string): Promise<StoredRef | null> {
    checkName(name);
    const g = await this.findRaw(dest, folderId, name);
    return g ? this.toRef(dest, g) : null;
  }

  async getItem(dest: DestinationRef, itemId: string): Promise<ItemState> {
    return this.toRef(dest, await this.getRaw(dest, itemId));
  }

  async download(dest: DestinationRef, itemId: string): Promise<Buffer> {
    const r = await this.call('GET', `${this.itemPath(dest, itemId)}/content`, { read: 'bytes', timeoutMs: this.chunkTimeoutMs });
    return r.bytes ?? Buffer.alloc(0);
  }

  async move(dest: DestinationRef, itemId: string, newParentId: string, newName?: string): Promise<StoredRef> {
    if (newName !== undefined) checkName(newName);
    const body: Record<string, unknown> = { parentReference: { id: newParentId } };
    if (newName !== undefined) body.name = newName;
    const r = await this.call('PATCH', `${this.itemPath(dest, itemId)}?${FAIL}=fail`, { body });
    return this.toRef(dest, this.item(r.json, r.status));
  }

  async copyTo(src: DestinationRef, itemId: string, dst: DestinationRef, folderId: string, name: string): Promise<StoredRef> {
    checkName(name);
    const r = await this.call('POST', `${this.itemPath(src, itemId)}/copy?${FAIL}=fail`, {
      body: { parentReference: { driveId: dst.driveId, id: folderId }, name }, read: 'none',
    });
    const monitor = r.headers.get('location');
    if (r.status !== 202 || !monitor || !/^https?:\/\//.test(monitor)) throw new StorageError('server', { status: r.status });
    const deadline = Date.now() + COPY_DEADLINE_MS;
    for (let wait = 200; ; wait = Math.min(wait * 2, 5_000)) {
      const p = await this.call('GET', monitor, { auth: false });
      const status = p.json?.status;
      if (status === 'completed' && typeof p.json.resourceId === 'string') return this.getItem(dst, p.json.resourceId);
      if (status === 'failed') {
        throw new StorageError(p.json?.error?.code === 'nameAlreadyExists' ? 'conflict' : 'server', { status: p.status });
      }
      if (Date.now() + wait > deadline) throw new StorageError('timeout');
      await sleep(wait);
    }
  }

  async removePermanently(dest: DestinationRef, itemId: string): Promise<void> {
    await this.call('POST', `${this.itemPath(dest, itemId)}/permanentDelete`, { read: 'none' });
  }

  /** Graph lists versions without hashes, so each version's content is read and hashed here. */
  async listVersions(dest: DestinationRef, itemId: string): Promise<ItemVersion[]> {
    const versions = await this.listAll<{ id: string; size?: number; lastModifiedDateTime?: string }>(`${this.itemPath(dest, itemId)}/versions`);
    const out: ItemVersion[] = [];
    for (const v of versions) {
      const c = await this.call('GET', `${this.itemPath(dest, itemId)}/versions/${enc(v.id)}/content`, { read: 'bytes', timeoutMs: this.chunkTimeoutMs });
      const bytes = c.bytes ?? Buffer.alloc(0);
      out.push({ id: v.id, size: typeof v.size === 'number' ? v.size : bytes.length, providerHash: quickXorHash(bytes), modifiedAt: v.lastModifiedDateTime ?? '' });
    }
    return out;
  }

  async restoreVersion(dest: DestinationRef, itemId: string, versionId: string): Promise<void> {
    await this.call('POST', `${this.itemPath(dest, itemId)}/versions/${enc(versionId)}/restoreVersion`, { read: 'none' });
  }

  async lookupPerson(email: string): Promise<'account' | 'not_found' | 'unknown'> {
    if (!this.opts.lookup) return 'unknown';
    const r = await this.call('GET', `/users/${enc(email.trim())}?$select=id,userType,accountEnabled`, { allow: [404] });
    if (r.status === 404) return 'not_found';
    return r.json?.userType === 'Member' && r.json?.accountEnabled === true ? 'account' : 'not_found';
  }

  async grant(dest: DestinationRef, itemId: string, email: string, role: 'read' | 'write'): Promise<GrantResult> {
    const address = email.trim();
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1) return { notFound: true };
    if (this.opts.lookup) {
      if ((await this.lookupPerson(address)) !== 'account') return { notFound: true };
    } else {
      const domain = address.slice(at + 1).toLowerCase();
      const allowed = (await this.opts.allowedDomains()).map((d) => d.trim().toLowerCase());
      if (!allowed.includes(domain)) return { notFound: true };
    }
    const target = await this.getRaw(dest, itemId);
    if (!target.folder && !target.root) throw new StorageError('invalid'); // Kainow shares folders only
    const r = await this.call('POST', `${this.itemPath(dest, itemId)}/invite`, {
      body: { recipients: [{ email: address }], roles: [role], requireSignIn: true, sendInvitation: false },
      allow: [404],
    });
    if (r.status === 404) {
      if (r.json?.error?.code === 'itemNotFound') throw new StorageError('not_found', { status: 404 });
      return { notFound: true }; // the provider could not resolve the recipient to an account
    }
    const id = r.json?.value?.[0]?.id;
    if (typeof id !== 'string') throw new StorageError('server', { status: r.status });
    return { permissionId: id };
  }

  async revoke(dest: DestinationRef, itemId: string, permissionId: string): Promise<void> {
    await this.call('DELETE', `${this.itemPath(dest, itemId)}/permissions/${enc(permissionId)}`, { read: 'none' });
  }

  async listPermissions(dest: DestinationRef, itemId: string): Promise<PermissionInfo[]> {
    const perms = await this.listAll<GraphPermission>(`${this.itemPath(dest, itemId)}/permissions`);
    return perms.map(classify);
  }

  async resolveLink(url: string): Promise<{ dest: DestinationRef | null; item: ItemState }> {
    let u: URL;
    try { u = new URL(url); } catch { throw new StorageError('invalid'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new StorageError('invalid');
    const shareId = `u!${Buffer.from(url, 'utf8').toString('base64url')}`;
    const r = await this.call('GET', `/shares/${enc(shareId)}/driveItem?$select=${ITEM_SELECT}`);
    const g = this.item(r.json, r.status);
    const driveId = g.parentReference?.driveId;
    if (!driveId) throw new StorageError('server', { status: r.status });
    const root = await this.call('GET', `${this.drive(driveId)}/root?$select=id`);
    if (typeof root.json?.id !== 'string') throw new StorageError('server', { status: root.status });
    // A link names a drive, not a Kainow destination: id is empty and the caller matches driveId to its destinations.
    const dest: DestinationRef = { id: '', connector: 'graph', driveId, rootItemId: root.json.id };
    return { dest, item: await this.toRef(dest, g) };
  }
}

/**
 * Sorts a Graph permission into the kinds the library check needs (§5.5). The site's owners group is a SharePoint
 * site group with full control whose name ends in "Owners"; a site user with full control is a site administrator.
 */
function classify(p: GraphPermission): PermissionInfo {
  const roles = [...(p.roles ?? [])];
  const base = { id: p.id, roles };
  if (p.link) return { ...base, kind: 'link', principal: p.link.scope ?? 'link' };
  const g = p.grantedToV2 ?? {};
  const legacy = p.grantedTo ?? {};
  const owner = roles.includes('owner');
  const app = g.application ?? legacy.application;
  if (app) return { ...base, kind: 'app', principal: app.displayName ?? app.id ?? '' };
  const user = g.user ?? legacy.user;
  if (user) return { ...base, kind: 'user', principal: user.email ?? p.invitation?.email ?? user.displayName ?? user.id ?? '' };
  if (g.group) return { ...base, kind: 'group', principal: g.group.displayName ?? g.group.email ?? g.group.id ?? '' };
  if (g.siteGroup) {
    const name = g.siteGroup.displayName ?? g.siteGroup.loginName ?? '';
    return { ...base, kind: owner && /owners$/i.test(name.trim()) ? 'owner_group' : 'group', principal: name };
  }
  if (g.siteUser) {
    const principal = g.siteUser.email ?? g.siteUser.loginName ?? g.siteUser.displayName ?? '';
    return { ...base, kind: owner ? 'site_admin' : 'user', principal };
  }
  if (p.invitation?.email) return { ...base, kind: 'user', principal: p.invitation.email };
  return { ...base, kind: 'group', principal: '' };
}
