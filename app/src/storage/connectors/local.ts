import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { StorageConnector } from '../connector';
import { quickXorHash } from '../quickxor';
import {
  StorageError, type DestinationCheck, type DestinationRef, type FolderRef, type GrantResult,
  type ItemState, type ItemVersion, type PermissionInfo, type StoredRef,
} from '../types';

// Development-only connector: files under rootDir/<driveId>/, item ids and structure in
// rootDir/index.json (stable across restarts), grants and permissions in rootDir/permissions.json.
// It never touches the database.

interface HistoryEntry { id: string; size: number; hash: string; modifiedAt: string }
interface Item {
  id: string; driveId: string; parentId: string; name: string; kind: 'file' | 'folder';
  size: number; hash: string | null; mod: number; modifiedAt: string; history: HistoryEntry[];
}
interface Index { items: Record<string, Item> }
type PermStore = Record<string, PermissionInfo[]>;

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export class LocalConnector implements StorageConnector {
  readonly kind = 'local' as const;
  private readonly lookup: Record<string, 'account' | 'not_found'>;

  constructor(private readonly rootDir: string, opts: { lookup?: Record<string, 'account' | 'not_found'> } = {}) {
    this.lookup = opts.lookup ?? {};
    mkdirSync(rootDir, { recursive: true });
  }

  // ---- persistence (synchronous, so each operation is atomic within the process) ----
  private get indexFile(): string { return join(this.rootDir, 'index.json'); }
  private get permFile(): string { return join(this.rootDir, 'permissions.json'); }
  private readJson<T>(file: string, empty: T): T {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : empty;
  }
  private writeJson(file: string, v: unknown): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 2));
    renameSync(tmp, file);
  }
  private loadIndex(): Index { return this.readJson<Index>(this.indexFile, { items: {} }); }
  private saveIndex(i: Index): void { this.writeJson(this.indexFile, i); }
  private loadPerms(): PermStore { return this.readJson<PermStore>(this.permFile, {}); }
  private savePerms(p: PermStore): void { this.writeJson(this.permFile, p); }

  private driveDir(dest: DestinationRef): string {
    if (!SAFE_ID.test(dest.driveId)) throw new StorageError('invalid');
    return join(this.rootDir, dest.driveId);
  }
  private filePath(dest: DestinationRef, itemId: string): string { return join(this.driveDir(dest), 'files', itemId); }
  private versionDir(dest: DestinationRef, itemId: string): string { return join(this.driveDir(dest), 'versions', itemId); }

  private checkName(name: string): void {
    if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0]/.test(name)) throw new StorageError('invalid');
  }
  private same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

  private item(dest: DestinationRef, idx: Index, itemId: string): Item {
    const it = idx.items[itemId];
    if (!it || it.driveId !== dest.driveId) throw new StorageError('not_found');
    return it;
  }
  private assertParent(dest: DestinationRef, idx: Index, parentId: string): void {
    if (parentId === dest.rootItemId) return;
    if (this.item(dest, idx, parentId).kind !== 'folder') throw new StorageError('invalid');
  }
  private children(dest: DestinationRef, idx: Index, parentId: string): Item[] {
    return Object.values(idx.items).filter((i) => i.driveId === dest.driveId && i.parentId === parentId);
  }
  private childNamed(dest: DestinationRef, idx: Index, parentId: string, name: string): Item | undefined {
    return this.children(dest, idx, parentId).find((c) => this.same(c.name, name));
  }
  private pathOf(dest: DestinationRef, idx: Index, it: Item): string {
    const parts = [it.name];
    let cur = it;
    while (cur.parentId !== dest.rootItemId) {
      cur = this.item(dest, idx, cur.parentId);
      parts.unshift(cur.name);
    }
    return `/${parts.join('/')}`;
  }
  private ref(dest: DestinationRef, idx: Index, it: Item): StoredRef {
    return {
      itemId: it.id, parentId: it.parentId, name: it.name, path: this.pathOf(dest, idx, it), size: it.size,
      providerHash: it.hash, etag: `"e${it.mod}"`, ctag: `"c${it.mod}"`, webUrl: `local://${it.driveId}/${it.id}`,
    };
  }

  // ---- contract ----
  async checkDestination(dest: DestinationRef, opts: { testPerson?: string } = {}): Promise<DestinationCheck> {
    const lines: DestinationCheck['lines'] = [];
    let ok = true;
    const step = (key: DestinationCheck['lines'][number]['key'], fn: () => string) => {
      try { lines.push({ key, ok: true, detail: fn() }); } catch { ok = false; lines.push({ key, ok: false, detail: 'failed' }); }
    };
    const probe = join(this.driveDir(dest), `.probe-${randomUUID()}`);
    step('reachable', () => { mkdirSync(this.driveDir(dest), { recursive: true }); return 'Local folder'; });
    step('folder', () => 'Local folder is the root');
    step('upload', () => { writeFileSync(probe, 'probe'); return 'Can write'; });
    step('delete', () => { rmSync(probe); return 'Can delete'; });
    lines.push(await this.checkGrant(dest, opts.testPerson));
    if (!lines[lines.length - 1].ok) ok = false;
    step('library_permissions', () => 'Not applicable to the local folder');
    step('sharing_capability', () => 'Grants are recorded in a sidecar file');
    return { ok, lines, quotaBytes: null, usedBytes: null, others: this.loadPerms()[dest.rootItemId] ?? [] };
  }

  /** Grants the test person read on the check folder and revokes it again (both must succeed). */
  private async checkGrant(dest: DestinationRef, testPerson?: string): Promise<DestinationCheck['lines'][number]> {
    if (!testPerson) return { key: 'permissions', ok: false, detail: 'Creating permissions was not checked: no test person given' };
    try {
      const folder = await this.ensureFolder(dest, null, '.kainow-check');
      const g = await this.grant(dest, folder.itemId, testPerson, 'read');
      if (!('permissionId' in g)) return { key: 'permissions', ok: false, detail: 'The test person could not be given access' };
      await this.revoke(dest, folder.itemId, g.permissionId);
      return { key: 'permissions', ok: true, detail: 'Can create and remove folder permissions' };
    } catch {
      return { key: 'permissions', ok: false, detail: 'failed' };
    }
  }

  async ensureFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef> {
    this.checkName(name);
    const idx = this.loadIndex();
    const pid = parentId ?? dest.rootItemId;
    this.assertParent(dest, idx, pid);
    const existing = this.childNamed(dest, idx, pid, name);
    if (existing) {
      if (existing.kind !== 'folder') throw new StorageError('conflict');
      return { itemId: existing.id, name: existing.name };
    }
    const it: Item = {
      id: randomUUID(), driveId: dest.driveId, parentId: pid, name, kind: 'folder', size: 0, hash: null,
      mod: 1, modifiedAt: new Date().toISOString(), history: [],
    };
    idx.items[it.id] = it;
    this.saveIndex(idx);
    return { itemId: it.id, name: it.name };
  }

  async createFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef> {
    this.checkName(name);
    const idx = this.loadIndex();
    const pid = parentId ?? dest.rootItemId;
    this.assertParent(dest, idx, pid);
    if (this.childNamed(dest, idx, pid, name)) throw new StorageError('conflict');
    return this.ensureFolder(dest, parentId, name);
  }

  async upload(dest: DestinationRef, folderId: string, name: string, bytes: Buffer, opts: { conflict: 'fail' }): Promise<StoredRef> {
    if (opts.conflict !== 'fail') throw new StorageError('invalid');
    this.checkName(name);
    const idx = this.loadIndex();
    this.assertParent(dest, idx, folderId);
    if (this.childNamed(dest, idx, folderId, name)) throw new StorageError('conflict');
    const it: Item = {
      id: randomUUID(), driveId: dest.driveId, parentId: folderId, name, kind: 'file', size: bytes.length,
      hash: quickXorHash(bytes), mod: 1, modifiedAt: new Date().toISOString(), history: [],
    };
    mkdirSync(join(this.driveDir(dest), 'files'), { recursive: true });
    writeFileSync(this.filePath(dest, it.id), bytes);
    idx.items[it.id] = it;
    this.saveIndex(idx);
    return this.ref(dest, idx, it);
  }

  async findChild(dest: DestinationRef, folderId: string, name: string): Promise<StoredRef | null> {
    const idx = this.loadIndex();
    this.assertParent(dest, idx, folderId);
    const c = this.childNamed(dest, idx, folderId, name);
    return c ? this.ref(dest, idx, c) : null;
  }

  async getItem(dest: DestinationRef, itemId: string): Promise<ItemState> {
    const idx = this.loadIndex();
    return this.ref(dest, idx, this.item(dest, idx, itemId));
  }

  async download(dest: DestinationRef, itemId: string): Promise<Buffer> {
    const idx = this.loadIndex();
    const it = this.item(dest, idx, itemId);
    if (it.kind !== 'file') throw new StorageError('invalid');
    return readFileSync(this.filePath(dest, it.id));
  }

  async move(dest: DestinationRef, itemId: string, newParentId: string, newName?: string): Promise<StoredRef> {
    const idx = this.loadIndex();
    const it = this.item(dest, idx, itemId);
    const name = newName ?? it.name;
    this.checkName(name);
    this.assertParent(dest, idx, newParentId);
    // a folder may not move into itself or its own descendants
    for (let p = newParentId; p !== dest.rootItemId; p = this.item(dest, idx, p).parentId) {
      if (p === it.id) throw new StorageError('invalid');
    }
    const clash = this.childNamed(dest, idx, newParentId, name);
    if (clash && clash.id !== it.id) throw new StorageError('conflict');
    it.parentId = newParentId;
    it.name = name;
    it.mod += 1;
    it.modifiedAt = new Date().toISOString();
    this.saveIndex(idx);
    return this.ref(dest, idx, it);
  }

  async copyTo(src: DestinationRef, itemId: string, dst: DestinationRef, folderId: string, name: string): Promise<StoredRef> {
    const bytes = await this.download(src, itemId);
    return this.upload(dst, folderId, name, bytes, { conflict: 'fail' });
  }

  async removePermanently(dest: DestinationRef, itemId: string): Promise<void> {
    const idx = this.loadIndex();
    const it = this.item(dest, idx, itemId);
    const perms = this.loadPerms();
    const drop = (x: Item) => {
      if (x.kind === 'folder') for (const c of this.children(dest, idx, x.id)) drop(c);
      rmSync(this.filePath(dest, x.id), { force: true });
      rmSync(this.versionDir(dest, x.id), { recursive: true, force: true });
      delete perms[x.id];
      delete idx.items[x.id];
    };
    drop(it);
    this.saveIndex(idx);
    this.savePerms(perms);
  }

  async listVersions(dest: DestinationRef, itemId: string): Promise<ItemVersion[]> {
    const idx = this.loadIndex();
    const it = this.item(dest, idx, itemId);
    if (it.kind !== 'file') throw new StorageError('invalid');
    const current: ItemVersion = { id: `${it.history.length + 1}.0`, size: it.size, providerHash: it.hash, modifiedAt: it.modifiedAt };
    const earlier = it.history.map((h) => ({ id: h.id, size: h.size, providerHash: h.hash, modifiedAt: h.modifiedAt }));
    return [current, ...earlier.reverse()];
  }

  async restoreVersion(dest: DestinationRef, itemId: string, versionId: string): Promise<void> {
    const idx = this.loadIndex();
    const it = this.item(dest, idx, itemId);
    if (it.kind !== 'file') throw new StorageError('invalid');
    if (versionId === `${it.history.length + 1}.0`) return; // already current
    const h = it.history.find((x) => x.id === versionId);
    if (!h) throw new StorageError('not_found');
    const bytes = readFileSync(join(this.versionDir(dest, it.id), h.id));
    this.replaceContent(dest, idx, it, bytes);
  }

  async lookupPerson(email: string): Promise<'account' | 'not_found' | 'unknown'> {
    return this.lookup[email] ?? 'not_found';
  }

  async grant(dest: DestinationRef, itemId: string, email: string, role: 'read' | 'write'): Promise<GrantResult> {
    const idx = this.loadIndex();
    const it = itemId === dest.rootItemId ? null : this.item(dest, idx, itemId);
    if (it && it.kind !== 'folder') throw new StorageError('invalid');
    if ((await this.lookupPerson(email)) !== 'account') return { notFound: true };
    const perms = this.loadPerms();
    const list = (perms[itemId] ??= []);
    const existing = list.find((p) => p.kind === 'user' && p.principal.toLowerCase() === email.toLowerCase());
    if (existing) {
      existing.roles = [role];
      this.savePerms(perms);
      return { permissionId: existing.id };
    }
    const p: PermissionInfo = { id: randomUUID(), kind: 'user', principal: email, roles: [role] };
    list.push(p);
    this.savePerms(perms);
    return { permissionId: p.id };
  }

  async revoke(dest: DestinationRef, itemId: string, permissionId: string): Promise<void> {
    this.requireKnown(dest, itemId);
    const perms = this.loadPerms();
    const list = perms[itemId] ?? [];
    if (!list.some((p) => p.id === permissionId)) throw new StorageError('not_found');
    perms[itemId] = list.filter((p) => p.id !== permissionId);
    this.savePerms(perms);
  }

  async listPermissions(dest: DestinationRef, itemId: string): Promise<PermissionInfo[]> {
    this.requireKnown(dest, itemId);
    return (this.loadPerms()[itemId] ?? []).map((p) => ({ ...p, roles: [...p.roles] }));
  }

  async resolveLink(url: string): Promise<{ dest: DestinationRef | null; item: ItemState }> {
    const m = /^local:\/\/([A-Za-z0-9._-]+)\/([A-Za-z0-9-]+)$/.exec(url);
    if (!m) throw new StorageError('invalid');
    const idx = this.loadIndex();
    const it = idx.items[m[2]];
    if (!it || it.driveId !== m[1]) throw new StorageError('not_found');
    // a link carries no destination, so the root is found by walking up to a parent that is not an item
    const d: DestinationRef = { id: '', connector: 'local', driveId: it.driveId, rootItemId: this.rootOf(idx, it) };
    return { dest: null, item: this.ref(d, idx, it) };
  }

  private rootOf(idx: Index, it: Item): string {
    let cur = it;
    while (idx.items[cur.parentId]) cur = idx.items[cur.parentId];
    return cur.parentId;
  }

  private requireKnown(dest: DestinationRef, itemId: string): void {
    if (itemId === dest.rootItemId) return;
    this.item(dest, this.loadIndex(), itemId);
  }

  // ---- development and test helpers (not part of the contract) ----
  /** Replaces a file's content, keeping the previous content as a version. */
  async overwrite(dest: DestinationRef, itemId: string, bytes: Buffer): Promise<void> {
    const idx = this.loadIndex();
    const it = this.item(dest, idx, itemId);
    if (it.kind !== 'file') throw new StorageError('invalid');
    this.replaceContent(dest, idx, it, bytes);
  }

  /** Records a permission as if it already existed on the item (owner group, site admin and so on). */
  seedPermission(dest: DestinationRef, itemId: string, p: Omit<PermissionInfo, 'id'>): string {
    this.requireKnown(dest, itemId);
    const perms = this.loadPerms();
    const id = randomUUID();
    (perms[itemId] ??= []).push({ ...p, id });
    this.savePerms(perms);
    return id;
  }

  private replaceContent(dest: DestinationRef, idx: Index, it: Item, bytes: Buffer): void {
    const vid = `${it.history.length + 1}.0`;
    mkdirSync(this.versionDir(dest, it.id), { recursive: true });
    copyFileSync(this.filePath(dest, it.id), join(this.versionDir(dest, it.id), vid));
    it.history.push({ id: vid, size: it.size, hash: it.hash ?? quickXorHash(Buffer.alloc(0)), modifiedAt: it.modifiedAt });
    writeFileSync(this.filePath(dest, it.id), bytes);
    it.size = bytes.length;
    it.hash = quickXorHash(bytes);
    it.mod += 1;
    it.modifiedAt = new Date().toISOString();
    this.saveIndex(idx);
  }
}
