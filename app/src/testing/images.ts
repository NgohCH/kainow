/** Minimal PNG and JPEG openings for tests: enough bytes to be read, not full images. */
/** The first bytes of a PNG: signature and IHDR with the given size (enough for reading, not a full image). */
export function pngHeader(width: number, height: number, totalSize = 64): Buffer {
  const b = Buffer.alloc(Math.max(totalSize, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}

/** A baseline JPEG's opening: SOI, a JFIF APP0 segment, then SOF0 with the given size. */
export function jpegHeader(width: number, height: number, totalSize = 64): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalSize - head.length))]);
}
