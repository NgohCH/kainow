import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Nest provider token for the loaded key: `ProtectedKey | null` (null when the file is unset, missing or invalid). */
export const PROTECTED_KEY = Symbol('PROTECTED_KEY');

export interface Sealed {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export interface ProtectedKey {
  /** First 16 hex characters of SHA-256 of the key; stored with each encrypted row. */
  id: string;
  encrypt(plain: Buffer): Sealed;
  /** Throws when the tag or ciphertext was changed or the key is not the one that encrypted it. */
  decrypt(v: Sealed): Buffer;
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function fromBytes(key: Buffer): ProtectedKey {
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return {
    id,
    encrypt(plain) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return { ciphertext, nonce, tag: cipher.getAuthTag() };
    },
    decrypt(v) {
      if (v.nonce.length !== NONCE_BYTES) throw new Error('protected key: nonce must be 12 bytes');
      if (v.tag.length !== TAG_BYTES) throw new Error('protected key: tag must be 16 bytes');
      const decipher = createDecipheriv('aes-256-gcm', key, v.nonce, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(v.tag);
      return Buffer.concat([decipher.update(v.ciphertext), decipher.final()]);
    },
  };
}

/**
 * Reads the protected-key file: exactly 32 bytes, else null. The log line names the problem and the path, never the bytes.
 * The key is held in memory only.
 */
export function loadProtectedKey(path: string | null, log: (message: string) => void = (m) => console.error(m)): ProtectedKey | null {
  // Unset is a normal state (the Administrator view shows the warning); only a configured file that fails is logged.
  if (!path) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log(code === 'ENOENT' ? `protected key file not found: ${path}` : `protected key file unreadable: ${path}`);
    return null;
  }
  if (bytes.length !== KEY_BYTES) {
    log(`protected key file has the wrong length (must be ${KEY_BYTES} bytes): ${path}`);
    return null;
  }
  return fromBytes(bytes);
}

/** A new random key as raw bytes and its id (used by the CLI). */
export function newKeyBytes(): { bytes: Buffer; id: string } {
  const bytes = randomBytes(KEY_BYTES);
  return { bytes, id: fromBytes(bytes).id };
}
