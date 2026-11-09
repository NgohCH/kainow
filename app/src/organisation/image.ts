import { BadRequestException } from '@nestjs/common';
import type { LogoShape } from './branding';

export type ImageInfo = { mime: 'image/png' | 'image/jpeg'; width: number; height: number };

export const MAX_LOGO_BYTES = 512 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The type and pixel size of a PNG or JPEG, read from the file's own bytes (never its name or declared type).
 * Anything else, including SVG and a cut-off file, is null.
 */
export function readImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE) && buf.toString('ascii', 12, 16) === 'IHDR') {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { mime: 'image/png', width, height } : null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return readJpeg(buf);
  return null;
}

/** Walks a JPEG's segments to the first frame header (SOF0–SOF15 except DHT, JPG and DAC). */
function readJpeg(buf: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** Checks an uploaded logo against its shape's rules; the size limit comes first. */
export function checkLogo(shape: LogoShape, buf: Buffer): ImageInfo {
  if (buf.length > MAX_LOGO_BYTES) throw new BadRequestException('A logo can be at most 512 KB.');
  const info = readImage(buf);
  if (!info) throw new BadRequestException('Use a PNG or JPEG file.');
  const { width, height } = info;
  if (shape === 'square') {
    const square = Math.abs(width - height) <= 0.02 * Math.max(width, height);
    if (!square || width < 64 || height < 64) throw new BadRequestException('A square logo must be square and at least 64 × 64 pixels.');
  } else {
    const ratio = width / height;
    if (ratio < 2 || ratio > 6 || height < 40) {
      throw new BadRequestException('A wide logo must be 2 to 6 times as wide as it is high and at least 40 pixels high.');
    }
  }
  return info;
}
