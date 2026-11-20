import type {
  DestinationCheck, DestinationRef, FolderRef, GrantResult, ItemState, ItemVersion, PermissionInfo, StoredRef,
} from './types';

/** The one interface all storage code uses; nothing outside connectors/ knows about a provider. */
export interface StorageConnector {
  kind: 'graph' | 'local';
  checkDestination(dest: DestinationRef): Promise<DestinationCheck>;
  /** parentId null means the destination root. */
  ensureFolder(dest: DestinationRef, parentId: string | null, name: string): Promise<FolderRef>;
  upload(dest: DestinationRef, folderId: string, name: string, bytes: Buffer, opts: { conflict: 'fail' }): Promise<StoredRef>;
  findChild(dest: DestinationRef, folderId: string, name: string): Promise<StoredRef | null>;
  getItem(dest: DestinationRef, itemId: string): Promise<ItemState>;
  download(dest: DestinationRef, itemId: string): Promise<Buffer>;
  move(dest: DestinationRef, itemId: string, newParentId: string, newName?: string): Promise<StoredRef>;
  copyTo(src: DestinationRef, itemId: string, dst: DestinationRef, folderId: string, name: string): Promise<StoredRef>;
  removePermanently(dest: DestinationRef, itemId: string): Promise<void>;
  listVersions(dest: DestinationRef, itemId: string): Promise<ItemVersion[]>;
  restoreVersion(dest: DestinationRef, itemId: string, versionId: string): Promise<void>;
  lookupPerson(email: string): Promise<'account' | 'not_found' | 'unknown'>;
  grant(dest: DestinationRef, itemId: string, email: string, role: 'read' | 'write'): Promise<GrantResult>;
  revoke(dest: DestinationRef, itemId: string, permissionId: string): Promise<void>;
  listPermissions(dest: DestinationRef, itemId: string): Promise<PermissionInfo[]>;
  resolveLink(url: string): Promise<{ dest: DestinationRef | null; item: ItemState }>;
}
