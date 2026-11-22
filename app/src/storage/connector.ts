import type {
  DestinationCheck, DestinationRef, FolderRef, GrantResult, ItemState, ItemVersion, PermissionInfo, StoredRef,
} from './types';

/** The one interface all storage code uses; nothing outside connectors/ knows about a provider. */
export interface StorageConnector {
  kind: 'graph' | 'local';
  /**
   * With `testPerson`, the check also grants that person read on the check folder and revokes it again; without one
   * the permissions line fails ("Creating permissions was not checked: no test person given").
   */
  checkDestination(dest: DestinationRef, opts?: { testPerson?: string }): Promise<DestinationCheck>;
  /** parentId null means the destination root. */
  ensureFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef>;
  /**
   * Creates a new folder and never adopts an existing one: anything already with the name (folder or file) rejects
   * with StorageError('conflict'). parentId null means the destination root.
   */
  createFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef>;
  upload(dest: DestinationRef, folderId: string, name: string, bytes: Buffer, opts: { conflict: 'fail' }): Promise<StoredRef>;
  findChild(dest: DestinationRef, folderId: string, name: string): Promise<StoredRef | null>;
  getItem(dest: DestinationRef, itemId: string): Promise<ItemState>;
  download(dest: DestinationRef, itemId: string): Promise<Buffer>;
  move(dest: DestinationRef, itemId: string, newParentId: string, newName?: string): Promise<StoredRef>;
  copyTo(src: DestinationRef, itemId: string, dst: DestinationRef, folderId: string, name: string): Promise<StoredRef>;
  removePermanently(dest: DestinationRef, itemId: string): Promise<void>;
  /**
   * The provider's version history, newest first. With `size`, a provider that must download a version to hash it
   * (Graph gives no hashes for versions) skips versions of any other size: their providerHash is null.
   */
  listVersions(dest: DestinationRef, itemId: string, opts?: { size?: number }): Promise<ItemVersion[]>;
  restoreVersion(dest: DestinationRef, itemId: string, versionId: string): Promise<void>;
  lookupPerson(email: string): Promise<'account' | 'not_found' | 'unknown'>;
  grant(dest: DestinationRef, itemId: string, email: string, role: 'read' | 'write'): Promise<GrantResult>;
  revoke(dest: DestinationRef, itemId: string, permissionId: string): Promise<void>;
  listPermissions(dest: DestinationRef, itemId: string): Promise<PermissionInfo[]>;
  resolveLink(url: string): Promise<{ dest: DestinationRef | null; item: ItemState }>;
}
