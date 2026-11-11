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
  compressedSize: number;
  uncompressedSize: number;
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
    const compressedSize = bytes.readUInt32LE(pos + 20);
    const uncompressedSize = bytes.readUInt32LE(pos + 24);
    const nameLen = bytes.readUInt16LE(pos + 28);
    const extraLen = bytes.readUInt16LE(pos + 30);
    const commentLen = bytes.readUInt16LE(pos + 32);
    if (pos + 46 + nameLen > bytes.length) throw new UploadRejected('The Word document is damaged.');
    if (flags & 0x1) throw new UploadRejected('Encrypted Word documents are not accepted.');
    const name = bytes.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new UploadRejected('ZIP64 archives are not accepted.');
    }
    total += uncompressedSize;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new UploadRejected('The Word document expands to too much data.');
    }
    entries.push({ name, compressedSize, uncompressedSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
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

// pdfjs-dist is ESM only and this project compiles to CommonJS, so the import must not be rewritten to require().
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

async function readPdf(bytes: Buffer): Promise<string> {
  const pdfjs = await importEsm('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc: any;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err && (err as { name?: string }).name === 'PasswordException') {
      throw new UploadRejected('Password-protected PDFs are not accepted.');
    }
    throw new UploadRejected('The PDF could not be read.');
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new UploadRejected(`The PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    const pages: string[] = [];
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      const text = lines.join('\n');
      chars += text.length;
      if (chars > MAX_TEXT_CHARS * 2) {
        throw new UploadRejected('The PDF has too much text.');
      }
      pages.push(text);
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
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
