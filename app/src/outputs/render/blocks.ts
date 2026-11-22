import { Lexer, type Token, type Tokens } from 'marked';

/** What the renderers share: a small block model parsed from the Markdown body of a draft version (D77). */
export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Block[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'footnotes'; items: Array<{ label: string; inlines: Inline[] }> };

/** A generated file may not exceed 25 MiB (spec 6.3). */
export const MAX_RENDER_BYTES = 25 * 1024 * 1024;

export class RenderTooLarge extends Error {
  constructor() {
    super('This document is too large to generate');
    this.name = 'RenderTooLarge';
  }
}

/** Refuses obviously huge input before any work is done. */
export function checkInputSize(input: string | Block[]): void {
  const chars = typeof input === 'string' ? input.length : blockChars(input);
  if (chars > MAX_RENDER_BYTES) throw new RenderTooLarge();
}

export function checkOutputSize(bytes: Buffer): Buffer {
  if (bytes.length > MAX_RENDER_BYTES) throw new RenderTooLarge();
  return bytes;
}

function inlineChars(inlines: Inline[]): number {
  let n = 0;
  for (const i of inlines) n += i.text.length + (i.href?.length ?? 0);
  return n;
}

function blockChars(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'heading' || b.kind === 'paragraph') n += inlineChars(b.inlines);
    else if (b.kind === 'list') for (const item of b.items) n += blockChars(item);
    else if (b.kind === 'table') {
      for (const c of b.header) n += inlineChars(c);
      for (const r of b.rows) for (const c of r) n += inlineChars(c);
    } else if (b.kind === 'quote') n += blockChars(b.blocks);
    else if (b.kind === 'footnotes') for (const f of b.items) n += f.label.length + inlineChars(f.inlines);
  }
  return n;
}

type Style = { bold?: boolean; italic?: boolean; href?: string };

const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm;

/** Only web and mail links are kept; Kainow record links (`#/…`) become absolute. Anything else is dropped (the text stays). */
function safeHref(href: string, appUrl: string): string | undefined {
  const h = href.trim();
  if (h.startsWith('#/')) return `${appUrl.replace(/\/+$/, '')}/${h}`;
  if (/^(https?:|mailto:)/i.test(h)) return h;
  return undefined;
}

function inlines(tokens: Token[] | undefined, appUrl: string, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  const push = (text: string, extra: Partial<Inline> = {}): void => {
    if (text === '') return;
    const i: Inline = { text };
    if (style.bold) i.bold = true;
    if (style.italic) i.italic = true;
    if (style.href) i.href = style.href;
    Object.assign(i, extra);
    out.push(i);
  };
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0) out.push(...inlines(tt.tokens, appUrl, style));
        else push(tt.text.replace(/\[\^([^\]\s]+)\]/g, '[$1]'));
        break;
      }
      case 'escape':
        push((t as Tokens.Escape).text);
        break;
      case 'br':
        push('\n');
        break;
      case 'strong':
        out.push(...inlines((t as Tokens.Strong).tokens, appUrl, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inlines((t as Tokens.Em).tokens, appUrl, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inlines((t as Tokens.Del).tokens, appUrl, style));
        break;
      case 'codespan':
        push((t as Tokens.Codespan).text, { code: true });
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const href = safeHref(l.href, appUrl);
        const kids = inlines(l.tokens, appUrl, href ? { ...style, href } : style);
        if (kids.length === 0 && href) push(href, { href });
        else out.push(...kids);
        break;
      }
      case 'image':
        push((t as Tokens.Image).text);
        break;
      default:
        push((t as { raw?: string }).raw ?? '');
    }
  }
  return out;
}

function listBlock(list: Tokens.List, appUrl: string, depth: number): Block {
  const items: Block[][] = [];
  const addItems = (l: Tokens.List): void => {
    for (const item of l.items) {
      const blocks: Block[] = [];
      const hoisted: Tokens.List[] = [];
      for (const t of item.tokens) {
        // Below the second level a nested list becomes more items of the second-level list.
        if (t.type === 'list' && depth >= 2) hoisted.push(t as Tokens.List);
        else blocks.push(...blockTokens([t], appUrl, depth + 1));
      }
      items.push(blocks);
      for (const h of hoisted) addItems(h);
    }
  };
  addItems(list);
  return { kind: 'list', ordered: list.ordered, items };
}

function paragraphOf(t: Tokens.Paragraph | Tokens.Text, appUrl: string): Block {
  const tokens = t.tokens && t.tokens.length > 0 ? t.tokens : ([{ type: 'text', raw: t.raw, text: t.text }] as Token[]);
  return { kind: 'paragraph', inlines: inlines(tokens, appUrl) };
}

function blockTokens(tokens: Token[], appUrl: string, depth = 1): Block[] {
  const out: Block[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({ kind: 'heading', level: Math.min(3, Math.max(1, h.depth)) as 1 | 2 | 3, inlines: inlines(h.tokens, appUrl) });
        break;
      }
      case 'paragraph':
      case 'text':
        out.push(paragraphOf(t as Tokens.Paragraph | Tokens.Text, appUrl));
        break;
      case 'code':
        out.push({ kind: 'paragraph', inlines: [{ text: (t as Tokens.Code).text, code: true }] });
        break;
      case 'list':
        out.push(listBlock(t as Tokens.List, appUrl, depth));
        break;
      case 'table': {
        const tb = t as Tokens.Table;
        out.push({ kind: 'table', header: tb.header.map((c) => inlines(c.tokens, appUrl)), rows: tb.rows.map((r) => r.map((c) => inlines(c.tokens, appUrl))) });
        break;
      }
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blockTokens((t as Tokens.Blockquote).tokens, appUrl, depth) });
        break;
      case 'hr':
        out.push({ kind: 'rule' });
        break;
      default: {
        const raw = ((t as { raw?: string }).raw ?? '').trim();
        if (raw !== '') out.push({ kind: 'paragraph', inlines: [{ text: raw }] });
      }
    }
  }
  return out;
}

/** Parses the Markdown body into blocks. Tokens only: nothing is rendered to HTML. */
export function parseBlocks(markdown: string, appUrl: string): Block[] {
  checkInputSize(markdown);
  const defs: Array<{ label: string; text: string }> = [];
  const body = markdown.replace(FOOTNOTE_DEF, (_m, label: string, text: string) => {
    defs.push({ label, text });
    return '';
  });
  const blocks = blockTokens(new Lexer().lex(body), appUrl);
  if (defs.length > 0) {
    const last = [...blocks].reverse().find((b) => b.kind === 'heading');
    const underSources = last !== undefined && last.kind === 'heading' && plainText(last.inlines).trim().toLowerCase() === 'sources';
    if (!underSources) blocks.push({ kind: 'heading', level: 2, inlines: [{ text: 'Sources' }] });
    blocks.push({ kind: 'footnotes', items: defs.map((d) => ({ label: d.label, inlines: inlines(Lexer.lexInline(d.text), appUrl) })) });
  }
  return blocks;
}

/** Links in generated files read as text plus the URL, so the address survives printing. */
export function withVisibleLinks(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const i of list) {
    out.push(i);
    if (i.href && i.text.trim() !== i.href) out.push({ text: ` (${i.href})`, ...(i.bold ? { bold: true } : {}), ...(i.italic ? { italic: true } : {}) });
  }
  return out;
}

export function plainText(list: Inline[]): string {
  return list.map((i) => i.text).join('');
}
