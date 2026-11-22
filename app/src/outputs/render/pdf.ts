import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { readImage } from '../../organisation/image';
import { checkInputSize, checkOutputSize, plainText, withVisibleLinks, type Block, type Inline } from './blocks';
import { headerLines, type DocumentHeader } from './header';

const FONT_DIR = join(__dirname, '..', '..', '..', 'assets', 'fonts');
const MM = 72 / 25.4;
const MARGIN = 20 * MM;
const BODY = 10.5;
const GREY = '#595959';
const LINK = '#1F4E9C';
const CODE = '#7A2E2E';
const BLACK = '#000000';

type Doc = InstanceType<typeof PDFDocument>;

function fontFor(i: Inline): 'Regular' | 'Bold' | 'Italic' {
  if (i.bold) return 'Bold';
  if (i.italic) return 'Italic';
  return 'Regular';
}

class Writer {
  constructor(private readonly doc: Doc) {}

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Starts a new page when fewer than `space` points remain. */
  ensure(space: number): void {
    if (this.doc.y + space > this.bottom) this.doc.addPage();
  }

  runs(list: Inline[], x: number, width: number, base: { size?: number; bold?: boolean; color?: string } = {}): void {
    const { doc } = this;
    const parts = withVisibleLinks(list).filter((i) => i.text !== '');
    const size = base.size ?? BODY;
    doc.fontSize(size);
    if (parts.length === 0) {
      doc.font('Regular').text(' ', x, doc.y, { width });
      return;
    }
    parts.forEach((i, n) => {
      doc.font(base.bold ? 'Bold' : fontFor(i)).fillColor(i.href ? LINK : i.code ? CODE : (base.color ?? BLACK));
      const opts: PDFKit.Mixins.TextOptions = { continued: n < parts.length - 1, link: i.href, underline: !!i.href };
      if (n === 0) doc.text(i.text, x, doc.y, { ...opts, width });
      else doc.text(i.text, opts);
    });
    doc.fillColor(BLACK);
  }

  blocks(blocks: Block[], x: number, width: number): void {
    const { doc } = this;
    for (const b of blocks) {
      switch (b.kind) {
        case 'heading': {
          const size = b.level === 1 ? 17 : b.level === 2 ? 13.5 : 11.5;
          this.ensure(size * 3);
          doc.y += b.level === 1 ? 10 : 7;
          this.runs(b.inlines, x, width, { size, bold: true });
          doc.y += 4;
          break;
        }
        case 'paragraph':
          this.ensure(BODY * 2);
          this.runs(b.inlines, x, width);
          doc.y += 6;
          break;
        case 'list':
          this.list(b, x, width, 0);
          doc.y += 3;
          break;
        case 'table':
          this.table(b, x, width);
          doc.y += 8;
          break;
        case 'quote': {
          const page = doc.page;
          const y0 = doc.y;
          this.blocks(b.blocks, x + 14, width - 14);
          if (doc.page === page) doc.moveTo(x + 4, y0).lineTo(x + 4, doc.y - 4).lineWidth(2).strokeColor('#A6A6A6').stroke();
          doc.strokeColor(BLACK).lineWidth(1);
          break;
        }
        case 'rule':
          this.ensure(16);
          doc.moveTo(x, doc.y + 4).lineTo(x + width, doc.y + 4).lineWidth(0.7).strokeColor('#A6A6A6').stroke();
          doc.strokeColor(BLACK).lineWidth(1);
          doc.y += 12;
          break;
        case 'footnotes':
          for (const f of b.items) {
            this.ensure(BODY * 2);
            this.runs([{ text: `[${f.label}] `, bold: true }, ...f.inlines], x, width, { size: 9.5 });
            doc.y += 3;
          }
          break;
      }
    }
  }

  private list(list: Extract<Block, { kind: 'list' }>, x: number, width: number, level: number): void {
    const { doc } = this;
    const indent = list.ordered ? 24 : 16;
    list.items.forEach((item, n) => {
      this.ensure(BODY * 2.5);
      const y0 = doc.y;
      const marker = list.ordered ? `${level === 0 ? n + 1 : String.fromCharCode(97 + (n % 26))}.` : level === 0 ? '•' : '–';
      doc.font('Regular').fontSize(BODY).fillColor(BLACK).text(marker, x, y0, { width: indent - 4, lineBreak: false });
      doc.y = y0;
      for (const block of item) {
        if (block.kind === 'list') this.list(block, x + indent, width - indent, Math.min(level + 1, 1));
        else {
          this.blocks([block], x + indent, width - indent);
          doc.y -= block.kind === 'paragraph' ? 3 : 0;
        }
      }
      doc.y += 2;
    });
  }

  private table(t: Extract<Block, { kind: 'table' }>, x: number, width: number): void {
    const { doc } = this;
    const cols = Math.max(1, t.header.length);
    const colW = width / cols;
    const pad = 4;
    const row = (cells: Inline[][], head: boolean): void => {
      const padded = Array.from({ length: cols }, (_v, n) => cells[n] ?? []);
      doc.font(head ? 'Bold' : 'Regular').fontSize(9.5);
      const h = Math.max(...padded.map((c) => doc.heightOfString(plainText(withVisibleLinks(c)) || ' ', { width: colW - pad * 2 }))) + pad * 2;
      this.ensure(h);
      const y = doc.y;
      padded.forEach((c, n) => {
        const cx = x + n * colW;
        if (head) doc.rect(cx, y, colW, h).fillAndStroke('#E7E6E6', '#808080');
        else doc.rect(cx, y, colW, h).lineWidth(0.5).strokeColor('#808080').stroke();
        doc.fillColor(BLACK).strokeColor(BLACK).lineWidth(1);
        doc.y = y + pad;
        this.runs(c, cx + pad, colW - pad * 2, { size: 9.5, bold: head });
      });
      doc.y = y + h;
    };
    row(t.header, true);
    for (const r of t.rows) row(r, false);
  }
}

function drawLetterhead(doc: Doc, w: Writer, h: DocumentHeader, width: number): void {
  const lines = headerLines(h);
  const image = h.logo ? readImage(h.logo.content) : null;
  let nameX = MARGIN;
  const top = doc.y;
  if (h.logo && image) {
    const scale = Math.min(h.logo.box.width / image.width, h.logo.box.height / image.height, 1);
    const iw = image.width * scale;
    const ih = image.height * scale;
    doc.image(h.logo.content, MARGIN, top, { width: iw, height: ih });
    nameX = MARGIN + iw + 12;
    doc.font('Bold').fontSize(12).fillColor(BLACK).text(h.organisationName, nameX, top + Math.max(0, (ih - 14) / 2), { width: width - (nameX - MARGIN) });
    doc.y = Math.max(doc.y, top + ih);
  } else {
    doc.font('Bold').fontSize(12).fillColor(BLACK).text(h.organisationName, MARGIN, top, { width });
  }
  doc.y += 14;
  w.runs([{ text: lines[0] }], MARGIN, width, { size: 20, bold: true });
  doc.y += 6;
  lines.slice(1).forEach((line) => {
    const status = line === 'Draft — not approved';
    w.runs([{ text: line, bold: status }], MARGIN, width, { size: 9.5, color: status ? BLACK : GREY });
    doc.y += 1;
  });
  doc.y += 6;
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.7).strokeColor('#A6A6A6').stroke();
  doc.strokeColor(BLACK).lineWidth(1);
  doc.y += 10;
}

export async function renderPdf(h: DocumentHeader, blocks: Block[]): Promise<Buffer> {
  checkInputSize(blocks);
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: { Title: h.title, Author: h.organisationName, Creator: 'Kainow', Producer: 'Kainow', CreationDate: h.generatedAt },
  });
  doc.registerFont('Regular', join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont('Bold', join(FONT_DIR, 'NotoSans-Bold.ttf'));
  doc.registerFont('Italic', join(FONT_DIR, 'NotoSans-Italic.ttf'));
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const writer = new Writer(doc);
  drawLetterhead(doc, writer, h, width);
  writer.blocks(blocks, MARGIN, width);

  const { count } = doc.bufferedPageRange();
  for (let i = 0; i < count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // the footer sits in the margin; this stops it starting a new page
    doc.font('Regular').fontSize(8).fillColor(GREY).text(`${h.title} · Version ${h.versionNo} · Page ${i + 1} of ${count}`, MARGIN, doc.page.height - MARGIN + 6, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return checkOutputSize(await done);
}
