import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NEW_MESSAGES_LINE, type TranscriptMessage, buildTranscript, placeItem } from './transcript';

const msg = (no: number, body: string, over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  no,
  versionId: `v${no}`,
  authorId: 'u1',
  authorName: 'Ada Member',
  at: new Date(Date.UTC(2026, 10, 11, 2, 31)),
  body,
  isContext: false,
  ...over,
});

describe('buildTranscript', () => {
  test('headers use UTC+8 and message numbers', () => {
    const { text, spans } = buildTranscript([msg(12, 'We ship on Friday.')], []);
    assert.ok(text.includes('[#12 · Ada Member · 2026-11-11 10:31]\nWe ship on Friday.'));
    const [s] = spans;
    assert.equal(text.slice(s.bodyStart, s.bodyEnd), 'We ship on Friday.');
    assert.equal(text.slice(s.headerStart, s.bodyStart - 1), '[#12 · Ada Member · 2026-11-11 10:31]');
    assert.deepEqual([s.messageNo, s.messageVersionId, s.authorId, s.isContext], [12, 'v12', 'u1', false]);
  });

  test('a message late in the UTC day shows the next day in UTC+8', () => {
    const { text } = buildTranscript([msg(1, 'x', { at: new Date(Date.UTC(2026, 10, 11, 17, 5)) })], []);
    assert.ok(text.includes('[#1 · Ada Member · 2026-11-12 01:05]'));
  });

  test('new-messages line precedes the first new message', () => {
    const { text, spans } = buildTranscript([msg(3, 'new one'), msg(4, 'new two')], [msg(1, 'old one'), msg(2, 'old two')]);
    const at = text.indexOf(NEW_MESSAGES_LINE);
    assert.ok(at > text.indexOf('old two'));
    assert.ok(at < text.indexOf('new one'));
    assert.equal(text.indexOf(NEW_MESSAGES_LINE, at + 1), -1, 'the line appears once');
    assert.deepEqual(spans.map((s) => [s.messageNo, s.isContext]), [[1, true], [2, true], [3, false], [4, false]]);
    for (const s of spans) assert.ok(text.slice(s.headerStart, s.bodyEnd).startsWith(`[#${s.messageNo} `));
  });

  test('with no earlier messages the line still comes first', () => {
    const { text } = buildTranscript([msg(1, 'only')], []);
    assert.ok(text.startsWith(NEW_MESSAGES_LINE + '\n\n[#1 '));
  });

  test('context is trimmed oldest first to the limit', () => {
    const earlier = [1, 2, 3, 4].map((n) => msg(n, `body ${n} ${'x'.repeat(50)}`));
    const oneBlock = `[#1 · Ada Member · 2026-11-11 10:31]\nbody 1 ${'x'.repeat(50)}`.length;
    const { spans } = buildTranscript([msg(5, 'new')], earlier, oneBlock * 2 + 1);
    assert.deepEqual(spans.filter((s) => s.isContext).map((s) => s.messageNo), [3, 4], 'the newest earlier messages are kept');
    assert.deepEqual(buildTranscript([msg(5, 'new')], earlier, 0).spans.map((s) => s.messageNo), [5]);
  });
});

describe('placeItem', () => {
  const build = () => buildTranscript([msg(3, 'We decided to ship on Friday.'), msg(4, 'Ali will email Sam.')], [msg(1, 'Earlier we agreed the budget.'), msg(2, 'Ali will email Sam.')]);

  test('placeItem: quote in a new body is new', () => {
    const { text, spans } = build();
    const p = placeItem('ship on Friday', text, spans);
    assert.equal(p.kind, 'new');
    if (p.kind === 'new') {
      assert.equal(text.slice(p.start, p.end), 'ship on Friday');
      assert.equal(p.matches, 1);
    }
  });

  test('a quote in both context and a new body is new, at the new place', () => {
    const { text, spans } = build();
    const p = placeItem('Ali will email Sam.', text, spans);
    assert.equal(p.kind, 'new');
    if (p.kind === 'new') {
      assert.equal(p.matches, 2);
      const newSpan = spans.find((s) => s.messageNo === 4)!;
      assert.ok(p.start >= newSpan.bodyStart && p.end <= newSpan.bodyEnd);
    }
  });

  test('quote only in context is context_only', () => {
    const { text, spans } = build();
    assert.deepEqual(placeItem('agreed the budget', text, spans), { kind: 'context_only' });
  });

  test('quote crossing two messages is unlocated', () => {
    const { text, spans } = build();
    const a = spans.find((s) => s.messageNo === 3)!;
    const b = spans.find((s) => s.messageNo === 4)!;
    const crossing = text.slice(a.bodyEnd - 7, b.bodyStart + 10);
    assert.deepEqual(placeItem(crossing, text, spans), { kind: 'unlocated' });
  });

  test('quote matching a header is unlocated', () => {
    const { text, spans } = build();
    assert.deepEqual(placeItem('[#3 · Ada Member · 2026-11-11 10:31]', text, spans), { kind: 'unlocated' });
    assert.deepEqual(placeItem('Ada Member', text, spans), { kind: 'unlocated' });
  });

  test('a quote that is not there is unlocated', () => {
    const { text, spans } = build();
    assert.deepEqual(placeItem('never said', text, spans), { kind: 'unlocated' });
  });
});
