import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatMessageTime, splitPassages } from './passages';

const sentence = (n: number) => `Sentence number ${n} is here and says something plain about the site works.`;
const para = (len: number, tag: string) => `${tag} `.repeat(Math.ceil(len / (tag.length + 1))).slice(0, len).trim();

describe('splitPassages', () => {
  test('splits at blank lines', () => {
    const a = para(300, 'alpha');
    const b = para(300, 'beta');
    const text = `${a}\n\n${b}`;
    const p = splitPassages(text, 'document', {});
    assert.equal(p.length, 2);
    assert.deepEqual(p.map((x) => x.body), [a, b]);
    assert.deepEqual(p.map((x) => x.ordinal), [0, 1]);
    assert.deepEqual(p.map((x) => x.location), ['Paragraph 1', 'Paragraph 2']);
  });

  test('merges a 150-character block with the next', () => {
    const a = para(150, 'short');
    const b = para(400, 'long');
    const p = splitPassages(`${a}\n\n${b}`, 'document', {});
    assert.equal(p.length, 1);
    assert.equal(p[0].body, `${a}\n\n${b}`);
    assert.equal(p[0].start, 0);
  });

  test('splits a 4,000-character block at sentence ends into blocks of at most 1,500', () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ').slice(0, 4000).replace(/[^.]*$/, '');
    assert.ok(text.length > 3000);
    const p = splitPassages(text, 'document', {});
    assert.ok(p.length >= 3);
    for (const x of p) {
      assert.ok(x.body.length <= 1500, `${x.body.length}`);
      assert.match(x.body, /\.$/, 'ends at a sentence end');
    }
  });

  test('location uses the nearest heading', () => {
    const text = `# Minutes\n\nIntro line that is long enough. ${para(220, 'intro')}\n\n## Decisions\n\n${para(250, 'one')}\n\n${para(250, 'two')}`;
    const p = splitPassages(text, 'document', {});
    assert.deepEqual(p.map((x) => x.location), ['§Minutes, paragraph 1', '§Decisions, paragraph 1', '§Decisions, paragraph 2']);
  });

  test('offsets map back to the original text exactly', () => {
    const text = `# Title\n\n${para(500, 'aa')}\n\r\n${para(2600, 'bb. cc')}\n\n  ${para(250, 'dd')}  \n\n${para(40, 'tail')}`;
    for (const x of splitPassages(text, 'document', {})) assert.equal(text.slice(x.start, x.end), x.body);
  });

  test('message is one passage with its label', () => {
    const text = 'Short note.';
    const p = splitPassages(text, 'message', { messageNo: 12, author: 'Siti', at: '11 Nov 10:31' });
    assert.deepEqual(p, [{ ordinal: 0, start: 0, end: text.length, body: text, location: 'Message #12 by Siti, 11 Nov 10:31' }]);
  });

  test('a 2,000-character message splits', () => {
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ').slice(0, 2000).replace(/[^.]*$/, '');
    const p = splitPassages(text, 'message', { messageNo: 1, author: 'Ben', at: '1 Nov 09:00' });
    assert.ok(p.length >= 2);
    for (const x of p) {
      assert.ok(x.body.length <= 1500);
      assert.equal(text.slice(x.start, x.end), x.body);
      assert.equal(x.location, 'Message #1 by Ben, 1 Nov 09:00');
    }
  });

  test('a hard cut never splits a surrogate pair', () => {
    const text = 'a'.repeat(1499) + '😀'.repeat(300);
    const p = splitPassages(text, 'message', { messageNo: 1, author: 'Ada', at: 'x' });
    assert.ok(p.length >= 2);
    for (const x of p) {
      assert.ok(x.body.length <= 1500);
      assert.doesNotMatch(x.body, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
      assert.equal(text.slice(x.start, x.end), x.body);
    }
  });

  test('time is shown in UTC+8', () => {
    assert.equal(formatMessageTime(new Date('2026-11-11T02:31:00Z')), '11 Nov 10:31');
  });
});
