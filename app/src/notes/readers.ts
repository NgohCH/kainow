import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { MAX_TEXT_CHARS, MAX_UPLOAD_BYTES, NoteTextError, normaliseText } from './text';

export class UploadRejected extends Error {}

export type FileKind = 'txt' | 'md' | 'docx' | 'pdf';

export const MEDIA_TYPES: Record<FileKind, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

/** Limits that stop decompression bombs and runaway documents. Technical defaults, not product policy. */
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;

export function kindFromFilename(filename: string): FileKind {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'docx') return 'docx';
  if (ext === 'pdf') return 'pdf';
  throw new UploadRejected('Only .txt, .md, .docx and .pdf files can be uploaded.');
}

/** What the file says about itself must agree with its name; the extension alone is never trusted. */
function checkSignature(kind: FileKind, bytes: Buffer): void {
  if (kind === 'pdf') {
    if (bytes.subarray(0, 1024).indexOf('%PDF-') === -1) {
      throw new UploadRejected('The file is named .pdf but is not a PDF.');
    }
  } else if (kind === 'docx') {
    if (!(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
      throw new UploadRejected('The file is named .docx but is not a Word document.');
    }
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Reads the ZIP central directory without decompressing anything, so a bomb can be refused before
 * any library inflates it. Declared sizes are checked here; the library must still not be trusted
 * with an archive that lies, so mammoth only ever sees files that passed this check.
 */
export function inspectZip(bytes: Buffer): ZipEntry[] {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new UploadRejected('The Word document is damaged (no ZIP directory).');
  const count = bytes.readUInt16LE(eocd + 10);
  const dirSize = bytes.readUInt32LE(eocd + 12);
  const dirOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    throw new UploadRejected('ZIP64 archives are not accepted.');
  }
  if (count > MAX_ZIP_ENTRIES) throw new UploadRejected('The Word document has too many parts.');
  if (dirOffset + dirSize > bytes.length) throw new UploadRejected('The Word document is damaged.');

  const entries: ZipEntry[] = [];
  let pos = dirOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50) {
      throw new UploadRejected('The Word document is damaged (bad ZIP entry).');
    }
    const flags = bytes.readUInt16LE(pos + 8);
    const method = bytes.readUInt16LE(pos + 10);
    const compressedSize = bytes.readUInt32LE(pos + 20);
    const uncompressedSize = bytes.readUInt32LE(pos + 24);
    const nameLen = bytes.readUInt16LE(pos + 28);
    const extraLen = bytes.readUInt16LE(pos + 30);
    const commentLen = bytes.readUInt16LE(pos + 32);
    const localHeaderOffset = bytes.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen > bytes.length) throw new UploadRejected('The Word document is damaged.');
    if (flags & 0x1) throw new UploadRejected('Encrypted Word documents are not accepted.');
    const name = bytes.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new UploadRejected('ZIP64 archives are not accepted.');
    }
    total += uncompressedSize;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new UploadRejected('The Word document expands to too much data.');
    }
    if (method !== 0 && method !== 8) throw new UploadRejected('The Word document uses an unsupported compression method.');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The sizes in the directory are only what the file claims. Each part is unpacked here with a hard ceiling of its
 * claimed size, so a part that expands to more than it declared is refused before mammoth unpacks it without limit.
 */
export function verifyZipSizes(bytes: Buffer, entries: ZipEntry[]): void {
  for (const e of entries) {
    const at = e.localHeaderOffset;
    if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== 0x04034b50) {
      throw new UploadRejected('The Word document is damaged (bad ZIP entry).');
    }
    const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
    const end = start + e.compressedSize;
    if (end > bytes.length) throw new UploadRejected('The Word document is damaged.');
    const data = bytes.subarray(start, end);
    let actual: number;
    if (e.method === 0) {
      actual = data.length;
    } else {
      try {
        // One byte of headroom: a part that fills it has more than it declared.
        actual = inflateRawSync(data, { maxOutputLength: e.uncompressedSize + 1 }).length;
      } catch (err) {
        if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new UploadRejected('The Word document expands to more data than it declares.');
        }
        throw new UploadRejected('The Word document is damaged.');
      }
    }
    if (actual !== e.uncompressedSize) throw new UploadRejected('The Word document expands to more data than it declares.');
  }
}

function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UploadRejected('The file is not valid UTF-8 text. Save it as UTF-8 and upload it again.');
  }
}

async function readDocx(bytes: Buffer): Promise<string> {
  const entries = inspectZip(bytes);
  if (!entries.some((e) => e.name === 'word/document.xml')) {
    throw new UploadRejected('The file is not a Word document (no word/document.xml).');
  }
  const body = entries.find((e) => e.name === 'word/document.xml');
  if (body && body.uncompressedSize > 50 * 1024 * 1024) {
    throw new UploadRejected('The Word document body is too large.');
  }
  verifyZipSizes(bytes, entries);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth') as MammothApi;
  try {
    const html = (await mammoth.convertToHtml({ buffer: bytes }, { transformDocument: tablesAsRows })).value;
    return htmlToText(html);
  } catch {
    throw new UploadRejected('The Word document could not be read.');
  }
}

interface MammothApi {
  convertToHtml(input: { buffer: Buffer }, options: { transformDocument(doc: DocNode): DocNode }): Promise<{ value: string }>;
}

interface DocNode {
  type: string;
  value?: string;
  children?: DocNode[];
}

/** Word splits words across runs, so runs join with nothing; a paragraph, cell or row ends with a space. */
const BLOCKS = new Set(['paragraph', 'tableCell', 'tableRow', 'table']);
const textOf = (n: DocNode): string => {
  if (n.type === 'text') return n.value ?? '';
  if (n.type === 'tab' || n.type === 'break') return ' ';
  const inner = (n.children ?? []).map(textOf).join('');
  return BLOCKS.has(n.type) ? `${inner} ` : inner;
};

/**
 * A table row is one thing someone said, so each row becomes one line ("Sam | Send the budget | Friday")
 * instead of one line per cell, which would separate the owner from the action. Only the public mammoth API is used.
 */
function tablesAsRows(node: DocNode): DocNode {
  const walk = (n: DocNode): DocNode[] => {
    if (n.type === 'table') {
      const rows: DocNode[] = [];
      for (const row of (n.children ?? []).filter((c) => c.type === 'tableRow')) {
        const cells = (row.children ?? []).filter((c) => c.type === 'tableCell').map((c) => textOf(c).replace(/\s+/g, ' ').trim());
        if (cells.every((c) => c === '')) continue;
        rows.push({ type: 'paragraph', children: [{ type: 'run', children: [{ type: 'text', value: cells.join(' | ') }] }] });
      }
      return rows;
    }
    return [n.children ? { ...n, children: n.children.flatMap(walk) } : n];
  };
  return walk(node)[0];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text of mammoth's HTML, with one blank line after each paragraph, heading or list item, like the raw-text reader gave. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/**
 * A PDF can hide a compressed stream that unpacks to gigabytes, and pdf.js has no ceiling of its own. So each PDF is
 * read in a worker thread that is stopped when it runs too long or the process grows too much, and the API thread
 * never blocks on it. Only a few run at once. Technical defaults, not product policy.
 */
export const PDF_LIMITS = { timeoutMs: 60_000, maxGrowthBytes: 768 * 1024 * 1024, heapMb: 512, concurrent: 2 };

let pdfRunning = 0;
const pdfWaiting: Array<() => void> = [];

async function readPdf(bytes: Buffer): Promise<string> {
  if (pdfRunning >= PDF_LIMITS.concurrent) await new Promise<void>((go) => pdfWaiting.push(go));
  pdfRunning += 1;
  try {
    return await readPdfInWorker(bytes);
  } finally {
    pdfRunning -= 1;
    pdfWaiting.shift()?.();
  }
}

function readPdfInWorker(bytes: Buffer): Promise<string> {
  const tooBig = () => new UploadRejected('The PDF could not be read: it needs more time or memory than allowed.');
  return new Promise((resolveText, reject) => {
    const worker = new Worker(join(__dirname, 'pdf-text.worker.js'), {
      workerData: new Uint8Array(bytes),
      resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.heapMb },
    });
    const baseline = process.memoryUsage().rss;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(tooBig())), PDF_LIMITS.timeoutMs);
    // pdf.js decodes into ArrayBuffers, which the heap limit does not cover, so the whole process is watched too.
    const watch = setInterval(() => {
      if (process.memoryUsage().rss - baseline > PDF_LIMITS.maxGrowthBytes) finish(() => reject(tooBig()));
    }, 50);
    worker.once('message', (reply: { ok: true; text: string } | { ok: false; rejected: string | null }) =>
      finish(() => (reply.ok ? resolveText(reply.text) : reject(new UploadRejected(reply.rejected ?? 'The PDF could not be read.')))),
    );
    worker.once('error', (err: Error & { code?: string }) =>
      finish(() => reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooBig() : new UploadRejected('The PDF could not be read.'))),
    );
    worker.once('exit', () => finish(() => reject(new UploadRejected('The PDF could not be read.'))));
  });
}

export interface ReadFile {
  kind: FileKind;
  mediaType: string;
  text: string;
}

/** Checks an uploaded file and returns its normalised text. Throws UploadRejected with a plain-language reason. */
export async function readUpload(filename: string, bytes: Buffer): Promise<ReadFile> {
  if (bytes.length === 0) throw new UploadRejected('The file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB.`);
  }
  const kind = kindFromFilename(filename);
  checkSignature(kind, bytes);

  let raw: string;
  if (kind === 'txt' || kind === 'md') raw = decodeUtf8Strict(bytes);
  else if (kind === 'docx') raw = await readDocx(bytes);
  else raw = await readPdf(bytes);

  try {
    return { kind, mediaType: MEDIA_TYPES[kind], text: normaliseText(raw) };
  } catch (err) {
    if (err instanceof NoteTextError) {
      if (kind === 'pdf' && err.message === 'The text is empty.') {
        throw new UploadRejected(
          'No selectable text was found in this PDF. Scanned PDFs are not supported yet; use a PDF with selectable text.',
        );
      }
      throw new UploadRejected(err.message);
    }
    throw err;
  }
}
