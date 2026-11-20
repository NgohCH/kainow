export type StorageErrorCode =
  | 'unreachable' | 'timeout' | 'throttled' | 'unauthorised' | 'forbidden' | 'not_found'
  | 'conflict' | 'too_large' | 'quota' | 'server' | 'invalid' | 'unsupported';

const MESSAGES: Record<StorageErrorCode, string> = {
  unreachable: 'The storage service could not be reached.',
  timeout: 'The storage service took too long to answer.',
  throttled: 'The storage service asked us to slow down.',
  unauthorised: 'The storage connection was not accepted.',
  forbidden: 'The storage connection does not have permission for this.',
  not_found: 'The file or folder was not found.',
  conflict: 'A different file or folder already has this name.',
  too_large: 'The file is too large for the storage service.',
  quota: 'The storage location is full.',
  server: 'The storage service reported an error.',
  invalid: 'The storage request was not valid.',
  unsupported: 'The storage service does not support this.',
};

/** Message is fixed text per code: never provider text, tokens or file content. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(code: StorageErrorCode, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(MESSAGES[code]);
    this.name = 'StorageError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface DestinationRef { id: string; connector: 'graph' | 'local'; driveId: string; rootItemId: string }

export interface StoredRef {
  itemId: string; parentId: string; name: string; path: string; size: number;
  providerHash: string | null; etag: string | null; ctag: string | null; webUrl: string | null;
}
export type ItemState = StoredRef;
export interface FolderRef { itemId: string; name: string }
export interface ItemVersion { id: string; size: number; providerHash: string | null; modifiedAt: string }
export interface PermissionInfo {
  id: string;
  kind: 'owner_group' | 'site_admin' | 'app' | 'user' | 'group' | 'link';
  principal: string;
  roles: string[];
}
export type GrantResult = { permissionId: string } | { notFound: true };
export interface DestinationCheck {
  ok: boolean;
  lines: Array<{
    key: 'reachable' | 'folder' | 'upload' | 'delete' | 'permissions' | 'library_permissions' | 'sharing_capability';
    ok: boolean; detail: string;
  }>;
  quotaBytes: number | null;
  usedBytes: number | null;
  others: PermissionInfo[];
}
