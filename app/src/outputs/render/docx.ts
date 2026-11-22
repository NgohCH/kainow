import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import { readImage } from '../../organisation/image';
import { checkInputSize, checkOutputSize, withVisibleLinks, type Block, type Inline } from './blocks';
import { headerLines, type DocumentHeader } from './header';

const FONT = 'Noto Sans';
const MONO = 'Courier New';
const LINK_COLOUR = '1F4E9C';
const GREY = '595959';

/** Word's built-in "Table Grid" table style, supplied to the document so tables reference it by name. */
const TABLE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="table" w:default="1" w:styleId="TableNormal">
    <w:name w:val="Normal Table"/>
    <w:uiPriority w:val="99"/>
    <w:semiHidden/>
    <w:unhideWhenUsed/>
    <w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:basedOn w:val="TableNormal"/>
    <w:uiPriority w:val="39"/>
    <w:tblPr><w:tblBorders>
      <w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>
      <w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/>
      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/>
      <w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/>
      <w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/>
      <w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/>
    </w:tblBorders></w:tblPr>
  </w:style>
</w:styles>`;

type Ctx = { indent?: number; quote?: boolean };

function runs(list: Inline[], base: { bold?: boolean; size?: number; color?: string } = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const i of withVisibleLinks(list)) {
    const lines = i.text.split('\n');
    const children = lines.map(
      (line, n) =>
        new TextRun({
          text: line,
          break: n > 0 ? 1 : undefined,
          bold: i.bold || base.bold || undefined,
          italics: i.italic || undefined,
          font: i.code ? MONO : undefined,
          size: base.size,
          color: i.href ? LINK_COLOUR : base.color,
          underline: i.href ? {} : undefined,
        }),
    );
    if (i.href) out.push(new ExternalHyperlink({ link: i.href, children }));
    else out.push(...children);
  }
  return out;
}

function fitLogo(h: DocumentHeader): ImageRun | null {
  if (!h.logo) return null;
  const info = readImage(h.logo.content);
  if (!info) return null;
  const scale = Math.min(h.logo.box.width / info.width, h.logo.box.height / info.height, 1);
  return new ImageRun({
    type: info.mime === 'image/png' ? 'png' : 'jpg',
    data: h.logo.content,
    transformation: { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) },
    altText: { name: 'Logo', description: h.organisationName, title: h.organisationName },
  });
}

class Builder {
  private numbered = 0;
  constructor(private readonly h: DocumentHeader) {}

  letterhead(): Array<Paragraph> {
    const lines = headerLines(this.h);
    const out: Paragraph[] = [];
    const logo = fitLogo(this.h);
    if (logo) out.push(new Paragraph({ children: [logo], spacing: { after: 60 } }));
    out.push(new Paragraph({ children: [new TextRun({ text: this.h.organisationName, bold: true, size: 24 })], spacing: { after: 160 } }));
    out.push(new Paragraph({ style: 'Title', children: [new TextRun({ text: lines[0] })] }));
    lines.slice(1).forEach((line, n, all) => {
      const status = line === 'Draft — not approved';
      out.push(
        new Paragraph({
          children: [new TextRun({ text: line, bold: status || undefined, size: 20, color: status ? undefined : GREY })],
          spacing: { after: 40 },
          border: n === all.length - 1 ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'A6A6A6', space: 8 } } : undefined,
        }),
      );
    });
    return out;
  }

  blocks(blocks: Block[], ctx: Ctx = {}): Array<Paragraph | Table> {
    const out: Array<Paragraph | Table> = [];
    for (const b of blocks) {
      switch (b.kind) {
        case 'heading':
          out.push(new Paragraph({ style: `Heading${b.level}`, children: runs(b.inlines), ...this.place(ctx) }));
          break;
        case 'paragraph':
          out.push(new Paragraph({ children: runs(b.inlines), ...this.place(ctx) }));
          break;
        case 'list':
          out.push(...this.list(b, 0, ctx));
          break;
        case 'table':
          out.push(this.table(b));
          out.push(new Paragraph({ spacing: { after: 80 } }));
          break;
        case 'quote':
          out.push(...this.blocks(b.blocks, { indent: (ctx.indent ?? 0) + 540, quote: true }));
          break;
        case 'rule':
          out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'A6A6A6', space: 1 } }, spacing: { after: 160 } }));
          break;
        case 'footnotes':
          for (const f of b.items) {
            out.push(new Paragraph({ children: [new TextRun({ text: `[${f.label}] `, bold: true }), ...runs(f.inlines)], indent: { left: 360, hanging: 360 } }));
          }
          break;
      }
    }
    return out;
  }

  private place(ctx: Ctx): Partial<ConstructorParameters<typeof Paragraph>[0] & object> {
    if (!ctx.indent) return {};
    return {
      indent: { left: ctx.indent },
      border: ctx.quote ? { left: { style: BorderStyle.SINGLE, size: 12, color: 'A6A6A6', space: 8 } } : undefined,
    };
  }

  private list(list: Extract<Block, { kind: 'list' }>, level: number, ctx: Ctx): Paragraph[] {
    const instance = list.ordered ? ++this.numbered : 0;
    const out: Paragraph[] = [];
    for (const item of list.items) {
      let first = true;
      for (const block of item) {
        if (block.kind === 'list') {
          out.push(...this.list(block, Math.min(level + 1, 1), ctx));
          continue;
        }
        const children = block.kind === 'paragraph' || block.kind === 'heading' ? runs(block.inlines) : runs(plainOf(block));
        if (first) {
          out.push(
            new Paragraph({
              style: list.ordered ? 'ListNumber' : 'ListBullet',
              numbering: { reference: list.ordered ? 'numbers' : 'bullets', level, instance },
              children,
            }),
          );
          first = false;
        } else {
          out.push(new Paragraph({ children, indent: { left: 720 * (level + 1) } }));
        }
      }
      if (first) out.push(new Paragraph({ style: list.ordered ? 'ListNumber' : 'ListBullet', numbering: { reference: list.ordered ? 'numbers' : 'bullets', level, instance }, children: [] }));
    }
    return out;
  }

  private table(t: Extract<Block, { kind: 'table' }>): Table {
    const cols = Math.max(1, t.header.length);
    const cell = (inlines: Inline[], head: boolean): TableCell =>
      new TableCell({
        width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE },
        shading: head ? { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' } : undefined,
        children: [new Paragraph({ children: runs(inlines, { bold: head, size: 20 }) })],
      });
    return new Table({
      style: 'TableGrid',
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }),
        ...t.rows.map((r) => new TableRow({ children: Array.from({ length: cols }, (_v, n) => cell(r[n] ?? [], false)) })),
      ],
    });
  }
}

/** Flattens a non-paragraph block that sits inside a list item to its text. */
function plainOf(b: Block): Inline[] {
  switch (b.kind) {
    case 'quote':
      return b.blocks.flatMap(plainOf);
    case 'table':
      return [{ text: [b.header, ...b.rows].map((r) => r.map((c) => c.map((i) => i.text).join('')).join(' | ')).join('\n') }];
    case 'footnotes':
      return b.items.flatMap((f) => [{ text: `[${f.label}] ` }, ...f.inlines]);
    case 'heading':
    case 'paragraph':
      return b.inlines;
    default:
      return [];
  }
}

export async function renderDocx(h: DocumentHeader, blocks: Block[]): Promise<Buffer> {
  checkInputSize(blocks);
  const builder = new Builder(h);
  const bulletLevels = [0, 1].map((level) => ({ level, format: LevelFormat.BULLET, text: level === 0 ? '•' : '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }));
  const numberLevels = [0, 1].map((level) => ({ level, format: level === 0 ? LevelFormat.DECIMAL : LevelFormat.LOWER_LETTER, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }));
  const heading = (size: number) => ({ run: { font: FONT, bold: true, size }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true } });
  const doc = new Document({
    creator: h.organisationName,
    title: h.title,
    description: `${h.projectName} · ${h.reportType} · Version ${h.versionNo}`,
    externalStyles: TABLE_STYLES,
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 }, paragraph: { spacing: { after: 120, line: 276 } } },
        title: { run: { font: FONT, bold: true, size: 40 }, paragraph: { spacing: { after: 120 } } },
        heading1: heading(32),
        heading2: heading(27),
        heading3: heading(23),
      },
      paragraphStyles: [
        { id: 'ListBullet', name: 'List Bullet', basedOn: 'Normal', quickFormat: true, paragraph: { spacing: { after: 60 } } },
        { id: 'ListNumber', name: 'List Number', basedOn: 'Normal', quickFormat: true, paragraph: { spacing: { after: 60 } } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: bulletLevels },
        { reference: 'numbers', levels: numberLevels },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${h.title} · Version ${h.versionNo} · Page `, size: 16, color: GREY }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY }),
                ],
              }),
            ],
          }),
        },
        children: [...builder.letterhead(), ...builder.blocks(blocks)],
      },
    ],
  });
  return checkOutputSize(Buffer.from(await Packer.toBuffer(doc)));
}
