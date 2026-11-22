/*
 * KNBK1: chunked AES-256-GCM backup encryption (spec 10a section 5.2).
 *
 * Layout:  'KNBK1' (5 bytes) || key id (16 ASCII hex chars) || salt (12 random bytes) || frame*
 * Frame:   uint32be ciphertext length || ciphertext || 16-byte GCM tag
 *
 * Every chunk holds 1 MiB of plain text except the last, which holds 0..1 MiB and carries final flag 1.
 * An empty input still writes one (empty) final chunk, so an empty file is told apart from a cut-off one.
 *
 * Chunk i (from 0):
 *   enc key   = HKDF-SHA-256(master key, salt = the 12-byte file salt, info 'kainow-backup v1 enc')
 *   nonce key = HKDF-SHA-256(master key, salt = the 12-byte file salt, info 'kainow-backup v1 nonce')
 *   (so the master key is never used directly and the two uses are domain-separated; the key id stays SHA-256(master)[0..16 hex])
 *   nonce = first 12 bytes of HMAC-SHA-256(nonce key, salt || uint64be(i))
 *   AAD   = header (magic || key id || salt) || uint64be(i) || final-flag byte (0 or 1)
 *
 * What this gives: the header is authenticated by every chunk; reordering or splicing from another file (different
 * salt, hence different nonce and AAD) fails the tag; dropping the tail leaves no final chunk (truncated); data after
 * the final chunk is rejected. The nonce is derived, never stored, so no nonce can repeat within a file, and the
 * random salt keeps nonces apart between files made with the same key.
 *
 * Decryption knows only from the AAD whether a chunk is final: a non-final chunk is always exactly 1 MiB, so a
 * shorter chunk is tried as final only, and a full chunk is tried as non-final, then as final.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keyIdOf } from '../common/key-id';
import { Transform, type TransformCallback } from 'node:stream';

export type BackupKey = { id: string; bytes: Buffer };
export type BackupCryptoCode = 'bad_magic' | 'wrong_key' | 'tampered' | 'truncated';

export class BackupCryptoError extends Error {
  constructor(readonly code: BackupCryptoCode) {
    super(
      {
        bad_magic: 'This is not a Kainow backup file.',
        wrong_key: 'This backup was made with a different key.',
        tampered: 'The backup file has been changed or is damaged.',
        truncated: 'The backup file is incomplete.',
      }[code],
    );
    this.name = 'BackupCryptoError';
  }
}

const MAGIC = Buffer.from('KNBK1', 'latin1');
const ID_LEN = 16;
const SALT_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + ID_LEN + SALT_LEN;
const CHUNK = 1024 * 1024;
const KEY_BYTES = 32;

/** Reads a backup key file: exactly 32 bytes. Never logs or returns the path or the bytes in an error. */
export function loadBackupKey(path: string): BackupKey | { error: 'key_missing' | 'key_invalid' } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    return { error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'key_missing' : 'key_invalid' };
  }
  if (bytes.length !== KEY_BYTES) return { error: 'key_invalid' };
  return { id: keyIdOf(bytes), bytes };
}

/** A new random key as raw bytes and its id (used by the CLI). */
export function newBackupKeyBytes(): BackupKey {
  const bytes = randomBytes(KEY_BYTES);
  return { id: keyIdOf(bytes), bytes };
}

function u64(i: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(i));
  return b;
}
/** Per-file subkeys from the master key (HKDF-SHA-256, salt = the file's salt): one for AES-GCM, one for nonce derivation. */
function subkeys(master: Buffer, salt: Buffer): { enc: Buffer; nonce: Buffer } {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, salt, info, 32));
  return { enc: derive('kainow-backup v1 enc'), nonce: derive('kainow-backup v1 nonce') };
}
function nonceFor(nonceKey: Buffer, salt: Buffer, i: number): Buffer {
  return createHmac('sha256', nonceKey).update(salt).update(u64(i)).digest().subarray(0, 12);
}
function aadFor(header: Buffer, i: number, final: boolean): Buffer {
  return Buffer.concat([header, u64(i), Buffer.from([final ? 1 : 0])]);
}

export function encryptStream(key: BackupKey): Transform {
  const salt = randomBytes(SALT_LEN);
  const header = Buffer.concat([MAGIC, Buffer.from(key.id, 'ascii'), salt]);
  const sub = subkeys(key.bytes, salt);
  let started = false;
  let index = 0;
  let pending: Buffer = Buffer.alloc(0);

  const seal = (plain: Buffer, final: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', sub.enc, nonceFor(sub.nonce, salt, index), { authTagLength: TAG_LEN });
    cipher.setAAD(aadFor(header, index, final));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    index += 1;
    return Buffer.concat([len, ct, cipher.getAuthTag()]);
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        if (!started) {
          started = true;
          this.push(header);
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        // Keep at least one byte back, so the last chunk can be flagged final at flush.
        while (pending.length > CHUNK) {
          this.push(seal(pending.subarray(0, CHUNK), false));
          pending = pending.subarray(CHUNK);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!started) this.push(header);
        this.push(seal(pending, true));
        pending = Buffer.alloc(0);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

export function decryptStream(key: BackupKey): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let header: Buffer | null = null;
  let salt: Buffer = Buffer.alloc(0);
  let sub: { enc: Buffer; nonce: Buffer } | null = null;
  let index = 0;
  let finished = false;

  const open = (ct: Buffer, tag: Buffer, final: boolean): Buffer | null => {
    try {
      const d = createDecipheriv('aes-256-gcm', (sub as { enc: Buffer }).enc, nonceFor((sub as { nonce: Buffer }).nonce, salt, index), { authTagLength: TAG_LEN });
      d.setAAD(aadFor(header as Buffer, index, final));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      return null;
    }
  };

  const readHeader = (): void => {
    if (header || buf.length === 0) return;
    // A wrong magic is reported as soon as the bytes seen so far disagree with it.
    const seen = Math.min(buf.length, MAGIC.length);
    if (!buf.subarray(0, seen).equals(MAGIC.subarray(0, seen))) throw new BackupCryptoError('bad_magic');
    if (buf.length < HEADER_LEN) return;
    const id = buf.subarray(MAGIC.length, MAGIC.length + ID_LEN).toString('latin1');
    if (id !== key.id) throw new BackupCryptoError('wrong_key');
    header = Buffer.from(buf.subarray(0, HEADER_LEN));
    salt = Buffer.from(buf.subarray(MAGIC.length + ID_LEN, HEADER_LEN));
    sub = subkeys(key.bytes, salt);
    buf = buf.subarray(HEADER_LEN);
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        readHeader();
        if (!header) return cb();
        for (;;) {
          if (finished) {
            if (buf.length > 0) throw new BackupCryptoError('tampered');
            break;
          }
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len > CHUNK) throw new BackupCryptoError('tampered');
          if (buf.length < 4 + len + TAG_LEN) break;
          const ct = buf.subarray(4, 4 + len);
          const tag = buf.subarray(4 + len, 4 + len + TAG_LEN);
          let plain: Buffer | null = null;
          if (len === CHUNK) plain = open(ct, tag, false);
          if (!plain) {
            plain = open(ct, tag, true);
            if (plain) finished = true;
          }
          if (!plain) throw new BackupCryptoError('tampered');
          this.push(plain);
          index += 1;
          buf = buf.subarray(4 + len + TAG_LEN);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      if (!header) {
        // Nothing, or only a partial header, arrived.
        return cb(new BackupCryptoError('truncated'));
      }
      if (!finished) return cb(new BackupCryptoError('truncated'));
      cb();
    },
  });
}

/** A pass-through hasher: bytes flow through unchanged; call `digest()` after the stream has ended. */
export function sha256Stream(): Transform & { digest(): string } {
  const hash = createHash('sha256');
  let hex: string | null = null;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  }) as Transform & { digest(): string };
  t.digest = () => (hex ??= hash.digest('hex'));
  return t;
}
