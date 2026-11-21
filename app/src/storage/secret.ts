import { BadRequestException } from '@nestjs/common';
import type { ProtectedKey, Sealed } from '../quarantine/protected-key';

/** The stored client secret cannot be opened: another protected key, another binding, or changed bytes. Never carries secret text. */
export class StorageSecretUnreadable extends Error {
  constructor() {
    super('The stored storage client secret cannot be read.');
    this.name = 'StorageSecretUnreadable';
  }
}

/** The one storage connection. */
export const STORAGE_CONNECTION_ID = 'storage';

/** Trimmed, 10-200 printable characters. */
export function normaliseClientSecret(raw: unknown): string {
  const refuse = () => new BadRequestException('This does not look like a client secret.');
  if (typeof raw !== 'string') throw refuse();
  const s = raw.trim();
  if (s.length < 10 || s.length > 200 || !/^[\x20-\x7e]+$/.test(s)) throw refuse();
  return s;
}

const aadFor = (connectionId: string): Buffer => Buffer.from(`kainow.storage-secret:${connectionId}`, 'utf8');

export function sealStorageSecret(key: ProtectedKey, secret: string, connectionId: string): Sealed & { keyId: string } {
  return { ...key.encrypt(Buffer.from(secret, 'utf8'), aadFor(connectionId)), keyId: key.id };
}

/** Only storage/connector-factory.ts and storage/settings.service.ts (the connection check) may call this (see secret-imports.test.ts). */
export function openStorageSecret(key: ProtectedKey, sealed: Sealed & { keyId: string }, connectionId: string): string {
  if (sealed.keyId !== key.id) throw new StorageSecretUnreadable();
  try {
    return key.decrypt(sealed, aadFor(connectionId)).toString('utf8');
  } catch {
    throw new StorageSecretUnreadable();
  }
}

/**
 * Whether the protected key opens a sealed storage secret, with its binding as additional data; the plain value is
 * dropped at once and never returned (the restore drill's sealed-value check, ops spec 8.1 step 7).
 */
export function storageSecretReadable(key: ProtectedKey, sealed: Sealed & { keyId: string }, connectionId: string = STORAGE_CONNECTION_ID): boolean {
  if (sealed.keyId !== key.id) return false;
  try {
    key.decrypt(sealed, aadFor(connectionId)).fill(0);
    return true;
  } catch {
    return false;
  }
}
