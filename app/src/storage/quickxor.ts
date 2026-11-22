// Microsoft's QuickXorHash: 160-bit register, each input byte XORed in at bit offset
// (index * 11) mod 160 (circular), then the total byte length XORed little-endian into the
// last 8 bytes of the register. The digest is the base64 of the 20 bytes.
const WIDTH_BITS = 160;
const SHIFT = 11;

export class QuickXorHasher {
  private readonly data = new Uint8Array(WIDTH_BITS / 8);
  private bitPos = 0;
  private length = 0;

  update(b: Buffer): void {
    for (let i = 0; i < b.length; i++) {
      const byteIdx = this.bitPos >> 3;
      const v = b[i] << (this.bitPos & 7);
      this.data[byteIdx] ^= v & 0xff;
      this.data[(byteIdx + 1) % 20] ^= v >> 8;
      this.bitPos = (this.bitPos + SHIFT) % WIDTH_BITS;
    }
    this.length += b.length;
  }

  digest(): string {
    const out = Buffer.from(this.data);
    let len = BigInt(this.length);
    for (let i = 12; i < 20; i++) {
      out[i] ^= Number(len & 0xffn);
      len >>= 8n;
    }
    return out.toString('base64');
  }
}

export function quickXorHash(bytes: Buffer): string {
  const h = new QuickXorHasher();
  h.update(bytes);
  return h.digest();
}
