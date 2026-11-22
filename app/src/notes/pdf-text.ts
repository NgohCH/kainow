import { MAX_TEXT_CHARS } from './text';
import { MAX_PDF_PAGES, UploadRejected } from './readers';

/** Reads a PDF's selectable text. Runs inside pdf-text.worker, never on the API thread. */
// pdfjs-dist is ESM only and this project compiles to CommonJS, so the import must not be rewritten to require().
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

export async function extractPdfText(bytes: Buffer): Promise<string> {
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
