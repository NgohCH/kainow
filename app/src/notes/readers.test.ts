import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDocx, makePdf, makeZip } from '../testing/files';
import { MAX_ZIP_ENTRIES, UploadRejected, inspectZip, readUpload } from './readers';
import { MAX_UPLOAD_BYTES } from './text';

const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof UploadRejected && re.test(e.message));

test('plain text and Markdown are read as UTF-8 and normalised', async () => {
  const txt = await readUpload('notes.txt', Buffer.from('﻿Ali: ship Friday\r\nSam: café', 'utf8'));
  assert.equal(txt.text, 'Ali: ship Friday\nSam: café');
  assert.equal(txt.mediaType, 'text/plain');
  const md = await readUpload('NOTES.MD', Buffer.from('# Title\n- item', 'utf8'));
  assert.equal(md.kind, 'md');
  assert.equal(md.text, '# Title\n- item');
});

test('text that is not UTF-8 is refused, not guessed at', async () => {
  await rejects(readUpload('a.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])), /UTF-8/);
});

test('text with a NUL byte is refused', async () => {
  await rejects(readUpload('a.txt', Buffer.from('a\u0000b')), /NUL/);
});

test('empty and blank files are refused', async () => {
  await rejects(readUpload('a.txt', Buffer.alloc(0)), /empty/);
  await rejects(readUpload('a.txt', Buffer.from('  \n ')), /empty/);
});

test('only the four supported types are accepted, and a missing extension is refused', async () => {
  for (const name of ['a.exe', 'a.doc', 'a.html', 'notes', 'a.txt.exe']) {
    await rejects(readUpload(name, Buffer.from('hello')), /Only \.txt/);
  }
});

test('the size limit applies', async () => {
  await rejects(readUpload('a.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61)), /larger than/);
});

test('a real Word document gives its paragraphs', async () => {
  const docx = makeDocx(['Decisions', 'We agreed to ship on Friday.', 'Café & <tea>']);
  const r = await readUpload('minutes.docx', docx);
  assert.equal(r.kind, 'docx');
  assert.equal(r.text, 'Decisions\n\nWe agreed to ship on Friday.\n\nCafé & <tea>\n\n');
});

test('a Word file that is not a ZIP, or has no body, is refused', async () => {
  await rejects(readUpload('a.docx', Buffer.from('just text')), /not a Word document/);
  await rejects(readUpload('a.docx', makeZip([{ name: 'other.txt', data: 'x' }])), /word\/document\.xml/);
});

test('a ZIP bomb is refused from its directory, before anything is inflated', async () => {
  const bomb = makeZip([
    { name: '[Content_Types].xml', data: '<x/>' },
    { name: 'word/document.xml', data: Buffer.alloc(60 * 1024 * 1024, 0x20) },
  ]);
  assert.ok(bomb.length < 1024 * 1024, 'the archive itself is small');
  await rejects(readUpload('a.docx', bomb), /too large|too much/);
});

test('an archive with too many parts is refused', async () => {
  const many = makeZip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
  assert.throws(() => inspectZip(many), /too many parts/);
});

test('a real text PDF gives its text', async () => {
  const r = await readUpload('minutes.pdf', makePdf(['Decision: ship on Friday.', 'Action: Ali emails Sam.']));
  assert.equal(r.kind, 'pdf');
  assert.match(r.text, /Decision: ship on Friday\./);
  assert.match(r.text, /Action: Ali emails Sam\./);
});

test('a PDF with no selectable text is refused with a clear reason', async () => {
  await rejects(readUpload('scan.pdf', makePdf([])), /No selectable text/);
});

test('a file whose content does not match its name is refused', async () => {
  await rejects(readUpload('a.pdf', Buffer.from('plain text pretending')), /not a PDF/);
  await rejects(readUpload('a.pdf', makeDocx(['x'])), /not a PDF/);
  await rejects(readUpload('a.docx', makePdf(['x'])), /not a Word document/);
});

test('a damaged PDF is refused', async () => {
  await rejects(readUpload('a.pdf', Buffer.from('%PDF-1.4\nthis is not really a pdf')), /could not be read/);
});
