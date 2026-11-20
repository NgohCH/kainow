import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { quickXorHash } from '../storage/quickxor';
import type { PermissionInfo } from '../storage/types';

// A small in-memory Microsoft Graph (SharePoint and OneDrive drives, users, the token endpoint) on a real
// local HTTP server, faithful enough that the Graph connector's real code paths run: status codes,
// @microsoft.graph.conflictBehavior, upload sessions (pre-authenticated URL, Content-Range, nextExpectedRanges,
// 320 KiB-multiple chunks), file.hashes.quickXorHash, copy with a monitor URL, permanentDelete versus DELETE
// (recycle bin), version history, invitations, /users and /shares. `fetch` rewrites the real Microsoft hosts
// to this server, so code that hard-codes them (M365TokenSource) can be pointed at it.

const LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH_HOST = 'https://graph.microsoft.com';
const CHUNK_UNIT = 320 * 1024;
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const MAX_FRAGMENT = 60 * 1024 * 1024;

export type FaultKind = 'timeout' | 'drop_after_body' | '429' | '503' | '401' | '403' | '404' | '423' | '500';

export interface FakeGraph {
  /** Stands in for https://graph.microsoft.com/v1.0. */
  graphBase: string;
  /** The token endpoint for any tenant (https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token is rewritten here). */
  tokenUrl: string;
  /** fetch that sends the Microsoft login and Graph hosts to this server; anything else goes to the real fetch. */
  fetch: typeof fetch;
  /** The bearer token this server issues and requires on Graph calls. */
  token: string;
  /** The scope of every token request, in order. */
  tokenScopes: string[];
  /** Every request: method and decoded path (no query). */
  calls: Array<{ method: string; path: string }>;
  /** Body length of every upload-session chunk accepted. */
  chunkSizes: number[];
  /** Every invitation received. */
  invites: Array<{ driveId: string; itemId: string; body: unknown }>;
  addDrive(opts?: { siteUrl?: string; libraryName?: string; ownerEmail?: string }): { driveId: string; rootItemId: string; siteId: string };
  addUser(email: string, opts?: { userType?: 'Member' | 'Guest'; enabled?: boolean }): void;
  seedPermission(driveId: string, itemId: string, p: Omit<PermissionInfo, 'id'>): string;
  fault(match: { method?: string; pathIncludes: string }, kind: FaultKind, times?: number): void;
  changeContent(driveId: string, itemId: string, bytes: Buffer): void;
  moveItem(driveId: string, itemId: string, newParentId: string, newName?: string): void;
  deleteItem(driveId: string, itemId: string): void;
  recycleBin(driveId: string): string[];
  close(): Promise<void>;
}

interface Drive {
  id: string; siteId: string; rootId: string; name: string; webUrl: string;
  driveType: 'documentLibrary' | 'business'; owner: string | null; quotaTotal: number; recycle: string[];
}
interface Version { id: string; content: Buffer; modified: string }
interface Item {
  id: string; driveId: string; parentId: string | null; name: string; folder: boolean; content: Buffer;
  history: Version[]; created: string; modified: string; ver: number; cver: number; perms: Perm[];
}
type Perm = Record<string, unknown> & { id: string; roles: string[] };
interface Site { id: string; hostname: string; path: string; drives: string[] }
interface User { id: string; email: string; userType: 'Member' | 'Guest'; enabled: boolean }
interface Session { driveId: string; parentId: string; name: string; conflict: string; next: number; total: number | null; parts: Buffer[] }
interface CopyJob { polls: number; result: { status: 'completed'; resourceId: string } | { status: 'failed'; code: string } }
interface Fault { method?: string; pathIncludes: string; kind: FaultKind; times: number }

interface Reply { status: number; headers?: Record<string, string>; json?: unknown; bytes?: Buffer }

class GErr extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const newItemId = () => `01${randomBytes(16).toString('hex').toUpperCase()}`;
const now = () => new Date().toISOString();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const encPath = (segs: string[]) => segs.map((s) => `/${encodeURIComponent(s)}`).join('');

export async function startFakeGraph(): Promise<FakeGraph> {
  const token = `fake-graph-token-${randomUUID()}`;
  const drives = new Map<string, Drive>();
  const items = new Map<string, Item>();
  const sites = new Map<string, Site>();
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const jobs = new Map<string, CopyJob>();
  const downloads = new Map<string, Buffer>();
  const faults: Fault[] = [];
  const held = new Set<ServerResponse>();
  const calls: FakeGraph['calls'] = [];
  const tokenScopes: string[] = [];
  const chunkSizes: number[] = [];
  const invites: FakeGraph['invites'] = [];
  let origin = '';
  let siteCount = 0;

  // ---- model ----
  const drive = (id: string): Drive => {
    const d = drives.get(id);
    if (!d) throw new GErr(404, 'itemNotFound');
    return d;
  };
  const item = (driveId: string, id: string): Item => {
    drive(driveId);
    const it = items.get(id);
    if (!it || it.driveId !== driveId) throw new GErr(404, 'itemNotFound');
    return it;
  };
  const children = (it: Item) => [...items.values()].filter((c) => c.parentId === it.id);
  const childNamed = (parent: Item, name: string) => children(parent).find((c) => same(c.name, name));
  const segments = (it: Item): string[] => {
    const out: string[] = [];
    for (let cur: Item = it; cur.parentId !== null; cur = items.get(cur.parentId)!) out.unshift(cur.name);
    return out;
  };
  const webUrl = (it: Item) => `${drives.get(it.driveId)!.webUrl}${encPath(segments(it))}`;
  const eTag = (it: Item) => `"{${it.id}},${it.ver}"`;
  const cTag = (it: Item) => `"c:{${it.id}},${it.cver}"`;
  const json = (it: Item): Record<string, unknown> => {
    const d = drives.get(it.driveId)!;
    const out: Record<string, unknown> = {
      id: it.id, name: it.name, size: it.folder ? children(it).reduce((n, c) => n + c.content.length, 0) : it.content.length,
      eTag: eTag(it), cTag: cTag(it), webUrl: webUrl(it), createdDateTime: it.created, lastModifiedDateTime: it.modified,
    };
    if (it.parentId === null) {
      out.root = {};
      out.parentReference = { driveId: d.id, driveType: d.driveType, siteId: d.siteId };
    } else {
      const parent = items.get(it.parentId)!;
      out.parentReference = {
        driveId: d.id, driveType: d.driveType, siteId: d.siteId, id: parent.id,
        path: `/drives/${d.id}/root:${encPath(segments(parent))}`,
      };
    }
    if (it.folder) out.folder = { childCount: children(it).length };
    else out.file = { mimeType: 'application/octet-stream', hashes: { quickXorHash: quickXorHash(it.content) } };
    return out;
  };
  const touch = (it: Item, content?: Buffer) => {
    it.ver += 1;
    it.modified = now();
    if (content) {
      it.history.push({ id: `${it.history.length + 1}.0`, content: it.content, modified: it.modified });
      it.content = content;
      it.cver += 1;
    }
  };
  const create = (parent: Item, name: string, folder: boolean, content: Buffer = Buffer.alloc(0)): Item => {
    checkName(name);
    const t = now();
    const it: Item = {
      id: newItemId(), driveId: parent.driveId, parentId: parent.id, name, folder, content, history: [],
      created: t, modified: t, ver: 1, cver: 1, perms: [],
    };
    items.set(it.id, it);
    touch(parent);
    return it;
  };
  const checkName = (name: string) => {
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new GErr(400, 'invalidRequest');
  };
  const descendants = (it: Item): Item[] => [it, ...children(it).flatMap(descendants)];
  /** Resolves a name clash for a new item by conflictBehavior; returns the name to use, or the item to replace. */
  const settle = (parent: Item, name: string, behavior: string): { name: string; replace?: Item } => {
    const clash = childNamed(parent, name);
    if (!clash) return { name };
    if (behavior === 'fail') throw new GErr(409, 'nameAlreadyExists');
    if (behavior === 'rename') {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      for (let n = 1; ; n++) if (!childNamed(parent, `${stem} ${n}${ext}`)) return { name: `${stem} ${n}${ext}` };
    }
    return { name, replace: clash };
  };
  const putContent = (parent: Item, name: string, bytes: Buffer, behavior: string): Reply => {
    if (!parent.folder) throw new GErr(400, 'invalidRequest');
    const s = settle(parent, name, behavior);
    if (s.replace) {
      if (s.replace.folder) throw new GErr(409, 'nameAlreadyExists');
      touch(s.replace, bytes);
      return { status: 200, json: json(s.replace) };
    }
    return { status: 201, json: json(create(parent, s.name, false, bytes)) };
  };
  const preauth = (bytes: Buffer) => {
    const key = randomUUID();
    downloads.set(key, bytes);
    return { status: 302, headers: { Location: `${origin}/download/${key}` } };
  };

  // ---- helpers exposed to tests ----
  const addDrive: FakeGraph['addDrive'] = (opts = {}) => {
    siteCount += 1;
    const owner = opts.ownerEmail?.toLowerCase() ?? null;
    const siteUrl = new URL(opts.siteUrl ?? (owner ? `https://tenant-my.example.org/personal/${owner.replace(/[@.]/g, '_')}` : `https://tenant.example.org/sites/site-${siteCount}`));
    const sitePath = siteUrl.pathname.replace(/\/+$/, '');
    const key = `${siteUrl.hostname}${sitePath}`.toLowerCase();
    let site = sites.get(key);
    if (!site) {
      site = { id: `${siteUrl.hostname},${randomUUID()},${randomUUID()}`, hostname: siteUrl.hostname, path: sitePath, drives: [] };
      sites.set(key, site);
    }
    const name = opts.libraryName ?? 'Documents';
    const d: Drive = {
      id: `b!${randomBytes(24).toString('base64url')}`, siteId: site.id, rootId: newItemId(), name,
      webUrl: `${siteUrl.origin}${sitePath}/${encodeURIComponent(name)}`, driveType: owner ? 'business' : 'documentLibrary',
      owner, quotaTotal: 1024 ** 4, recycle: [],
    };
    drives.set(d.id, d);
    site.drives.push(d.id);
    const t = now();
    items.set(d.rootId, {
      id: d.rootId, driveId: d.id, parentId: null, name: 'root', folder: true, content: Buffer.alloc(0), history: [],
      created: t, modified: t, ver: 1, cver: 1, perms: [],
    });
    return { driveId: d.id, rootItemId: d.rootId, siteId: site.id };
  };

  const addUser: FakeGraph['addUser'] = (email, opts = {}) => {
    users.set(email.toLowerCase(), { id: randomUUID(), email, userType: opts.userType ?? 'Member', enabled: opts.enabled ?? true });
  };

  const seedPermission: FakeGraph['seedPermission'] = (driveId, itemId, p) => {
    const it = item(driveId, itemId);
    const id = randomUUID();
    const pid = randomUUID();
    let perm: Perm;
    switch (p.kind) {
      case 'owner_group':
      case 'group':
        perm = { id, roles: [...p.roles], grantedToV2: { siteGroup: { id: pid, displayName: p.principal, loginName: p.principal } } };
        break;
      case 'site_admin': // a site user with these roles (the connector classes every site user as `user`)
        perm = { id, roles: [...p.roles], grantedToV2: { siteUser: { id: pid, displayName: p.principal, email: p.principal, loginName: `i:0#.f|membership|${p.principal}` } } };
        break;
      case 'app':
      case 'other_app': // the principal is the application (client) id
        perm = { id, roles: [...p.roles], grantedToV2: { application: { id: p.principal, displayName: `App ${p.principal}` } } };
        break;
      case 'user':
        perm = { id, roles: [...p.roles], grantedToV2: { user: { id: pid, displayName: p.principal, email: p.principal } } };
        break;
      case 'link':
        perm = {
          id, roles: [...p.roles],
          link: { scope: p.principal, type: p.roles.includes('write') ? 'edit' : 'view', webUrl: `${webUrl(it)}?share=${pid}` },
        };
        break;
    }
    it.perms.push(perm);
    return id;
  };

  // ---- routes ----
  const graph = (method: string, path: string, q: URLSearchParams, body: Buffer): Reply => {
    const parsed = (): Record<string, any> => {
      try { return body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { throw new GErr(400, 'invalidRequest'); }
    };
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/sites/root') throw new GErr(403, 'accessDenied'); // Sites.Selected, no grant on the root site
    if (method === 'GET' && (m = /^\/sites\/([^/:]+):(\/[^:]*?):?$/.exec(path))) {
      const site = sites.get(`${m[1]}${m[2].replace(/\/+$/, '')}`.toLowerCase());
      if (!site) throw new GErr(404, 'itemNotFound');
      return { status: 200, json: { id: site.id, webUrl: `https://${site.hostname}${site.path}` } };
    }
    if (method === 'GET' && (m = /^\/sites\/([^/]+)\/drives$/.exec(path))) {
      const site = [...sites.values()].find((s) => s.id === m![1]);
      if (!site) throw new GErr(404, 'itemNotFound');
      return { status: 200, json: { value: site.drives.map((id) => drives.get(id)!).map((d) => ({ id: d.id, name: d.name, webUrl: d.webUrl, driveType: d.driveType })) } };
    }
    if (method === 'GET' && (m = /^\/users\/([^/]+)\/drive$/.exec(path))) {
      const d = [...drives.values()].find((x) => x.owner === m![1].toLowerCase());
      if (!d) throw new GErr(404, 'itemNotFound');
      return { status: 200, json: { id: d.id, driveType: d.driveType, webUrl: d.webUrl } };
    }
    if (method === 'GET' && (m = /^\/users\/([^/]+)$/.exec(path))) {
      const u = users.get(m[1].toLowerCase());
      if (!u) throw new GErr(404, 'Request_ResourceNotFound');
      // only what User.ReadBasic.All exposes (no userType, no accountEnabled); a guest's UPN carries #EXT#
      const upn = u.userType === 'Guest' ? `${u.email.replace('@', '_')}#EXT#@tenant.example.org` : u.email;
      const all: Record<string, unknown> = { id: u.id, displayName: u.email, mail: u.email, userPrincipalName: upn };
      const select = q.get('$select')?.split(',').map((x) => x.trim()).filter((x) => x in all);
      return { status: 200, json: select?.length ? Object.fromEntries(select.map((k) => [k, all[k]])) : all };
    }
    if (method === 'GET' && (m = /^\/shares\/([^/]+)\/driveItem$/.exec(path))) {
      if (!m[1].startsWith('u!')) throw new GErr(400, 'invalidRequest');
      const url = Buffer.from(m[1].slice(2), 'base64url').toString('utf8');
      const it = [...items.values()].find((x) => webUrl(x) === url);
      if (!it) throw new GErr(404, 'itemNotFound');
      return { status: 200, json: json(it) };
    }

    if (!(m = /^\/drives\/([^/]+)(.*)$/.exec(path))) throw new GErr(400, 'invalidRequest');
    const d = drive(m[1]);
    let rest = m[2];
    if (method === 'GET' && rest === '') {
      const used = [...items.values()].filter((i) => i.driveId === d.id).reduce((n, i) => n + i.content.length, 0);
      return { status: 200, json: { id: d.id, name: d.name, driveType: d.driveType, webUrl: d.webUrl, quota: { total: d.quotaTotal, used, remaining: d.quotaTotal - used, state: 'normal' } } };
    }

    // address the item: /root, /root:/path[:], /items/{id}, /items/{id}:/path[:]
    let target: Item;
    if ((m = /^\/root(.*)$/.exec(rest))) { target = item(d.id, d.rootId); rest = m[1]; }
    else if ((m = /^\/items\/([^/:]+)(.*)$/.exec(rest))) { target = item(d.id, m[1]); rest = m[2]; }
    else throw new GErr(400, 'invalidRequest');
    let byPath: { parent: Item; name: string } | null = null;
    if (rest.startsWith(':')) {
      const close = rest.indexOf(':', 1);
      const rel = close < 0 ? rest.slice(1) : rest.slice(1, close);
      rest = close < 0 ? '' : rest.slice(close + 1);
      const segs = rel.split('/').filter(Boolean);
      if (!segs.length) throw new GErr(400, 'invalidRequest');
      let parent = target;
      for (const s of segs.slice(0, -1)) {
        const c = childNamed(parent, s);
        if (!c || !c.folder) throw new GErr(404, 'itemNotFound');
        parent = c;
      }
      const last = segs[segs.length - 1];
      byPath = { parent, name: last };
      const found = childNamed(parent, last);
      // creating by path (content, upload session) does not need the item to exist yet
      if (!found && !((method === 'PUT' && rest === '/content') || (method === 'POST' && rest === '/createUploadSession'))) {
        throw new GErr(404, 'itemNotFound');
      }
      if (found) target = found;
    }

    if (byPath && method === 'PUT' && rest === '/content') {
      if (body.length > SIMPLE_UPLOAD_MAX) throw new GErr(413, 'requestTooLarge');
      return putContent(byPath.parent, byPath.name, body, q.get('@microsoft.graph.conflictBehavior') ?? 'replace');
    }
    if (byPath && method === 'POST' && rest === '/createUploadSession') {
      const behavior = String(parsed().item?.['@microsoft.graph.conflictBehavior'] ?? 'replace');
      checkName(byPath.name);
      if (behavior === 'fail' && childNamed(byPath.parent, byPath.name)) throw new GErr(409, 'nameAlreadyExists');
      const sid = randomUUID();
      sessions.set(sid, { driveId: d.id, parentId: byPath.parent.id, name: byPath.name, conflict: behavior, next: 0, total: null, parts: [] });
      return { status: 200, json: { uploadUrl: `${origin}/upload/${sid}`, expirationDateTime: new Date(Date.now() + 3_600_000).toISOString(), nextExpectedRanges: ['0-'] } };
    }

    const it = target;
    if (rest === '' && method === 'GET') return { status: 200, json: json(it) };
    if (rest === '' && method === 'PATCH') {
      if (it.parentId === null) throw new GErr(400, 'invalidRequest');
      const b = parsed();
      const parentId = typeof b.parentReference?.id === 'string' ? b.parentReference.id : it.parentId;
      const name = typeof b.name === 'string' ? b.name : it.name;
      checkName(name);
      const parent = item(d.id, parentId);
      if (!parent.folder) throw new GErr(400, 'invalidRequest');
      for (let p: Item | undefined = parent; p; p = p.parentId ? items.get(p.parentId) : undefined) {
        if (p.id === it.id) throw new GErr(400, 'invalidRequest');
      }
      const clash = childNamed(parent, name);
      if (clash && clash.id !== it.id) throw new GErr(409, 'nameAlreadyExists');
      it.parentId = parent.id;
      it.name = name;
      touch(it);
      return { status: 200, json: json(it) };
    }
    if (rest === '' && method === 'DELETE') {
      if (it.parentId === null) throw new GErr(403, 'accessDenied');
      for (const x of descendants(it)) items.delete(x.id);
      d.recycle.push(it.id);
      return { status: 204 };
    }
    if (rest === '/permanentDelete' && method === 'POST') {
      if (it.parentId === null) throw new GErr(403, 'accessDenied');
      for (const x of descendants(it)) items.delete(x.id);
      return { status: 204 };
    }
    if (rest === '/children' && method === 'GET') return { status: 200, json: { value: children(it).map(json) } };
    if (rest === '/children' && method === 'POST') {
      if (!it.folder) throw new GErr(400, 'invalidRequest');
      const b = parsed();
      if (typeof b.name !== 'string' || !b.folder) throw new GErr(400, 'invalidRequest');
      const s = settle(it, b.name, String(b['@microsoft.graph.conflictBehavior'] ?? 'fail'));
      if (s.replace) for (const x of descendants(s.replace)) items.delete(x.id);
      return { status: 201, json: json(create(it, s.name, true)) };
    }
    if (rest === '/content' && method === 'GET') {
      if (it.folder) throw new GErr(404, 'itemNotFound');
      return preauth(it.content);
    }
    if (rest === '/content' && method === 'PUT') {
      if (it.folder) throw new GErr(400, 'invalidRequest');
      if (body.length > SIMPLE_UPLOAD_MAX) throw new GErr(413, 'requestTooLarge');
      touch(it, body);
      return { status: 200, json: json(it) };
    }
    if (rest === '/copy' && method === 'POST') {
      const b = parsed();
      const dst = drive(String(b.parentReference?.driveId ?? d.id));
      const parent = item(dst.id, String(b.parentReference?.id ?? dst.rootId));
      if (!parent.folder || it.folder) throw new GErr(400, 'invalidRequest');
      const name = typeof b.name === 'string' ? b.name : it.name;
      checkName(name);
      const behavior = q.get('@microsoft.graph.conflictBehavior') ?? 'fail';
      let result: CopyJob['result'];
      try {
        const s = settle(parent, name, behavior);
        result = { status: 'completed', resourceId: s.replace ? (touch(s.replace, it.content), s.replace.id) : create(parent, s.name, false, it.content).id };
      } catch (e) {
        if (!(e instanceof GErr)) throw e;
        result = { status: 'failed', code: e.code };
      }
      const jid = randomUUID();
      jobs.set(jid, { polls: 0, result });
      return { status: 202, headers: { Location: `${origin}/monitor/${jid}` } };
    }
    if (rest === '/versions' && method === 'GET') {
      if (it.folder) throw new GErr(400, 'invalidRequest');
      const current = { id: `${it.history.length + 1}.0`, lastModifiedDateTime: it.modified, size: it.content.length };
      const earlier = [...it.history].reverse().map((v) => ({ id: v.id, lastModifiedDateTime: v.modified, size: v.content.length }));
      return { status: 200, json: { value: [current, ...earlier] } };
    }
    if ((m = /^\/versions\/([^/]+)\/(content|restoreVersion)$/.exec(rest))) {
      const vid = m[1];
      const isCurrent = vid === `${it.history.length + 1}.0` || vid === 'current';
      const v = it.history.find((x) => x.id === vid);
      if (!isCurrent && !v) throw new GErr(404, 'itemNotFound');
      if (m[2] === 'content' && method === 'GET') return preauth(isCurrent ? it.content : v!.content);
      if (m[2] === 'restoreVersion' && method === 'POST') {
        if (!isCurrent) touch(it, v!.content);
        return { status: 204 };
      }
    }
    if (rest === '/invite' && method === 'POST') {
      const b = parsed();
      invites.push({ driveId: d.id, itemId: it.id, body: b });
      const recipients: Array<{ email?: string }> = Array.isArray(b.recipients) ? b.recipients : [];
      const roles: string[] = Array.isArray(b.roles) ? b.roles : [];
      if (!recipients.length || !roles.length || roles.some((r) => r !== 'read' && r !== 'write')) throw new GErr(400, 'invalidRequest');
      const value: Perm[] = [];
      for (const r of recipients) {
        const u = users.get(String(r.email ?? '').toLowerCase());
        if (!u || !u.enabled) throw new GErr(404, 'notFound'); // the recipient cannot be resolved to an account
        const existing = it.perms.find((p) => (p.grantedToV2 as any)?.user?.id === u.id);
        if (existing) { existing.roles = [...roles]; value.push(existing); continue; }
        const perm: Perm = {
          id: randomUUID(), roles: [...roles],
          grantedToV2: { user: { id: u.id, displayName: u.email, email: u.email } },
          invitation: { email: u.email, signInRequired: b.requireSignIn === true },
        };
        it.perms.push(perm);
        value.push(perm);
      }
      return { status: 200, json: { value } };
    }
    if (rest === '/permissions' && method === 'GET') return { status: 200, json: { value: it.perms } };
    if ((m = /^\/permissions\/([^/]+)$/.exec(rest)) && method === 'DELETE') {
      const i = it.perms.findIndex((p) => p.id === m![1]);
      if (i < 0) throw new GErr(404, 'itemNotFound');
      it.perms.splice(i, 1);
      return { status: 204 };
    }
    throw new GErr(400, 'invalidRequest');
  };

  const uploadChunk = (sid: string, method: string, headers: IncomingMessage['headers'], body: Buffer): Reply => {
    const s = sessions.get(sid);
    if (!s) throw new GErr(404, 'itemNotFound');
    if (method === 'DELETE') { sessions.delete(sid); return { status: 204 }; }
    if (method !== 'PUT') throw new GErr(400, 'invalidRequest');
    // the upload URL is pre-authenticated: Microsoft refuses it with an Authorization header
    if (headers.authorization) throw new GErr(401, 'unauthenticated');
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(headers['content-range'] ?? ''));
    if (!m) throw new GErr(400, 'invalidRange');
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const len = end - start + 1;
    if (start !== s.next || len !== body.length || len <= 0 || len > MAX_FRAGMENT || end >= total) throw new GErr(416, 'invalidRange');
    if (s.total !== null && s.total !== total) throw new GErr(400, 'invalidRange');
    if (end + 1 < total && len % CHUNK_UNIT !== 0) throw new GErr(400, 'invalidRange');
    s.total = total;
    s.parts.push(body);
    s.next = end + 1;
    chunkSizes.push(len);
    if (s.next < total) return { status: 202, json: { expirationDateTime: new Date(Date.now() + 3_600_000).toISOString(), nextExpectedRanges: [`${s.next}-`] } };
    sessions.delete(sid);
    return putContent(item(s.driveId, s.parentId), s.name, Buffer.concat(s.parts), s.conflict);
  };

  const monitor = (jid: string): Reply => {
    const j = jobs.get(jid);
    if (!j) throw new GErr(404, 'itemNotFound');
    j.polls += 1;
    if (j.polls === 1) return { status: 202, json: { status: 'inProgress', percentageComplete: 50 } };
    if (j.result.status === 'failed') return { status: 200, json: { status: 'failed', error: { code: j.result.code } } };
    return { status: 200, json: { status: 'completed', percentageComplete: 100, resourceId: j.result.resourceId } };
  };

  const tokenEndpoint = (body: Buffer): Reply => {
    const form = new URLSearchParams(body.toString('utf8'));
    if (form.get('grant_type') !== 'client_credentials' || !form.get('client_id') || !form.get('client_secret')) {
      return { status: 400, json: { error: 'invalid_request' } };
    }
    tokenScopes.push(form.get('scope') ?? '');
    return { status: 200, json: { access_token: token, expires_in: 3600, token_type: 'Bearer' } };
  };

  const route = (req: IncomingMessage, url: URL, body: Buffer): Reply => {
    const method = req.method ?? 'GET';
    const path = decodeURIComponent(url.pathname);
    let m: RegExpExecArray | null;
    if (method === 'POST' && /^\/login\/[^/]+\/oauth2\/v2\.0\/token$/.test(path)) return tokenEndpoint(body);
    if ((m = /^\/upload\/([^/]+)$/.exec(path))) return uploadChunk(m[1], method, req.headers, body);
    if (method === 'GET' && (m = /^\/monitor\/([^/]+)$/.exec(path))) return monitor(m[1]);
    if (method === 'GET' && (m = /^\/download\/([^/]+)$/.exec(path))) {
      const bytes = downloads.get(m[1]);
      if (!bytes) throw new GErr(404, 'itemNotFound');
      return { status: 200, bytes };
    }
    if (path.startsWith('/v1.0/')) {
      if (req.headers.authorization !== `Bearer ${token}`) throw new GErr(401, 'InvalidAuthenticationToken');
      // Graph addresses by path with ':' delimiters inside the URL path; split the raw path so encoded names stay intact
      const raw = url.pathname.slice('/v1.0'.length).split('/').map((seg) => seg.split(':').map(decodeURIComponent).join(':')).join('/');
      return graph(method, raw, url.searchParams, body);
    }
    throw new GErr(404, 'itemNotFound');
  };

  const send = (res: ServerResponse, r: Reply) => {
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (r.bytes) {
      headers['Content-Type'] = 'application/octet-stream';
      res.writeHead(r.status, headers).end(r.bytes);
    } else if (r.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      res.writeHead(r.status, headers).end(JSON.stringify(r.json));
    } else {
      res.writeHead(r.status, headers).end();
    }
  };

  const takeFault = (method: string, raw: string): Fault | undefined => {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
    const f = faults.find((x) => (!x.method || x.method === method) && (raw.includes(x.pathIncludes) || decoded.includes(x.pathIncludes)));
    if (!f) return undefined;
    f.times -= 1;
    if (f.times <= 0) faults.splice(faults.indexOf(f), 1);
    return f;
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', origin);
      const method = req.method ?? 'GET';
      let path = url.pathname;
      try { path = decodeURIComponent(path); } catch { /* keep raw */ }
      calls.push({ method, path });
      const fault = takeFault(method, req.url ?? '/');
      if (fault?.kind === 'timeout') {
        held.add(res);
        res.on('close', () => held.delete(res));
        return;
      }
      if (fault && fault.kind !== 'drop_after_body') {
        const status = Number(fault.kind);
        const headers: Record<string, string> = {};
        if (status === 429) headers['Retry-After'] = '2';
        if (status === 503) headers['Retry-After'] = '3';
        // Deliberately echoes the Authorization header so tests prove the connector never surfaces a response body.
        send(res, { status, headers, json: { error: { code: 'injectedFault', message: `Refused request carrying ${req.headers.authorization ?? 'no authorization'}` } } });
        return;
      }
      let reply: Reply;
      try {
        reply = route(req, url, body);
      } catch (e) {
        // anything unexpected (a malformed path, say) is a server error, not a crashed test process
        const g = e instanceof GErr ? e : new GErr(500, 'generalException');
        reply = { status: g.status, json: { error: { code: g.code, message: g.code } } };
      }
      if (fault?.kind === 'drop_after_body') {
        req.socket.destroy(); // the request took effect, but the reply is lost
        return;
      }
      send(res, reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const graphBase = `${origin}/v1.0`;

  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' || input instanceof URL) {
      let url = String(input);
      if (url.startsWith(`${LOGIN_HOST}/`)) url = `${origin}/login/${url.slice(LOGIN_HOST.length + 1)}`;
      else if (url.startsWith(`${GRAPH_HOST}/`)) url = `${origin}/${url.slice(GRAPH_HOST.length + 1)}`;
      return fetch(url, init);
    }
    return fetch(input, init);
  }) as typeof fetch;

  return {
    graphBase,
    tokenUrl: `${origin}/login/test-tenant/oauth2/v2.0/token`,
    fetch: fakeFetch,
    token,
    tokenScopes,
    calls,
    chunkSizes,
    invites,
    addDrive,
    addUser,
    seedPermission,
    fault: (match, kind, times = 1) => { faults.push({ method: match.method, pathIncludes: match.pathIncludes, kind, times }); },
    changeContent: (driveId, itemId, bytes) => {
      const it = item(driveId, itemId);
      if (it.folder) throw new Error('changeContent needs a file');
      touch(it, bytes);
    },
    moveItem: (driveId, itemId, newParentId, newName) => {
      const it = item(driveId, itemId);
      it.parentId = item(driveId, newParentId).id;
      if (newName) it.name = newName;
      touch(it);
    },
    deleteItem: (driveId, itemId) => {
      const d = drive(driveId);
      const it = item(driveId, itemId);
      for (const x of descendants(it)) items.delete(x.id);
      d.recycle.push(it.id);
    },
    recycleBin: (driveId) => [...drive(driveId).recycle],
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
