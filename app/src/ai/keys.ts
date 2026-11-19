import { BadRequestException } from '@nestjs/common';
import type { ProtectedKey, Sealed } from '../quarantine/protected-key';

export type Provider = 'openai' | 'anthropic';

export interface KeyBinding {
  connectionId: string;
  projectId: string;
  provider: Provider;
}

/** The stored key cannot be opened: another protected key, another binding, or changed bytes. Never carries key text. */
export class KeyUnreadableError extends Error {
  constructor() {
    super('The stored AI key cannot be read.');
    this.name = 'KeyUnreadableError';
  }
}

/** Trimmed, 20-500 printable ASCII characters, no whitespace. */
export function normaliseApiKey(raw: unknown): string {
  const refuse = () => new BadRequestException('This does not look like an API key.');
  if (typeof raw !== 'string') throw refuse();
  const k = raw.trim();
  if (k.length < 20 || k.length > 500 || !/^[\x21-\x7e]+$/.test(k)) throw refuse();
  return k;
}

function aadFor(b: KeyBinding): Buffer {
  return Buffer.from(`kainow.ai-key:${b.connectionId}:${b.projectId}:${b.provider}`, 'utf8');
}

export function sealApiKey(key: ProtectedKey, apiKey: string, b: KeyBinding): Sealed & { keyId: string } {
  return { ...key.encrypt(Buffer.from(apiKey, 'utf8'), aadFor(b)), keyId: key.id };
}

/** Only ai/key-check.ts and ai/client-factory.ts may call this (see key-imports.test.ts). */
export function openApiKey(key: ProtectedKey, sealed: Sealed & { keyId: string }, b: KeyBinding): string {
  if (sealed.keyId !== key.id) throw new KeyUnreadableError();
  try {
    return key.decrypt(sealed, aadFor(b)).toString('utf8');
  } catch {
    throw new KeyUnreadableError();
  }
}
