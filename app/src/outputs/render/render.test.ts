import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import mammoth from 'mammoth';
import { Pool } from 'pg';
import { loadDatabaseConfig } from '../../config';
import { runMigrations } from '../../db/migrate';
import { SKIP_NO_DB, resetPublicSchema, testDatabaseUrl } from '../../testing/db';
import { RenderTooLarge, parseBlocks, type Block } from './blocks';
import { renderDocx } from './docx';
import { loadDocumentHeader, headerLines, type DocumentHeader } from './header';
import { renderMarkdown } from './markdown';
import { renderPdf } from './pdf';
import { defaultLogo } from '../../organisation/branding';

const APP_URL = 'https://kainow.example.org';

// pdfjs-dist is ESM only and this project compiles to CommonJS, so the import must not be rewritten to require().
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

async function pdfPages(bytes: Buffer): Promise<string[]> {
  const pdfjs = await importEsm('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    pages.push(content.items.map((i: any) => i.str + (i.hasEOL ? '\n' : ' ')).join(''));
  }
  return pages;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

const LOGO = defaultLogo('wide');
function header(over: Partial<DocumentHeader> = {}): DocumentHeader {
  return {
    organisationName: 'Example Organisation',
    logo: { content: LOGO.content, mime: LOGO.mime, box: { width: 120, height: 40 } },
    title: 'Monthly progress report',
    projectName: 'Harbour Road Upgrade',
    reportType: 'Progress report',
    versionNo: 3,
    issueDate: '2026-11-05',
    aiAssisted: true,
    generatedAt: new Date('2026-11-20T01:07:00Z'),
    ...over,
  };
}

const BODY = [
  '# Overview',
  '',
  'This has **bold**, *italic*, `code` and a [site link](https://example.org/a) plus [a record](#/projects/p1) and a note.[^P1]',
  '',
  '## Progress',
  '',
  '- First item',
  '  - Nested item',
  '    - Too deep item',
  '- Second item',
  '',
  '1. Step one',
  '2. Step two',
  '',
  '| Task | Status |',
  '| --- | --- |',
  '| Piling | Done |',
  '| Deck | Late |',
  '',
  '> Quoted words',
  '',
  '---',
  '',
  '### Closing',
  '',
  'Final paragraph.',
  '',
  '## Sources',
  '',
  '[^P1]: [Site diary, 3 Nov](#/projects/p1/notes/n1)',
  '',
].join('\n');

function texts(blocks: Block[]): string {
  return JSON.stringify(blocks);
}

describe('parseBlocks', () => {
  test('parseBlocks covers headings, emphasis, code, links, two-level lists, tables, quotes, rules and footnotes', () => {
    const blocks = parseBlocks(BODY, APP_URL);
    const kinds = blocks.map((b) => b.kind);
    assert.deepEqual(kinds, ['heading', 'paragraph', 'heading', 'list', 'list', 'table', 'quote', 'rule', 'heading', 'paragraph', 'heading', 'footnotes']);
    const h1 = blocks[0] as Extract<Block, { kind: 'heading' }>;
    assert.equal(h1.level, 1);
    const p = blocks[1] as Extract<Block, { kind: 'paragraph' }>;
    assert.ok(p.inlines.some((i) => i.text === 'bold' && i.bold));
    assert.ok(p.inlines.some((i) => i.text === 'italic' && i.italic));
    assert.ok(p.inlines.some((i) => i.text === 'code' && i.code));
    assert.ok(p.inlines.some((i) => i.text === 'site link' && i.href === 'https://example.org/a'));
    assert.ok(p.inlines.some((i) => i.text.includes('[P1]')), 'footnote reference stays readable');
    // two levels: the third level is flattened into the second
    const bullets = blocks[3] as Extract<Block, { kind: 'list' }>;
    assert.equal(bullets.ordered, false);
    assert.equal(bullets.items.length, 2);
    const nested = bullets.items[0].find((b) => b.kind === 'list') as Extract<Block, { kind: 'list' }>;
    assert.ok(nested, 'second level kept');
    assert.equal(nested.items.length, 2, 'third level hoisted into the second');
    assert.ok(!nested.items.some((it) => it.some((b) => b.kind === 'list')));
    assert.equal((blocks[4] as Extract<Block, { kind: 'list' }>).ordered, true);
    const table = blocks[5] as Extract<Block, { kind: 'table' }>;
    assert.equal(table.header.length, 2);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[1][1][0].text, 'Late');
    const foot = blocks[11] as Extract<Block, { kind: 'footnotes' }>;
    assert.equal(foot.items[0].label, 'P1');
    assert.equal(foot.items[0].inlines[0].text, 'Site diary, 3 Nov');
  });

  test('Kainow record links become absolute', () => {
    const blocks = parseBlocks(BODY, `${APP_URL}/`);
    const json = texts(blocks);
    assert.ok(json.includes('"href":"https://kainow.example.org/#/projects/p1"'));
    assert.ok(json.includes('"href":"https://kainow.example.org/#/projects/p1/notes/n1"'));
    assert.ok(!json.includes('"href":"#/'));
  });

  test('unsafe links keep their text but lose the address; unknown tokens become plain text', () => {
    const blocks = parseBlocks('[click](javascript:alert(1)) and R&D <b>x</b> < 5\n\n<div>raw</div>', APP_URL);
    const json = texts(blocks);
    assert.ok(!json.includes('javascript'));
    assert.ok(json.includes('click'));
    assert.ok(json.includes('R&D'));
    assert.ok(json.includes('raw'));
  });
});

describe('header', () => {
  test('header lines are exact, dated in UTC+8, and the AI line appears only when aiAssisted', () => {
    const lines = headerLines(header({ generatedAt: new Date('2026-11-20T17:30:00Z') }));
    assert.deepEqual(lines, [
      'Monthly progress report',
      'Harbour Road Upgrade · Progress report · Version 3 · Issued 5 November 2026',
      'Draft — not approved',
      'Prepared with AI assistance; facts from Kainow records',
      'Generated by Kainow on 21 November 2026 01:30 UTC+8',
    ]);
    const plain = headerLines(header({ aiAssisted: false }));
    assert.equal(plain.length, 4);
    assert.ok(!plain.some((l) => l.includes('AI assistance')));
  });
});

describe('renderers', () => {
  const blocks = parseBlocks(BODY, APP_URL);
  const ORDER = ['Overview', 'This has bold, italic, code', 'Progress', 'First item', 'Nested item', 'Too deep item', 'Second item', 'Step one', 'Step two', 'Task', 'Piling', 'Late', 'Quoted words', 'Closing', 'Final paragraph.', 'Sources', 'Site diary, 3 Nov'];

  /** Whitespace is ignored: pdf text extraction puts spaces between differently styled runs. */
  function assertInOrder(raw: string, wanted: string[]): void {
    const strip = (v: string): string => v.replace(/\s+/g, '');
    const text = strip(raw);
    const parts = wanted.map(strip);
    let at = 0;
    for (const part of parts) {
      const i = text.indexOf(part, at);
      assert.ok(i >= 0, `"${part}" missing or out of order`);
      at = i + part.length;
    }
  }

  test('docx contains header lines and every block\'s text in order', async () => {
    const h = header();
    const buf = await renderDocx(h, blocks);
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const text = squash((await mammoth.extractRawText({ buffer: buf })).value);
    assertInOrder(text, [...headerLines(h).map(squash), ...ORDER]);
    assert.ok(text.includes('https://kainow.example.org/#/projects/p1'), 'links carry their URL');
    assert.ok(text.includes('Example Organisation'));
  });

  test('docx uses Word styles and a Table Grid', async () => {
    const buf = await renderDocx(header(), blocks);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);
    const doc: string = await zip.file('word/document.xml').async('string');
    const styles: string = await zip.file('word/styles.xml').async('string');
    for (const id of ['Heading1', 'Heading2', 'Heading3', 'ListBullet', 'ListNumber', 'TableGrid']) {
      assert.ok(styles.includes(`w:styleId="${id}"`), `${id} defined`);
    }
    assert.ok(doc.includes('w:val="Heading1"') && doc.includes('w:val="ListBullet"') && doc.includes('w:val="ListNumber"') && doc.includes('w:val="TableGrid"'));
    assert.ok(zip.file(/footer/).length > 0, 'footer part present');
  });

  test('pdf contains header lines, body text and page numbers', async () => {
    const h = header();
    const buf = await renderPdf(h, blocks);
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    const pages = await pdfPages(buf);
    const text = squash(pages.join(' '));
    assertInOrder(text, [...headerLines(h).map(squash), ...ORDER]);
    assert.ok(text.includes('Page 1 of 1'), text);
    assert.ok(text.includes('Monthly progress report · Version 3 · Page 1 of 1'));
  });

  test('pdf runs onto further pages with their own page numbers', async () => {
    const many = Array.from({ length: 160 }, (_, i) => `Paragraph number ${i + 1} with some words to fill the line.`).join('\n\n');
    const buf = await renderPdf(header(), parseBlocks(many, APP_URL));
    const pages = await pdfPages(buf);
    assert.ok(pages.length > 2);
    assert.ok(squash(pages[1]).includes(`Page 2 of ${pages.length}`));
    assert.ok(squash(pages[pages.length - 1]).includes('Paragraph number 160'));
  });

  test('Malay text with diacritics round-trips in docx and pdf', async () => {
    const md = 'Mesyuarat jawatankuasa — kemaskini\n\ncafé naïve résumé Şükrü “quoted” RM1,200 ≥ 5';
    const b = parseBlocks(md, APP_URL);
    const h = header({ title: 'Laporan café — kemaskini' });
    const docx = squash((await mammoth.extractRawText({ buffer: await renderDocx(h, b) })).value);
    assert.ok(docx.includes('Mesyuarat jawatankuasa — kemaskini'));
    assert.ok(docx.includes('café naïve résumé'));
    assert.ok(docx.includes('Laporan café — kemaskini'));
    const pdf = squash((await pdfPages(await renderPdf(h, b))).join(' '));
    assert.ok(pdf.includes('Mesyuarat jawatankuasa — kemaskini'), pdf);
    assert.ok(pdf.includes('café naïve résumé'), pdf);
    assert.ok(pdf.includes('Şükrü'), pdf);
  });

  test('AI line appears only when aiAssisted', async () => {
    const line = 'Prepared with AI assistance; facts from Kainow records';
    for (const ai of [true, false]) {
      const h = header({ aiAssisted: ai });
      const md = renderMarkdown(h, BODY).toString('utf8');
      const docx = squash((await mammoth.extractRawText({ buffer: await renderDocx(h, blocks) })).value);
      const pdf = squash((await pdfPages(await renderPdf(h, blocks))).join(' '));
      assert.equal(md.includes(line), ai);
      assert.equal(docx.includes(line), ai);
      assert.equal(pdf.includes(line), ai);
    }
  });

  test('markdown keeps the stored body under a header block', () => {
    const h = header();
    const out = renderMarkdown(h, BODY).toString('utf8');
    for (const l of headerLines(h)) assert.ok(out.includes(l), l);
    assert.ok(out.includes('Example Organisation'));
    assert.ok(out.endsWith(BODY));
    const fromBlocks = renderMarkdown(h, blocks).toString('utf8');
    assert.ok(fromBlocks.includes('| Piling | Done |'));
    assert.ok(fromBlocks.includes('[site link](https://example.org/a)'));
    assert.ok(fromBlocks.includes('[^P1]: [Site diary, 3 Nov]'));
  });

  test('over 25 MiB is refused', async () => {
    const huge = 'x'.repeat(26 * 1024 * 1024);
    assert.throws(() => parseBlocks(huge, APP_URL), RenderTooLarge);
    assert.throws(() => renderMarkdown(header(), huge), (e: Error) => e instanceof RenderTooLarge && e.message === 'This document is too large to generate');
    const big: Block[] = [{ kind: 'paragraph', inlines: [{ text: huge }] }];
    await assert.rejects(renderDocx(header(), big), RenderTooLarge);
    await assert.rejects(renderPdf(header(), big), RenderTooLarge);
  });

  test('a produced file over 25 MiB is refused too (docx embeds the logo bytes whole)', async () => {
    const png = Buffer.concat([defaultLogo('wide').content, randomBytes(26 * 1024 * 1024)]);
    const h = header({ logo: { content: png, mime: 'image/png', box: { width: 120, height: 40 } } });
    await assert.rejects(renderDocx(h, blocks), RenderTooLarge);
  });
});

describe('letterhead', { skip: SKIP_NO_DB }, () => {
  let pool: Pool;
  before(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl() });
    await resetPublicSchema(pool);
    await runMigrations(pool, loadDatabaseConfig({ DATABASE_URL: 'x' }).migrationsDir);
  });
  after(async () => {
    await pool.end();
  });

  test('letterhead uses Kainow\'s own name before registration and the organisation\'s after', async () => {
    const opts = { title: 'T', projectName: 'P', reportType: 'R', versionNo: 1, issueDate: '2026-11-05', aiAssisted: false };
    const before = await loadDocumentHeader(pool, opts);
    assert.equal(before.organisationName, 'Kainow');
    assert.deepEqual(before.logo?.box, { width: 120, height: 40 });
    assert.ok(before.logo && before.logo.content.length > 0);
    await pool.query(`INSERT INTO organisation (id, name, registered_at, updated_at) VALUES (1, 'Example Organisation', now(), now())`);
    const after = await loadDocumentHeader(pool, opts);
    assert.equal(after.organisationName, 'Example Organisation');
    assert.ok(after.generatedAt instanceof Date);
    const pdf = squash((await pdfPages(await renderPdf(after, parseBlocks('Body', APP_URL)))).join(' '));
    assert.ok(pdf.includes('Example Organisation'));
  });
});
